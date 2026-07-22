import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app";
import type { AppManager } from "./app-management";
import { AttentionManager } from "./attention";
import { hashToken } from "./auth";
import { CodexBridge } from "./codex/bridge";
import type { ServerNotification } from "./codex/generated/index";
import type { Thread, Turn } from "./codex/generated/v2/index";
import { RpcError } from "./codex/transport";
import type { CodexManager } from "./codex-management";
import { loadConfig } from "./config";
import { AppProjection } from "./projection";
import { PushNotifier } from "./push";
import { StateStore } from "./state/store";
import { TranscriptionError } from "./transcription";

const directories: string[] = [];
afterEach(async () =>
  Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  ),
);

describe("HTTP authentication", () => {
  it("keeps health public and rejects missing, query, and bad tokens", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-api-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.auth.tokenSha256 = hashToken("correct");
    });
    const bridge = new CodexBridge({
      codexBin: "codex",
      checkVersion: async () => "0.145.0",
      spawnProcess: () => {
        throw new Error("not started");
      },
    });
    await bridge.start();
    bridge.stop();
    const attention = new AttentionManager();
    const push = new PushNotifier(store);
    const projection = new AppProjection(bridge, store, attention, false);
    const config = loadConfig({
      statePath: store.path,
      clientDist: join(directory, "missing"),
      allowedOrigins: new Set(["http://localhost"]),
      websocketAuthTimeoutMs: 25,
    });
    const app = await buildApp(config, {
      bridge,
      store,
      projection,
      attention,
      push,
      projectRoot: directory,
    });

    const health = await app.inject({ url: "/api/v1/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      status: "degraded",
      appServer: {
        state: "unavailable",
        installedVersion: "0.145.0",
        message: "Codex app-server is unavailable",
      },
    });
    expect(health.json().appServer).not.toHaveProperty("expectedVersion");
    expect((await app.inject({ url: "/api/v1/summary" })).json()).toMatchObject({
      error: { code: "unauthorized" },
    });
    expect((await app.inject({ url: "/api/v1/settings/codex" })).json()).toMatchObject({
      error: { code: "unauthorized" },
    });
    expect((await app.inject({ url: "/api/v1/summary?token=correct" })).json()).toMatchObject({
      error: { code: "validation_failed" },
    });
    expect(
      (await app.inject({ url: "/api/v1/summary", headers: { authorization: "Bearer wrong" } }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({ url: "/api/v1/summary", headers: { authorization: "Bearer correct" } })
      ).json(),
    ).toMatchObject({ threadCount: 0 });
    expect(
      (
        await app.inject({
          url: "/api/v1/summary",
          headers: { origin: "https://evil.example", authorization: "Bearer correct" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: "/api/v1/summary",
          headers: {
            host: "codexnest.home:4310",
            origin: "http://codexnest.home:4310",
            authorization: "Bearer correct",
          },
        })
      ).statusCode,
    ).toBe(200);

    const authorization = { authorization: "Bearer correct" };
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    const listing = await app.inject({ url: "/api/v1/directories", headers: authorization });
    expect(listing.statusCode).toBe(200);
    expect(listing.json()).toMatchObject({
      rootPath: directory,
      path: directory,
      parentPath: null,
      directories: [{ name: "workspace", path: workspace }],
    });

    const createdDirectory = await app.inject({
      method: "POST",
      url: "/api/v1/directories",
      headers: authorization,
      payload: { parentPath: workspace, name: "new-project" },
    });
    expect(createdDirectory.statusCode).toBe(201);
    const createdPath = join(workspace, "new-project");
    expect(createdDirectory.json()).toEqual({
      rootPath: directory,
      path: createdPath,
      parentPath: workspace,
      directories: [],
    });
    const duplicateDirectory = await app.inject({
      method: "POST",
      url: "/api/v1/directories",
      headers: authorization,
      payload: { parentPath: workspace, name: "new-project" },
    });
    expect(duplicateDirectory.statusCode).toBe(409);
    expect(duplicateDirectory.json()).toMatchObject({ error: { code: "conflict" } });

    const createdProject = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: authorization,
      payload: { path: createdPath },
    });
    expect(createdProject.statusCode).toBe(201);
    expect(createdProject.json()).toMatchObject({
      displayName: "new-project",
      path: await realpath(createdPath),
    });

    const legacyPath = join(workspace, "legacy-project");
    await mkdir(legacyPath);
    const legacyProject = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: authorization,
      payload: { path: legacyPath, displayName: "Ignored manual name" },
    });
    expect(legacyProject.statusCode).toBe(201);
    expect(legacyProject.json()).toMatchObject({ displayName: "legacy-project" });

    const reorderedEvent = new Promise<Record<string, unknown>>((resolve) => {
      const listener = (_sequence: number, event: Record<string, unknown>) => {
        if (event.type !== "projects.reordered") return;
        projection.off("event", listener);
        resolve(event);
      };
      projection.on("event", listener);
    });
    const movedProject = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${legacyProject.json().id as string}/move`,
      headers: authorization,
      payload: { direction: "up" },
    });
    expect(movedProject.statusCode).toBe(200);
    expect(
      movedProject.json().map((project: { displayName: string }) => project.displayName),
    ).toEqual(["legacy-project", "new-project"]);
    await expect(reorderedEvent).resolves.toMatchObject({
      type: "projects.reordered",
      projects: [{ displayName: "legacy-project" }, { displayName: "new-project" }],
    });
    expect(store.snapshot().projects.map((project) => project.displayName)).toEqual([
      "legacy-project",
      "new-project",
    ]);

    const boundaryMove = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${createdProject.json().id as string}/move`,
      headers: authorization,
      payload: { direction: "down" },
    });
    expect(boundaryMove.statusCode).toBe(200);
    expect(boundaryMove.json().map((project: { id: string }) => project.id)).toEqual(
      store.snapshot().projects.map((project) => project.id),
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/projects/missing/move",
          headers: authorization,
          payload: { direction: "up" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/projects/${createdProject.json().id as string}/move`,
          headers: authorization,
          payload: { direction: "sideways" },
        })
      ).statusCode,
    ).toBe(400);

    const outside = await app.inject({
      url: `/api/v1/directories?path=${encodeURIComponent(join(directory, ".."))}`,
      headers: authorization,
    });
    expect(outside.statusCode).toBe(400);
    expect(outside.json()).toMatchObject({ error: { code: "validation_failed" } });

    const missing = await app.inject({
      url: `/api/v1/directories?path=${encodeURIComponent(join(directory, "missing"))}`,
      headers: authorization,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: "not_found" } });

    const locked = join(directory, "locked");
    await mkdir(locked);
    await chmod(locked, 0o000);
    try {
      const forbidden = await app.inject({
        url: `/api/v1/directories?path=${encodeURIComponent(locked)}`,
        headers: authorization,
      });
      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.json()).toMatchObject({ error: { code: "forbidden" } });
    } finally {
      await chmod(locked, 0o700);
    }

    await app.ready();
    const authorized = await app.injectWS("/api/v1/events", {
      headers: { origin: "http://localhost" },
    });
    const snapshot = new Promise<Record<string, unknown>>((resolve) => {
      authorized.once("message", (data) =>
        resolve(JSON.parse(data.toString()) as Record<string, unknown>),
      );
    });
    authorized.send(JSON.stringify({ type: "authenticate", token: "correct" }));
    await expect(snapshot).resolves.toMatchObject({ type: "snapshot" });

    const secondAuthorized = await app.injectWS("/api/v1/events", {
      headers: { origin: "http://localhost" },
    });
    const secondSnapshot = new Promise<Record<string, unknown>>((resolve) => {
      secondAuthorized.once("message", (data) =>
        resolve(JSON.parse(data.toString()) as Record<string, unknown>),
      );
    });
    secondAuthorized.send(JSON.stringify({ type: "authenticate", token: "correct" }));
    await expect(secondSnapshot).resolves.toMatchObject({ type: "snapshot" });

    const firstEvent = new Promise<Record<string, unknown>>((resolve) => {
      authorized.once("message", (data) =>
        resolve(JSON.parse(data.toString()) as Record<string, unknown>),
      );
    });
    const secondEvent = new Promise<Record<string, unknown>>((resolve) => {
      secondAuthorized.once("message", (data) =>
        resolve(JSON.parse(data.toString()) as Record<string, unknown>),
      );
    });
    projection.upsertThread(testThread("broadcast"));
    const [firstBroadcast, secondBroadcast] = await Promise.all([firstEvent, secondEvent]);
    expect(firstBroadcast).toMatchObject({
      type: "event",
      event: { type: "thread.upserted" },
    });
    expect(secondBroadcast).toEqual(firstBroadcast);
    authorized.terminate();
    secondAuthorized.terminate();

    const unauthorized = await app.injectWS("/api/v1/events", {
      headers: { origin: "http://localhost" },
    });
    let unauthorizedMessages = 0;
    unauthorized.on("message", () => {
      unauthorizedMessages += 1;
    });
    const closed = new Promise<number>((resolve) => unauthorized.once("close", resolve));
    unauthorized.send(JSON.stringify({ type: "authenticate", token: "wrong" }));
    await expect(closed).resolves.toBe(1008);
    expect(unauthorizedMessages).toBe(0);

    await expect(
      app.injectWS("/api/v1/events?token=correct", { headers: { origin: "http://localhost" } }),
    ).rejects.toThrow("400");

    const idle = await app.injectWS("/api/v1/events", { headers: { origin: "http://localhost" } });
    const idleClosed = new Promise<number>((resolve) => idle.once("close", resolve));
    await expect(idleClosed).resolves.toBe(1008);

    await expect(
      app.injectWS("/api/v1/events", { headers: { origin: "https://evil.example" } }),
    ).rejects.toThrow();

    const lanOrigin = await app.injectWS("/api/v1/events", {
      headers: { host: "codexnest.home:4310", origin: "http://codexnest.home:4310" },
    });
    const lanSnapshot = new Promise<Record<string, unknown>>((resolve) => {
      lanOrigin.once("message", (data) =>
        resolve(JSON.parse(data.toString()) as Record<string, unknown>),
      );
    });
    lanOrigin.send(JSON.stringify({ type: "authenticate", token: "correct" }));
    await expect(lanSnapshot).resolves.toMatchObject({ type: "snapshot" });
    lanOrigin.terminate();

    const revocable = await app.injectWS("/api/v1/events", {
      headers: { origin: "http://localhost" },
    });
    const revocableSnapshot = new Promise<void>((resolve) =>
      revocable.once("message", () => resolve()),
    );
    revocable.send(JSON.stringify({ type: "authenticate", token: "correct" }));
    await revocableSnapshot;
    const revoked = new Promise<number>((resolve) => revocable.once("close", resolve));
    await store.update((state) => {
      state.auth.tokenSha256 = hashToken("rotated");
    });
    await expect(revoked).resolves.toBe(1008);
    await app.close();
  });
});

describe("audio transcriptions", () => {
  it("keeps config and audio uploads authenticated and maps provider failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-transcription-api-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.auth.tokenSha256 = hashToken("correct");
    });
    const bridge = new SettingsBridge();
    const attention = new AttentionManager();
    const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention, false);
    await projection.sync();
    const transcription = {
      configuration: vi.fn(() => ({
        providers: ["local" as const, "openai" as const],
        provider: "local" as const,
        localUrl: "http://127.0.0.1:8178/inference",
        openAiApiKeyConfigured: true,
        openAiModel: "gpt-4o-transcribe",
        language: "ru",
        refineLocal: true,
        refinementModel: "gpt-5.6-luna",
        maxRecordingSeconds: 300,
        maxUploadBytes: 24 * 1024 * 1024,
      })),
      updateConfiguration: vi.fn(async () => ({
        providers: ["local" as const, "openai" as const],
        provider: "openai" as const,
        localUrl: "http://127.0.0.1:8178/inference",
        openAiApiKeyConfigured: true,
        openAiModel: "gpt-4o-mini-transcribe",
        language: "ru",
        refineLocal: false,
        refinementModel: "gpt-5.6-luna",
        maxRecordingSeconds: 300,
        maxUploadBytes: 24 * 1024 * 1024,
      })),
      transcribe: vi.fn(async () => "распознанный текст"),
    };
    const app = await buildApp(
      loadConfig({
        statePath: store.path,
        clientDist: join(directory, "missing"),
        allowedOrigins: new Set(["http://localhost"]),
      }),
      {
        bridge: bridge as unknown as CodexBridge,
        store,
        projection,
        attention,
        push: new PushNotifier(store),
        transcription,
      },
    );
    const authorization = { authorization: "Bearer correct" };

    expect((await app.inject({ url: "/api/v1/transcriptions/config" })).statusCode).toBe(401);
    expect(
      (await app.inject({ url: "/api/v1/transcriptions/config", headers: authorization })).json(),
    ).toEqual(transcription.configuration());

    const transcribed = await app.inject({
      method: "POST",
      url: "/api/v1/transcriptions",
      headers: { ...authorization, "content-type": "audio/webm;codecs=opus" },
      payload: Buffer.from("audio"),
    });
    expect(transcribed.statusCode).toBe(200);
    expect(transcribed.json()).toEqual({ text: "распознанный текст" });
    expect(transcription.transcribe).toHaveBeenCalledWith(
      Buffer.from("audio"),
      "audio/webm;codecs=opus",
    );

    const updated = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/transcription",
      headers: { ...authorization, "content-type": "application/json" },
      payload: {
        provider: "openai",
        localUrl: "http://127.0.0.1:8178/inference",
        openAiApiKey: "new-secret",
        openAiModel: "gpt-4o-mini-transcribe",
        language: "ru",
        refineLocal: false,
        refinementModel: "gpt-5.6-luna",
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).not.toHaveProperty("openAiApiKey");
    expect(transcription.updateConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", openAiApiKey: "new-secret" }),
    );

    const insecureKeyUpdate = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/transcription",
      remoteAddress: "192.168.2.99",
      headers: { ...authorization, "content-type": "application/json" },
      payload: {
        provider: "local",
        localUrl: "http://127.0.0.1:8178/inference",
        openAiApiKey: "must-not-be-accepted",
        openAiModel: "gpt-4o-transcribe",
        language: "ru",
        refineLocal: true,
        refinementModel: "gpt-5.6-luna",
      },
    });
    expect(insecureKeyUpdate.statusCode).toBe(400);
    expect(transcription.updateConfiguration).toHaveBeenCalledTimes(1);

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/transcriptions",
          headers: { ...authorization, "content-type": "audio/mpeg" },
          payload: Buffer.from("audio"),
        })
      ).statusCode,
    ).toBe(400);

    transcription.transcribe.mockRejectedValueOnce(
      new TranscriptionError("unavailable", "Local transcription is not configured"),
    );
    const unavailable = await app.inject({
      method: "POST",
      url: "/api/v1/transcriptions",
      headers: { ...authorization, "content-type": "audio/mp4" },
      payload: Buffer.from("audio"),
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({
      error: { code: "transcription_unavailable" },
    });

    await app.close();
  });
});

describe("file downloads", () => {
  it("issues short-lived tickets and confines downloads to the task directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-download-api-test-"));
    directories.push(directory);
    const taskRoot = join(directory, "task");
    const nested = join(taskRoot, "build", "app-debug.apk");
    const outside = join(directory, "outside.bin");
    const locked = join(taskRoot, "locked.bin");
    const escapedLink = join(taskRoot, "escaped.bin");
    const swappable = join(taskRoot, "swappable.bin");
    await mkdir(join(taskRoot, "build"), { recursive: true });
    await Promise.all([
      writeFile(nested, Buffer.from([0, 1, 2, 255])),
      writeFile(outside, "outside"),
      writeFile(locked, "locked"),
      writeFile(swappable, "original"),
    ]);
    await symlink(outside, escapedLink);

    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.auth.tokenSha256 = hashToken("correct");
    });
    const bridge = new SettingsBridge();
    const attention = new AttentionManager();
    const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention, false);
    await projection.sync();
    projection.upsertThread({ ...testThread("download"), cwd: taskRoot });
    const app = await buildApp(
      loadConfig({
        statePath: store.path,
        clientDist: join(directory, "missing"),
        allowedOrigins: new Set(["http://localhost"]),
      }),
      {
        bridge: bridge as unknown as CodexBridge,
        store,
        projection,
        attention,
        push: new PushNotifier(store),
        projectRoot: directory,
      },
    );
    const headers = { authorization: "Bearer correct" };
    const issue = (path: string, requestHeaders: Record<string, string> = headers) =>
      app.inject({
        method: "POST",
        url: "/api/v1/threads/download/downloads",
        headers: requestHeaders,
        payload: { path },
      });

    expect((await issue(nested, {})).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/threads/missing/downloads",
          headers,
          payload: { path: nested },
        })
      ).statusCode,
    ).toBe(404);
    expect((await issue(outside)).statusCode).toBe(403);
    expect((await issue(escapedLink)).statusCode).toBe(403);
    expect((await issue(taskRoot)).statusCode).toBe(400);
    expect((await issue(join(taskRoot, "missing.bin"))).statusCode).toBe(404);

    await chmod(locked, 0o000);
    try {
      expect((await issue(locked)).statusCode).toBe(403);
    } finally {
      await chmod(locked, 0o600);
    }

    const issued = await issue(nested);
    expect(issued.statusCode).toBe(201);
    expect(issued.json()).toMatchObject({
      downloadUrl: expect.stringMatching(/^\/downloads\/[A-Za-z0-9_-]+\/app-debug\.apk$/),
      expiresAt: expect.any(Number),
    });
    expect(issued.json().downloadUrl).not.toContain("correct");
    expect(issued.json().downloadUrl).not.toContain(taskRoot);

    const downloaded = await app.inject({ url: issued.json().downloadUrl });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.rawPayload).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(downloaded.headers["content-type"]).toBe("application/octet-stream");
    expect(downloaded.headers["cache-control"]).toBe("private, no-store");
    expect(downloaded.headers["content-disposition"]).toContain("attachment");
    expect(downloaded.headers["content-disposition"]).toContain("app-debug.apk");
    expect((await app.inject({ url: issued.json().downloadUrl })).statusCode).toBe(404);

    const changedName = await issue(nested);
    const tamperedUrl = String(changedName.json().downloadUrl).replace(
      /app-debug\.apk$/,
      "renamed.apk",
    );
    expect((await app.inject({ url: tamperedUrl })).statusCode).toBe(404);
    expect((await app.inject({ url: changedName.json().downloadUrl })).statusCode).toBe(404);

    const swapped = await issue(swappable);
    await unlink(swappable);
    await symlink(outside, swappable);
    expect((await app.inject({ url: swapped.json().downloadUrl })).statusCode).toBe(404);

    const dateNow = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const expiring = await issue(nested);
      expect(expiring.json().expiresAt).toBe(61_000);
      dateNow.mockReturnValue(61_001);
      expect((await app.inject({ url: expiring.json().downloadUrl })).statusCode).toBe(404);
    } finally {
      dateNow.mockRestore();
    }

    await app.close();
  });
});

describe("thread settings", () => {
  it("persists settings on the server and maps plan mode into turn/start", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-settings-api-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.auth.tokenSha256 = hashToken("correct");
      state.projects.push({
        id: "project",
        displayName: "Project",
        path: "/work",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      });
    });
    const bridge = new SettingsBridge();
    const attention = new AttentionManager();
    const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention, false);
    await projection.sync();
    const activityEvents: Array<Record<string, unknown>> = [];
    projection.on("event", (_sequence, event) => {
      if (event.type === "activity.upserted") activityEvents.push(event);
    });
    const threadTitles = {
      generate: vi.fn(async (input: string) =>
        input === "Первое сообщение" ? "Первая задача" : "Начать работу",
      ),
    };
    const config = loadConfig({
      statePath: store.path,
      clientDist: join(directory, "missing"),
      allowedOrigins: new Set(["http://localhost"]),
      websocketAuthTimeoutMs: 25,
    });
    const app = await buildApp(config, {
      bridge: bridge as unknown as CodexBridge,
      store,
      projection,
      attention,
      push: new PushNotifier(store),
      threadTitles,
      projectRoot: directory,
    });
    const headers = { authorization: "Bearer correct" };

    const missingGitChanges = await app.inject({
      url: "/api/v1/threads/missing/git-changes",
      headers,
    });
    expect(missingGitChanges.statusCode).toBe(404);
    expect(missingGitChanges.json()).toMatchObject({ error: { code: "not_found" } });
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/api/v1/threads/missing",
          headers,
        })
      ).statusCode,
    ).toBe(404);

    const turnsBeforeEmptyThread = bridge.request.mock.calls.filter(
      ([method]) => method === "turn/start",
    ).length;
    const emptyCreated = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project/threads",
      headers,
    });
    expect(emptyCreated.statusCode).toBe(201);
    expect(emptyCreated.json().thread.settings).toEqual({ collaborationMode: "default" });
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/start").at(-1)?.[1],
    ).toEqual({ cwd: "/work" });
    expect(bridge.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(
      turnsBeforeEmptyThread,
    );
    const emptyDetail = await app.inject({
      url: "/api/v1/threads/created",
      headers,
    });
    expect(emptyDetail.statusCode).toBe(200);
    expect(emptyDetail.json().turns).toEqual([]);
    const resumesBeforeFirstTurn = bridge.request.mock.calls.filter(
      ([method]) => method === "thread/resume",
    ).length;
    const firstTurn = await app.inject({
      method: "POST",
      url: "/api/v1/threads/created/turns",
      headers,
      payload: { input: "Первое сообщение" },
    });
    expect(firstTurn.statusCode).toBe(201);
    expect(bridge.request.mock.calls.filter(([method]) => method === "thread/resume")).toHaveLength(
      resumesBeforeFirstTurn,
    );
    await vi.waitFor(() =>
      expect(threadTitles.generate).toHaveBeenCalledWith("Первое сообщение", {
        cwd: "/work",
        model: "gpt-a",
        effort: "high",
      }),
    );
    expect(bridge.request).toHaveBeenCalledWith("thread/name/set", {
      threadId: "created",
      name: "Первая задача",
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/threads",
      headers,
      payload: { projectId: "project", input: "Начни работу" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().thread.settings).toEqual({
      collaborationMode: "default",
    });
    await vi.waitFor(() =>
      expect(threadTitles.generate).toHaveBeenCalledWith("Начни работу", {
        cwd: "/work",
        model: "gpt-a",
        effort: "high",
      }),
    );
    const threadStartCall = bridge.request.mock.calls
      .filter(([method]) => method === "thread/start")
      .at(-1);
    expect(threadStartCall?.[1]).not.toHaveProperty("sandbox");
    expect(threadStartCall?.[1]).not.toHaveProperty("approvalPolicy");
    expect(threadStartCall?.[1]).not.toHaveProperty("approvalsReviewer");

    await projection.setSettings("thread", {
      collaborationMode: "default",
      model: "gpt-a",
      reasoningEffort: "high",
      serviceTier: "fast",
      personality: "friendly",
    });

    const preferredEffort = await app.inject({
      method: "PATCH",
      url: "/api/v1/threads/thread/settings",
      headers,
      payload: { reasoningEffort: "high" },
    });
    expect(preferredEffort.statusCode).toBe(200);
    expect(store.snapshot().defaultReasoningEffort).toBe("high");

    const inherited = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project/threads",
      headers,
    });
    expect(inherited.statusCode).toBe(201);
    expect(inherited.json().thread.settings).toEqual({
      collaborationMode: "default",
      reasoningEffort: "high",
    });

    const resetPreference = await app.inject({
      method: "POST",
      url: "/api/v1/threads",
      headers,
      payload: {
        projectId: "project",
        input: "Верни стандартные рассуждения",
        settings: { collaborationMode: "default", reasoningEffort: null },
      },
    });
    expect(resetPreference.statusCode).toBe(201);
    expect(resetPreference.json().thread.settings).toEqual({ collaborationMode: "default" });
    expect(store.snapshot().defaultReasoningEffort).toBeUndefined();

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/v1/threads/thread/settings",
      headers,
      payload: { model: "gpt-b", collaborationMode: "plan" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().settings).toEqual({
      collaborationMode: "plan",
      model: "gpt-b",
      reasoningEffort: "low",
    });
    expect(store.snapshot().threadMeta.thread?.settings).toEqual(updated.json().settings);

    const clientOverride = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/turns",
      headers,
      payload: {
        input: "Не используй это",
        settings: { collaborationMode: "default", model: "gpt-a" },
      },
    });
    expect(clientOverride.statusCode).toBe(400);

    const started = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/turns",
      headers,
      payload: { input: "Составь план", clientMessageId: "client-started" },
    });
    expect(started.statusCode).toBe(201);
    const resumeCall = bridge.request.mock.calls
      .filter(([method]) => method === "thread/resume")
      .at(-1);
    expect(resumeCall?.[1]).not.toHaveProperty("sandbox");
    expect(resumeCall?.[1]).not.toHaveProperty("approvalPolicy");
    expect(resumeCall?.[1]).not.toHaveProperty("approvalsReviewer");
    const startCall = bridge.request.mock.calls
      .filter(([method]) => method === "turn/start")
      .at(-1);
    expect(startCall?.[1]).toMatchObject({
      threadId: "thread",
      clientUserMessageId: "client-started",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-b",
          reasoning_effort: "low",
          developer_instructions: null,
        },
      },
    });
    expect(startCall?.[1]).not.toHaveProperty("approvalPolicy");
    expect(startCall?.[1]).not.toHaveProperty("approvalsReviewer");
    expect(activityEvents.at(-1)).toMatchObject({
      threadId: "thread",
      turnId: "turn",
      item: { type: "userMessage", id: "client-started", text: "Составь план" },
    });

    const queued = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/queue",
      headers,
      payload: { input: "Поставь в очередь", clientMessageId: "client-queued" },
    });
    expect(queued.statusCode).toBe(202);
    expect(store.snapshot().messageQueues?.thread).toEqual([
      expect.objectContaining({
        id: "client-queued",
        text: "Поставь в очередь",
        status: "queued",
      }),
    ]);
    const sentNow = await app.inject({
      method: "POST",
      url: `/api/v1/threads/thread/queue/${queued.json().id}/send`,
      headers,
    });
    expect(sentNow.statusCode).toBe(200);
    expect(queued.json().id).toBe("client-queued");
    expect(store.snapshot().messageQueues?.thread).toBeUndefined();
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "turn/steer").at(-1)?.[1],
    ).toMatchObject({
      clientUserMessageId: queued.json().id,
      input: [{ type: "text", text: "Поставь в очередь", text_elements: [] }],
    });
    expect(activityEvents.at(-1)).toMatchObject({
      threadId: "thread",
      turnId: "steered",
      item: { type: "userMessage", id: "client-queued", text: "Поставь в очередь" },
    });

    const invalid = await app.inject({
      method: "PATCH",
      url: "/api/v1/threads/thread/settings",
      headers,
      payload: { collaborationMode: "automatic" },
    });
    expect(invalid.statusCode).toBe(400);

    bridge.emit("notification", {
      method: "turn/started",
      params: { threadId: "thread", turn: testTurn("running", "inProgress") },
    } satisfies ServerNotification);
    const steered = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/steer",
      headers,
      payload: { turnId: "running", input: "Продолжай" },
    });
    expect(steered.statusCode).toBe(200);
    expect(steered.json()).toEqual({ turnId: "steered" });
    expect(projection.summary("thread")?.currentTurnId).toBe("steered");
    const conflict = await app.inject({
      method: "PATCH",
      url: "/api/v1/threads/thread/settings",
      headers,
      payload: { collaborationMode: "default" },
    });
    expect(conflict.statusCode).toBe(409);

    const nextQueued = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/queue",
      headers,
      payload: { input: "Следующий ход" },
    });
    expect(nextQueued.statusCode).toBe(202);
    const startsBeforeCompletion = bridge.request.mock.calls.filter(
      ([method]) => method === "turn/start",
    ).length;
    bridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "thread", turn: testTurn("steered", "completed") },
    } satisfies ServerNotification);
    await vi.waitFor(() =>
      expect(bridge.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(
        startsBeforeCompletion + 1,
      ),
    );
    await vi.waitFor(() => expect(store.snapshot().messageQueues?.thread).toBeUndefined());

    const image = `data:image/png;base64,${"a".repeat(1_100_000)}`;
    const imageTurn = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/turns",
      headers,
      payload: { input: "Проверь изображение", images: [image] },
    });
    expect(imageTurn.statusCode).toBe(201);
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "turn/start").at(-1)?.[1],
    ).toMatchObject({
      input: [
        { type: "text", text: "Проверь изображение", text_elements: [] },
        { type: "image", url: image },
      ],
    });

    const defaults = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/task-defaults",
      headers,
      payload: { serviceTier: "fast", personality: "friendly" },
    });
    expect(defaults.statusCode).toBe(200);
    expect(store.snapshot().taskDefaults).toEqual({
      serviceTier: "fast",
      personality: "friendly",
    });
    expect(projection.summary("thread")?.settings).not.toMatchObject({ serviceTier: "fast" });
    const withDefaults = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project/threads",
      headers,
    });
    expect(withDefaults.json().thread.settings).toMatchObject({
      serviceTier: "fast",
      personality: "friendly",
    });

    const goalCallStart = bridge.request.mock.calls.length;
    const goalStart = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/turns",
      headers,
      payload: { input: "Доведи задачу до конца", goal: true },
    });
    expect(goalStart.statusCode).toBe(201);
    expect(
      bridge.request.mock.calls
        .slice(goalCallStart)
        .map(([method, params]) => [
          method,
          method === "thread/goal/set" ? params.status : undefined,
        ]),
    ).toEqual([
      ["thread/goal/set", "paused"],
      ["thread/resume", undefined],
      ["turn/start", undefined],
      ["thread/goal/set", "active"],
    ]);
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "turn/start").at(-1)?.[1],
    ).toMatchObject({ collaborationMode: { mode: "default" } });
    expect(
      (await app.inject({ url: "/api/v1/threads/thread/goal", headers })).json(),
    ).toMatchObject({ objective: "Доведи задачу до конца", status: "active" });
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/v1/threads/thread/goal",
          headers,
          payload: { status: "paused" },
        })
      ).json(),
    ).toMatchObject({ status: "paused" });
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/v1/threads/thread/goal",
          headers,
          payload: { status: "active" },
        })
      ).json(),
    ).toMatchObject({ status: "active" });
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/api/v1/threads/thread/goal",
          headers,
        })
      ).statusCode,
    ).toBe(204);

    bridge.failNextTurnStart = true;
    const activityCountBeforeFailure = activityEvents.length;
    const failedFirstTurn = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/turns",
      headers,
      payload: {
        input: "Эта цель не запустится",
        goal: true,
        clientMessageId: "client-failed",
      },
    });
    expect(failedFirstTurn.statusCode).toBe(500);
    expect(bridge.goal).toBeNull();
    expect(activityEvents).toHaveLength(activityCountBeforeFailure);

    bridge.failNextGoalActivation = true;
    const failedActivation = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/turns",
      headers,
      payload: { input: "Цель останется на паузе", goal: true },
    });
    expect(failedActivation.statusCode).toBe(201);
    expect(failedActivation.json().goalWarning).toMatch(/осталась на паузе/i);
    expect(bridge.goal).toMatchObject({ status: "paused" });

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/v1/threads/thread",
      headers,
    });
    expect(deleted.statusCode).toBe(204);
    expect(bridge.request).toHaveBeenCalledWith("thread/delete", { threadId: "thread" });
    expect(store.snapshot().threadMeta.thread).toBeUndefined();
    await app.close();
  });

  it("reads and atomically updates global Codex permission presets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-permissions-api-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.auth.tokenSha256 = hashToken("correct");
    });
    const bridge = new SettingsBridge();
    const { codexManager, codexStatus } = createCodexManagerMock();
    const { appManager, appStatus } = createAppManagerMock();
    const attention = new AttentionManager();
    const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention, false);
    await projection.sync();
    const app = await buildApp(
      loadConfig({
        statePath: store.path,
        clientDist: join(directory, "missing"),
        allowedOrigins: new Set(["http://localhost"]),
        websocketAuthTimeoutMs: 25,
      }),
      {
        bridge: bridge as unknown as CodexBridge,
        store,
        projection,
        attention,
        push: new PushNotifier(store),
        codexManager,
        appManager,
        projectRoot: directory,
      },
    );
    const headers = { authorization: "Bearer correct" };

    const read = await app.inject({ url: "/api/v1/settings/permissions", headers });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({
      preset: "auto",
      version: "version-1",
      overridden: false,
      message: null,
    });

    expect(
      bridge.request.mock.calls.filter(([method]) => method === "account/rateLimits/read"),
    ).toHaveLength(0);
    const rateLimits = await app.inject({ url: "/api/v1/codex/rate-limits", headers });
    expect(rateLimits.statusCode).toBe(200);
    expect(rateLimits.json()).toEqual({
      primary: { usedPercent: 25, windowDurationMins: 300 },
      secondary: { usedPercent: 40, windowDurationMins: 10_080 },
    });
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "account/rateLimits/read"),
    ).toEqual([["account/rateLimits/read", undefined]]);

    const management = await app.inject({ url: "/api/v1/settings/codex", headers });
    expect(management.statusCode).toBe(200);
    expect(management.json()).toEqual(codexStatus);
    expect(JSON.stringify(management.json())).not.toContain("secret");

    const appManagement = await app.inject({ url: "/api/v1/settings/app", headers });
    expect(appManagement.statusCode).toBe(200);
    expect(appManagement.json()).toEqual(appStatus);
    const checkedApp = await app.inject({
      method: "POST",
      url: "/api/v1/settings/app/check",
      headers,
    });
    expect(checkedApp.json()).toMatchObject({ latestVersion: "0.2.0", updateAvailable: true });
    const queuedApp = await app.inject({
      method: "POST",
      url: "/api/v1/settings/app/update",
      headers,
    });
    expect(queuedApp.json()).toMatchObject({ operation: "preparing" });
    expect(appManager.check).toHaveBeenCalledOnce();
    expect(appManager.update).toHaveBeenCalledOnce();

    const appliedProxy = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/codex/proxy",
      headers,
      payload: { proxy: "proxy.example:8000:user:secret" },
    });
    expect(appliedProxy.statusCode).toBe(200);
    expect(codexManager.applyProxy).toHaveBeenCalledWith("proxy.example:8000:user:secret");
    expect(JSON.stringify(appliedProxy.json())).not.toContain("secret");

    const updated = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/permissions",
      headers,
      payload: { preset: "full-access", expectedVersion: "version-1" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ preset: "full-access", version: "version-2" });
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "config/batchWrite").at(-1)?.[1],
    ).toEqual({
      edits: [
        { keyPath: "sandbox_mode", value: "danger-full-access", mergeStrategy: "replace" },
        { keyPath: "approval_policy", value: "never", mergeStrategy: "replace" },
        { keyPath: "approvals_reviewer", value: "user", mergeStrategy: "replace" },
      ],
      expectedVersion: "version-1",
      reloadUserConfig: true,
    });

    bridge.permissionConfig = {
      sandbox_mode: "read-only",
      approval_policy: "never",
      approvals_reviewer: "user",
    };
    expect(
      (await app.inject({ url: "/api/v1/settings/permissions", headers })).json().preset,
    ).toBeNull();

    bridge.writeStatus = "okOverridden";
    bridge.writeMessage = "Managed by policy";
    const overridden = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/permissions",
      headers,
      payload: { preset: "ask", expectedVersion: "version-2" },
    });
    expect(overridden.json()).toMatchObject({
      preset: "ask",
      overridden: true,
      message: "Managed by policy",
    });

    const invalid = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/permissions",
      headers,
      payload: { preset: "unsafe" },
    });
    expect(invalid.statusCode).toBe(400);

    bridge.conflictingVersion = "stale";
    const conflict = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/permissions",
      headers,
      payload: { preset: "auto", expectedVersion: "stale" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: "conflict" } });

    await app.close();
  });
});

function createCodexManagerMock() {
  const codexStatus = {
    supported: true,
    unavailableReason: null,
    operation: "idle" as const,
    activeTurnCount: 0,
    daemonStatus: "running",
    cliVersion: "0.144.6",
    appServerVersion: "0.144.6",
    latestVersion: null,
    updateAvailable: null,
    networkStatus: "unknown" as const,
    networkMessage: null,
    proxy: {
      configured: true,
      protocol: "http" as const,
      host: "proxy.example",
      port: 8000,
      username: "user",
      hasPassword: true,
      error: null,
    },
  };
  const codexManager = {
    maintenanceActive: false,
    assertTurnsAllowed: vi.fn(),
    status: vi.fn(async () => codexStatus),
    check: vi.fn(async () => ({
      ...codexStatus,
      latestVersion: "0.145.0",
      updateAvailable: true,
      networkStatus: "ok" as const,
    })),
    applyProxy: vi.fn(async () => codexStatus),
    update: vi.fn(async () => codexStatus),
    restart: vi.fn(async () => codexStatus),
  } as unknown as CodexManager;
  return { codexManager, codexStatus };
}

function createAppManagerMock() {
  const appStatus = {
    supported: true,
    currentVersion: "0.1.0",
    latestVersion: null,
    updateAvailable: null,
    operation: "idle" as const,
    result: "none" as const,
    message: null,
    checkedAt: null,
    updatedAt: null,
  };
  const appManager = {
    status: vi.fn(async () => appStatus),
    check: vi.fn(async () => ({
      ...appStatus,
      latestVersion: "0.2.0",
      updateAvailable: true,
    })),
    update: vi.fn(async () => ({ ...appStatus, operation: "preparing" as const })),
  } as unknown as AppManager;
  return { appManager, appStatus };
}

class SettingsBridge extends EventEmitter {
  state = "ready" as const;
  actualVersion = "0.144.6";
  permissionConfig: Record<string, unknown> = {
    sandbox_mode: "workspace-write",
    approval_policy: "on-request",
    approvals_reviewer: "auto_review",
  };
  configVersion = 1;
  writeStatus: "ok" | "okOverridden" = "ok";
  writeMessage: string | null = null;
  conflictingVersion: string | null = null;
  goal: {
    threadId: string;
    objective: string;
    status: "active" | "paused";
    tokenBudget: null;
    tokensUsed: number;
    timeUsedSeconds: number;
    createdAt: number;
    updatedAt: number;
  } | null = null;
  failNextTurnStart = false;
  failNextGoalActivation = false;
  request = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === "thread/list") {
      return params.archived
        ? { data: [], nextCursor: null, backwardsCursor: null }
        : { data: [testThread()], nextCursor: null, backwardsCursor: null };
    }
    if (method === "model/list") {
      return {
        data: [
          testModel("gpt-a", "high", true, [{ id: "fast", name: "Fast" }]),
          testModel("gpt-b", "low", false, []),
        ],
        nextCursor: null,
      };
    }
    if (method === "thread/start") return { thread: testThread("created") };
    if (method === "thread/resume") return {};
    if (method === "thread/name/set") return {};
    if (method === "thread/delete") return {};
    if (method === "turn/start") {
      if (this.failNextTurnStart) {
        this.failNextTurnStart = false;
        throw new Error("turn failed");
      }
      return { turn: testTurn("turn", "inProgress") };
    }
    if (method === "turn/steer") return { turnId: "steered" };
    if (method === "thread/goal/get") return { goal: this.goal };
    if (method === "thread/goal/clear") {
      this.goal = null;
      return { cleared: true };
    }
    if (method === "thread/goal/set") {
      if (params.status === "active" && this.failNextGoalActivation) {
        this.failNextGoalActivation = false;
        throw new Error("activation failed");
      }
      this.goal = {
        threadId: String(params.threadId),
        objective:
          typeof params.objective === "string" ? params.objective : (this.goal?.objective ?? ""),
        status: params.status === "active" ? "active" : "paused",
        tokenBudget: null,
        tokensUsed: this.goal?.tokensUsed ?? 0,
        timeUsedSeconds: this.goal?.timeUsedSeconds ?? 0,
        createdAt: this.goal?.createdAt ?? 1,
        updatedAt: 2,
      };
      return { goal: this.goal };
    }
    if (method === "account/rateLimits/read") {
      const common = {
        limitName: null,
        credits: null,
        individualLimit: null,
        planType: null,
        rateLimitReachedType: null,
      };
      return {
        rateLimits: {
          ...common,
          limitId: null,
          primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: null },
          secondary: null,
        },
        rateLimitsByLimitId: {
          codex: {
            ...common,
            limitId: "codex",
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: null },
            secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: null },
          },
        },
        rateLimitResetCredits: null,
      };
    }
    if (method === "config/read") {
      return {
        config: this.permissionConfig,
        origins: {},
        layers: [
          {
            name: { type: "user", file: "/home/hon/.codex/config.toml", profile: null },
            version: `version-${this.configVersion}`,
            config: this.permissionConfig,
            disabledReason: null,
          },
        ],
      };
    }
    if (method === "config/batchWrite") {
      if (params.expectedVersion === this.conflictingVersion) {
        throw new RpcError(-32_000, "Config version changed");
      }
      for (const edit of params.edits as Array<{ keyPath: string; value: unknown }>) {
        this.permissionConfig[edit.keyPath] = edit.value;
      }
      this.configVersion += 1;
      return {
        status: this.writeStatus,
        version: `version-${this.configVersion}`,
        filePath: "/home/hon/.codex/config.toml",
        overriddenMetadata:
          this.writeStatus === "okOverridden"
            ? {
                message: this.writeMessage,
                overridingLayer: { name: { type: "system", file: "/etc/codex/config.toml" } },
                effectiveValue: null,
              }
            : null,
      };
    }
    throw new Error(`Unexpected ${method}`);
  });
}

function testModel(
  id: string,
  effort: string,
  supportsPersonality: boolean,
  serviceTiers: Array<{ id: string; name: string }>,
) {
  return {
    id,
    model: id,
    displayName: id,
    description: "",
    hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: effort, description: "" }],
    defaultReasoningEffort: effort,
    inputModalities: ["text"],
    supportsPersonality,
    additionalSpeedTiers: [],
    serviceTiers,
    defaultServiceTier: null,
    isDefault: id === "gpt-a",
  };
}

function testThread(id = "thread"): Thread {
  return {
    id,
    extra: null,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: "Thread",
    ephemeral: false,
    historyMode: "full",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 2,
    recencyAt: 2,
    status: { type: "notLoaded" },
    path: null,
    cwd: "/work",
    cliVersion: "0.144.6",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

function testTurn(id: string, status: Turn["status"]): Turn {
  return {
    id,
    items: [],
    itemsView: "summary",
    status,
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
}
