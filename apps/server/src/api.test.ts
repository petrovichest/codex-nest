import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app";
import { triggerTeamWatchdogs } from "./api";
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
    const languageChanged = new Promise<Record<string, unknown>>((resolve) => {
      const listener = (_sequence: number, event: Record<string, unknown>) => {
        if (event.type !== "uiLanguage.changed") return;
        projection.off("event", listener);
        resolve(event);
      };
      projection.on("event", listener);
    });
    const languageUpdate = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/ui-language",
      headers: authorization,
      payload: { language: "ru" },
    });
    expect(languageUpdate.statusCode).toBe(200);
    expect(languageUpdate.json()).toEqual({ language: "ru" });
    expect(store.snapshot().uiLanguage).toBe("ru");
    expect(projection.snapshot().uiLanguage).toBe("ru");
    await expect(languageChanged).resolves.toEqual({
      type: "uiLanguage.changed",
      language: "ru",
    });
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/settings/ui-language",
          headers: authorization,
          payload: { language: "de" },
        })
      ).statusCode,
    ).toBe(400);

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

    const targetReorderedEvent = new Promise<Record<string, unknown>>((resolve) => {
      const listener = (_sequence: number, event: Record<string, unknown>) => {
        if (event.type !== "projects.reordered") return;
        projection.off("event", listener);
        resolve(event);
      };
      projection.on("event", listener);
    });
    const targetMovedProject = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${legacyProject.json().id as string}/move`,
      headers: authorization,
      payload: { targetIndex: 1 },
    });
    expect(targetMovedProject.statusCode).toBe(200);
    expect(
      targetMovedProject.json().map((project: { displayName: string }) => project.displayName),
    ).toEqual(["new-project", "legacy-project"]);
    await expect(targetReorderedEvent).resolves.toMatchObject({
      type: "projects.reordered",
      projects: [{ displayName: "new-project" }, { displayName: "legacy-project" }],
    });
    expect(store.snapshot().projects.map((project) => project.displayName)).toEqual([
      "new-project",
      "legacy-project",
    ]);

    const boundaryMove = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${legacyProject.json().id as string}/move`,
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
    const publishProjectsReordered = vi.spyOn(projection, "publishProjectsReordered");
    const unchangedTargetMove = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${createdProject.json().id as string}/move`,
      headers: authorization,
      payload: { targetIndex: 0 },
    });
    expect(unchangedTargetMove.statusCode).toBe(200);
    expect(
      unchangedTargetMove.json().map((project: { displayName: string }) => project.displayName),
    ).toEqual(["new-project", "legacy-project"]);
    expect(publishProjectsReordered).not.toHaveBeenCalled();

    for (const payload of [
      {},
      { direction: "up", targetIndex: 0 },
      { targetIndex: -1 },
      { targetIndex: 0.5 },
      { targetIndex: null },
      { targetIndex: 2 },
    ]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/v1/projects/${createdProject.json().id as string}/move`,
            headers: authorization,
            payload,
          })
        ).statusCode,
      ).toBe(400);
    }

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

    const resynced = new Promise<Record<string, unknown>>((resolve) => {
      authorized.once("message", (data) =>
        resolve(JSON.parse(data.toString()) as Record<string, unknown>),
      );
    });
    projection.emit("event", 999, { type: "resync.required" });
    await expect(resynced).resolves.toMatchObject({
      type: "snapshot",
      snapshot: {
        threads: [expect.objectContaining({ id: "broadcast" })],
      },
    });

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

    const shutdownSocket = await app.injectWS("/api/v1/events", {
      headers: { origin: "http://localhost" },
    });
    const shutdownSnapshot = new Promise<void>((resolve) =>
      shutdownSocket.once("message", () => resolve()),
    );
    shutdownSocket.send(JSON.stringify({ type: "authenticate", token: "rotated" }));
    await shutdownSnapshot;
    const shutdownClosed = new Promise<void>((resolve) =>
      shutdownSocket.once("close", () => resolve()),
    );
    await expect(app.close()).resolves.toBeUndefined();
    await shutdownClosed;
  });
});

describe("project removal", () => {
  it("blocks active work, hides sessions, preserves files, and restores sessions on re-add", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-project-removal-api-test-"));
    directories.push(directory);
    const projectPath = join(directory, "project");
    await mkdir(projectPath);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.auth.tokenSha256 = hashToken("correct");
      state.projects.push({
        id: "project",
        displayName: "Project",
        path: projectPath,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      });
    });
    const bridge = new SettingsBridge();
    const attention = new AttentionManager();
    const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention, false);
    projection.upsertThread({ ...testThread("project-thread"), cwd: projectPath });
    projection.upsertThread({ ...testThread("unrelated"), cwd: join(directory, "other") });
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
      projectRoot: directory,
    });
    const headers = { authorization: "Bearer correct" };

    await projection.setCurrentTurn("project-thread", "active-turn");
    const activeRemoval = await app.inject({
      method: "DELETE",
      url: "/api/v1/projects/project",
      headers,
    });
    expect(activeRemoval.statusCode).toBe(409);
    expect(activeRemoval.json()).toMatchObject({ error: { code: "conflict" } });
    expect(store.snapshot().projects).toHaveLength(1);

    projection.upsertThread({ ...testThread("project-thread"), cwd: projectPath });
    await store.update((state) => {
      state.threadMeta["project-thread"] = {
        pinned: false,
        lastReadUpdatedAt: 0,
        awaitingPlanResponse: true,
      };
    });
    const attentionRemoval = await app.inject({
      method: "DELETE",
      url: "/api/v1/projects/project",
      headers,
    });
    expect(attentionRemoval.statusCode).toBe(409);

    await store.update((state) => {
      state.threadMeta["project-thread"]!.awaitingPlanResponse = false;
      state.messageQueues = {
        "project-thread": [
          {
            id: "queued",
            threadId: "project-thread",
            text: "Продолжить",
            createdAt: 1,
            status: "queued",
          },
        ],
      };
    });
    const queuedRemoval = await app.inject({
      method: "DELETE",
      url: "/api/v1/projects/project",
      headers,
    });
    expect(queuedRemoval.statusCode).toBe(409);

    await store.update((state) => {
      delete state.messageQueues?.["project-thread"];
    });
    const removed = await app.inject({
      method: "DELETE",
      url: "/api/v1/projects/project",
      headers,
    });
    expect(removed.statusCode).toBe(204);
    expect(await realpath(projectPath)).toBe(projectPath);
    expect(store.snapshot().dismissedProjectPaths).toEqual([projectPath]);
    expect(projection.snapshot().threads.map((thread) => thread.id)).toEqual(["unrelated"]);

    const restored = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers,
      payload: { path: projectPath },
    });
    expect(restored.statusCode).toBe(201);
    expect(store.snapshot().dismissedProjectPaths).toBeUndefined();
    expect(projection.snapshot().threads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "project-thread",
          projectId: restored.json().id as string,
        }),
        expect.objectContaining({ id: "unrelated", projectId: null }),
      ]),
    );

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
        timingEstimate: {
          sampleCount: 0,
          estimatedFixedProcessingMs: null,
          estimatedProcessingMsPerAudioSecond: null,
        },
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
        timingEstimate: {
          sampleCount: 0,
          estimatedFixedProcessingMs: null,
          estimatedProcessingMsPerAudioSecond: null,
        },
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
    expect(transcribed.json()).toEqual({
      text: "распознанный текст",
      timingEstimate: {
        sampleCount: 0,
        estimatedFixedProcessingMs: null,
        estimatedProcessingMsPerAudioSecond: null,
      },
    });
    expect(transcription.transcribe).toHaveBeenCalledWith(
      Buffer.from("audio"),
      "audio/webm;codecs=opus",
    );

    const timed = await app.inject({
      method: "POST",
      url: "/api/v1/transcriptions",
      headers: {
        ...authorization,
        "content-type": "audio/webm",
        "x-codexnest-audio-duration-ms": "2000",
      },
      payload: Buffer.from("audio"),
    });
    expect(timed.statusCode).toBe(200);
    expect(timed.json().timingEstimate).toMatchObject({
      sampleCount: 1,
      estimatedFixedProcessingMs: null,
      estimatedProcessingMsPerAudioSecond: null,
    });
    expect(Object.values(store.snapshot().transcriptionTimings ?? {})).toHaveLength(1);
    expect(Object.values(store.snapshot().transcriptionTimings ?? {})[0]).toEqual([
      {
        audioDurationMs: 2_000,
        processingMs: expect.any(Number),
      },
    ]);

    const invalidDuration = await app.inject({
      method: "POST",
      url: "/api/v1/transcriptions",
      headers: {
        ...authorization,
        "content-type": "audio/webm",
        "x-codexnest-audio-duration-ms": "unknown",
      },
      payload: Buffer.from("audio"),
    });
    expect(invalidDuration.statusCode).toBe(400);

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

  it("durably accepts a thread voice job and locks its composer until completion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-voice-api-test-"));
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
    projection.upsertThread(testThread("voice"));
    await projection.setDraft("voice", {
      input: "Начало конец",
      images: [],
      goalMode: false,
      annotations: [],
    });
    let resolveTranscript: ((value: string) => void) | undefined;
    const transcription = {
      configuration: vi.fn(() => ({
        providers: ["local" as const],
        provider: "local" as const,
        localUrl: "http://127.0.0.1:8178/inference",
        openAiApiKeyConfigured: false,
        openAiModel: "gpt-4o-transcribe",
        language: "ru",
        refineLocal: false,
        refinementModel: "gpt-5.6-luna",
        maxRecordingSeconds: 300,
        maxUploadBytes: 24 * 1024 * 1024,
        timingEstimate: {
          sampleCount: 0,
          estimatedFixedProcessingMs: null,
          estimatedProcessingMsPerAudioSecond: null,
        },
      })),
      updateConfiguration: vi.fn(),
      transcribe: vi.fn(
        (_audio: Buffer, _contentType: string, signal?: AbortSignal) =>
          new Promise<string>((resolve, reject) => {
            resolveTranscript = resolve;
            signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
          }),
      ),
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
    const updatedAt = store.snapshot().threadMeta.voice!.draft!.updatedAt;

    const accepted = await app.inject({
      method: "POST",
      url:
        "/api/v1/threads/voice/voice-transcriptions?" +
        new URLSearchParams({
          mode: "draft",
          selectionStart: "7",
          selectionEnd: "7",
          draftUpdatedAt: String(updatedAt),
        }),
      headers: {
        ...authorization,
        "content-type": "audio/webm",
        "x-codexnest-audio-duration-ms": "2000",
      },
      payload: Buffer.from("audio"),
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({
      threadId: "voice",
      mode: "draft",
      status: "queued",
    });
    expect(store.snapshot().voiceTranscriptions?.voice).toBeDefined();

    const locked = await app.inject({
      method: "PUT",
      url: "/api/v1/threads/voice/draft",
      headers: authorization,
      payload: { input: "Нельзя", images: [], goalMode: false, annotations: [] },
    });
    expect(locked.statusCode).toBe(409);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/threads/voice/turns",
          headers: authorization,
          payload: { input: "Нельзя отправить" },
        })
      ).statusCode,
    ).toBe(409);

    await vi.waitFor(() => expect(transcription.transcribe).toHaveBeenCalledOnce());
    resolveTranscript?.("голос");
    await vi.waitFor(() => {
      expect(store.snapshot().voiceTranscriptions?.voice).toBeUndefined();
    });
    expect(store.snapshot().threadMeta.voice?.draft?.input).toBe("Начало голос конец");

    const cancellationTarget = await app.inject({
      method: "POST",
      url:
        "/api/v1/threads/voice/voice-transcriptions?" +
        new URLSearchParams({
          mode: "draft",
          selectionStart: "0",
          selectionEnd: "0",
          draftUpdatedAt: String(store.snapshot().threadMeta.voice!.draft!.updatedAt),
          clientUploadId: "cancel-voice",
        }),
      headers: {
        ...authorization,
        "content-type": "audio/webm",
        "x-codexnest-audio-duration-ms": "1000",
      },
      payload: Buffer.from("cancel-audio"),
    });
    expect(cancellationTarget.statusCode).toBe(202);
    await vi.waitFor(() => expect(transcription.transcribe).toHaveBeenCalledTimes(2));

    const cancelled = await app.inject({
      method: "DELETE",
      url: "/api/v1/threads/voice/voice-transcriptions",
      headers: authorization,
    });
    expect(cancelled.statusCode).toBe(204);
    expect(store.snapshot().voiceTranscriptions?.voice).toBeUndefined();

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

    await store.update((state) => {
      state.threadMeta.viewed = {
        pinned: false,
        lastReadUpdatedAt: 0,
        lastOutcome: "completed",
        outcomeUpdatedAt: 2_000,
      };
    });
    projection.upsertThread({ ...testThread("viewed"), status: { type: "idle" } });
    expect(projection.summary("viewed")).toMatchObject({ unread: true, unseen: true });

    const viewed = await app.inject({ url: "/api/v1/threads/viewed", headers });
    expect(viewed.statusCode).toBe(200);
    expect(viewed.json().summary).toMatchObject({ unread: true, unseen: false });
    expect(store.snapshot().threadMeta.viewed?.lastViewedUpdatedAt).toBe(2_000);

    projection.upsertThread({
      ...testThread("viewed"),
      updatedAt: 3,
      recencyAt: 3,
      status: { type: "idle" },
    });
    expect(projection.summary("viewed")?.unseen).toBe(true);
    const olderViewed = await app.inject({
      url: "/api/v1/threads/viewed?cursor=older",
      headers,
    });
    expect(olderViewed.statusCode).toBe(200);
    expect(projection.summary("viewed")?.unseen).toBe(true);
    expect(store.snapshot().threadMeta.viewed?.lastViewedUpdatedAt).toBe(2_000);

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

    projection.upsertThread({
      ...testThread("child"),
      parentThreadId: "thread",
      ephemeral: true,
      agentNickname: "reviewer",
      agentRole: "worker",
    });
    expect(projection.summary("child")?.relation).toEqual({
      kind: "subagent",
      sessionId: "child",
      parentThreadId: "thread",
      nickname: "reviewer",
      role: "worker",
    });
    expect((await app.inject({ url: "/api/v1/threads/child", headers })).statusCode).toBe(200);
    for (const request of [
      {
        method: "PUT",
        url: "/api/v1/threads/child/draft",
        payload: { input: "Нет", images: [], goalMode: false, annotations: [] },
      },
      {
        method: "PATCH",
        url: "/api/v1/threads/child/settings",
        payload: { collaborationMode: "team" },
      },
      {
        method: "POST",
        url: "/api/v1/threads/child/turns",
        payload: { input: "Нет" },
      },
      { method: "DELETE", url: "/api/v1/threads/child" },
    ]) {
      const response = await app.inject({ ...request, headers });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: {
          code: "conflict",
          message: "Subagent threads are managed by their parent session",
        },
      });
    }

    const turnsBeforeEmptyThread = bridge.request.mock.calls.filter(
      ([method]) => method === "turn/start",
    ).length;
    const threadStartsBeforeEmptyThread = bridge.request.mock.calls.filter(
      ([method]) => method === "thread/start",
    ).length;
    const [emptyCreated, emptyReopened] = await Promise.all(
      Array.from({ length: 2 }, () =>
        app.inject({
          method: "POST",
          url: "/api/v1/projects/project/threads",
          headers,
        }),
      ),
    );
    expect(emptyCreated.statusCode).toBe(201);
    expect(emptyReopened.json().thread.id).toBe(emptyCreated.json().thread.id);
    expect(bridge.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(
      threadStartsBeforeEmptyThread + 1,
    );
    expect(emptyCreated.json().thread.settings).toEqual({ collaborationMode: "default" });
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/start").at(-1)?.[1],
    ).toMatchObject({ cwd: "/work", dynamicTools: expect.any(Array) });
    expect(bridge.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(
      turnsBeforeEmptyThread,
    );
    const emptyDetail = await app.inject({
      url: "/api/v1/threads/created",
      headers,
    });
    expect(emptyDetail.statusCode).toBe(200);
    expect(emptyDetail.json().turns).toEqual([]);
    expect(emptyDetail.json().draft).toBeNull();
    const savedDraft = await app.inject({
      method: "PUT",
      url: "/api/v1/threads/created/draft",
      headers,
      payload: {
        input: "  Черновик без обрезки  ",
        images: [
          {
            id: "image",
            name: "example.png",
            url: "data:image/png;base64,AA==",
          },
        ],
        goalMode: true,
        annotations: [
          {
            id: "annotation",
            messageId: "agent",
            source: "agentMessage",
            quote: "Фрагмент",
            startOffset: 0,
            endOffset: 8,
            comment: "Комментарий",
            createdAt: 1,
          },
        ],
      },
    });
    expect(savedDraft.statusCode).toBe(200);
    expect(savedDraft.json()).toMatchObject({
      input: "  Черновик без обрезки  ",
      goalMode: true,
      updatedAt: expect.any(Number),
    });
    expect(
      (
        await app.inject({
          url: "/api/v1/threads/created",
          headers,
        })
      ).json().draft,
    ).toEqual(savedDraft.json());
    bridge.missingRolloutThreadIds.add("created");
    const teamResumeStart = bridge.request.mock.calls.length;
    const emptyTeam = await app.inject({
      method: "PATCH",
      url: "/api/v1/threads/created/settings",
      headers,
      payload: { collaborationMode: "team" },
    });
    expect(emptyTeam.statusCode).toBe(200);
    expect(emptyTeam.json().settings).toEqual({ collaborationMode: "team" });
    expect(
      bridge.request.mock.calls
        .slice(teamResumeStart)
        .filter(([method]) => method === "thread/resume" || method === "thread/metadata/update"),
    ).toEqual([
      [
        "thread/resume",
        expect.objectContaining({
          threadId: "created",
          config: { agents: { enabled: false } },
        }),
        30_000,
      ],
      ["thread/metadata/update", { threadId: "created", gitInfo: { sha: null } }],
      [
        "thread/resume",
        expect.objectContaining({
          threadId: "created",
          config: { agents: { enabled: false } },
        }),
        30_000,
      ],
    ]);
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
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "turn/start").at(-1)?.[1],
    ).toMatchObject({
      additionalContext: {
        "codexnest.team": {
          kind: "application",
          value: expect.stringContaining("codexnest managed-task tools"),
        },
      },
    });
    expect(store.snapshot().threadMeta.created?.unmaterialized).toBe(false);
    expect(store.snapshot().threadMeta.created?.draft).toBeUndefined();
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

    const teamCreated = await app.inject({
      method: "POST",
      url: "/api/v1/threads",
      headers,
      payload: {
        projectId: "project",
        input: "Выполни многошаговый план",
        settings: {
          collaborationMode: "team",
          model: "gpt-a",
          reasoningEffort: "high",
        },
      },
    });
    expect(teamCreated.statusCode).toBe(201);
    expect(teamCreated.json().thread.settings).toEqual({
      collaborationMode: "team",
      model: "gpt-a",
      reasoningEffort: "high",
    });
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/start").at(-1)?.[1],
    ).toMatchObject({
      config: { agents: { enabled: false } },
      dynamicTools: expect.any(Array),
    });
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "turn/start").at(-1)?.[1],
    ).toMatchObject({
      effort: "high",
      collaborationMode: {
        mode: "default",
        settings: { model: "gpt-a", reasoning_effort: "high" },
      },
      additionalContext: {
        "codexnest.team": {
          kind: "application",
          value: expect.stringMatching(
            /codexnest managed-task tools.*Never use native subagent tools.*codexnest\.spawn_task.*self-contained prompt.*only the minimum context.*Never copy or summarize the conversation.*Do not execute a delegated plan step.*finish the turn.*inspect_task.*steer_task.*cancel_task/is,
          ),
        },
      },
    });
    const startsBeforeInvalidTeamGoal = bridge.request.mock.calls.filter(
      ([method]) => method === "thread/start",
    ).length;
    const invalidTeamGoal = await app.inject({
      method: "POST",
      url: "/api/v1/threads",
      headers,
      payload: {
        projectId: "project",
        input: "Несовместимо",
        goal: true,
        settings: { collaborationMode: "team" },
      },
    });
    expect(invalidTeamGoal.statusCode).toBe(409);
    expect(bridge.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(
      startsBeforeInvalidTeamGoal,
    );

    await app.inject({
      method: "PUT",
      url: "/api/v1/threads/thread/draft",
      headers,
      payload: { input: "Черновик очереди", images: [], goalMode: false, annotations: [] },
    });
    expect(store.snapshot().threadMeta.thread?.draft?.input).toBe("Черновик очереди");
    const queued = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/queue",
      headers,
      payload: { input: "Поставь в очередь", clientMessageId: "client-queued" },
    });
    expect(queued.statusCode).toBe(202);
    expect(store.snapshot().threadMeta.thread?.draft).toBeUndefined();
    expect(store.snapshot().messageQueues?.thread).toEqual([
      expect.objectContaining({
        id: "client-queued",
        text: "Поставь в очередь",
        status: "queued",
      }),
    ]);
    const editedQueued = await app.inject({
      method: "PATCH",
      url: `/api/v1/threads/thread/queue/${queued.json().id}`,
      headers,
      payload: { input: "  Исправленный текст  " },
    });
    expect(editedQueued.statusCode).toBe(200);
    expect(editedQueued.json()).toMatchObject({
      id: "client-queued",
      text: "Исправленный текст",
      status: "queued",
    });
    const invalidQueuedEdit = await app.inject({
      method: "PATCH",
      url: `/api/v1/threads/thread/queue/${queued.json().id}`,
      headers,
      payload: { input: " " },
    });
    expect(invalidQueuedEdit.statusCode).toBe(400);

    const cancellable = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/queue",
      headers,
      payload: { input: "Удалить из очереди", clientMessageId: "client-cancelled" },
    });
    const cancelled = await app.inject({
      method: "DELETE",
      url: `/api/v1/threads/thread/queue/${cancellable.json().id}`,
      headers,
    });
    expect(cancelled.statusCode).toBe(204);
    expect(store.snapshot().messageQueues?.thread).toEqual([
      expect.objectContaining({ id: "client-queued", text: "Исправленный текст" }),
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
      input: [{ type: "text", text: "Исправленный текст", text_elements: [] }],
    });
    expect(activityEvents.at(-1)).toMatchObject({
      threadId: "thread",
      turnId: "steered",
      item: { type: "userMessage", id: "client-queued", text: "Исправленный текст" },
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
    await app.inject({
      method: "PUT",
      url: "/api/v1/threads/thread/draft",
      headers,
      payload: { input: "Черновик ошибки", images: [], goalMode: true, annotations: [] },
    });
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
    expect(store.snapshot().threadMeta.thread?.draft?.input).toBe("Черновик ошибки");

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
    expect(store.snapshot().threadMeta.thread?.draft).toBeUndefined();

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

describe("Team orchestration", () => {
  it("spawns managed threads and continues the parent after a submitted result becomes terminal", async () => {
    const { app, bridge, projection, store } = await createTeamHarness();
    const first = await callTeamTool(bridge, "thread", "spawn_task", {
      title: "Проверить интерфейс",
      prompt: "Проверь интерфейс и верни результат.",
    });
    const second = await callTeamTool(bridge, "thread", "spawn_task", {
      title: "Проверить сервер",
      prompt: "Проверь сервер и верни результат.",
    });
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    const firstResult = dynamicToolJson(first);
    const secondResult = dynamicToolJson(second);
    await vi.waitFor(() => {
      const tasks = store.snapshot().threadMeta.thread?.teamOrchestration?.tasks;
      expect(tasks?.[String(firstResult.taskId)]?.status).toBe("running");
      expect(tasks?.[String(secondResult.taskId)]?.status).toBe("running");
    });
    expect(projection.summary(String(firstResult.threadId))?.relation).toMatchObject({
      kind: "subagent",
      parentThreadId: "thread",
    });

    const submitted = await callTeamTool(bridge, String(firstResult.threadId), "submit_result", {
      summary: "Интерфейс проверен",
      details: "Ошибок не обнаружено.",
    });
    expect(submitted.success).toBe(true);
    const startsBefore = bridge.request.mock.calls.filter(
      ([method]) => method === "turn/start",
    ).length;

    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: String(firstResult.threadId),
        turn: {
          ...testTurn("child-result", "completed"),
          items: [
            {
              type: "agentMessage",
              id: "child-final",
              text: "Интерфейс проверен",
              phase: "final_answer",
              memoryCitation: null,
            },
          ],
          itemsView: "full",
        },
      },
    } satisfies ServerNotification);

    await vi.waitFor(() =>
      expect(bridge.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(
        startsBefore + 1,
      ),
    );
    const continuation = bridge.request.mock.calls
      .filter(([method]) => method === "turn/start")
      .at(-1)?.[1] as Record<string, unknown>;
    expect(continuation).toMatchObject({
      threadId: "thread",
      clientUserMessageId: null,
      input: [],
      additionalContext: {
        "codexnest.team.results": {
          kind: "application",
          value: expect.stringMatching(
            /Проверить интерфейс.*Summary: Интерфейс проверен.*Проверить сервер/is,
          ),
        },
      },
    });
    await vi.waitFor(() =>
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(firstResult.taskId)],
      ).toBeUndefined(),
    );
    expect(
      store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(secondResult.taskId)],
    ).toMatchObject({ status: "running" });
    expect(store.snapshot().threadMeta.thread?.timelineArtifacts?.turn).toEqual([
      expect.objectContaining({
        type: "orchestrationNotice",
        agents: [
          expect.objectContaining({
            threadId: firstResult.threadId,
            title: "Проверить интерфейс",
            outcome: "completed",
          }),
        ],
      }),
    ]);
    const deliveredChild = projection.summary(String(firstResult.threadId));
    expect(deliveredChild).toMatchObject({
      unread: false,
    });
    expect(store.snapshot().threadMeta[String(firstResult.threadId)]?.lastReadUpdatedAt).toBe(
      deliveredChild?.updatedAt,
    );
    expect(projection.summary("thread")?.currentTurnId).toBe("turn");

    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: String(firstResult.threadId),
        turn: testTurn("child-result", "completed"),
      },
    } satisfies ServerNotification);
    await nextImmediate();
    await nextImmediate();
    expect(bridge.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(
      startsBefore + 1,
    );

    await app.close();
    await store.flushed();
  });

  it("extracts a final answer and delivers a queued user message before the continuation", async () => {
    const { app, bridge, headers, projection, store } = await createTeamHarness();
    bridge.emit("notification", {
      method: "turn/started",
      params: { threadId: "thread", turn: testTurn("parent-running", "inProgress") },
    } satisfies ServerNotification);
    const spawned = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Собрать данные",
        prompt: "Собери данные и верни результат.",
      }),
    );
    await vi.waitFor(() => {
      const task =
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)];
      expect(task?.status).toBe("running");
    });
    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: String(spawned.threadId),
        turn: {
          ...testTurn("child-result", "completed"),
          itemsView: "full",
          items: [
            {
              type: "agentMessage",
              id: "final",
              text: "Данные собраны\n\nПолный отчёт",
              phase: "final_answer",
              memoryCitation: null,
            },
          ],
        },
      },
    } satisfies ServerNotification);
    await vi.waitFor(() => {
      const tracked =
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)];
      expect(tracked?.status).toBe("completed");
      expect(tracked?.result).toMatchObject({
        summary: "Данные собраны",
        details: "Данные собраны\n\nПолный отчёт",
        source: "final_answer",
      });
      expect(tracked?.delivery).toBeUndefined();
    });

    const queued = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/queue",
      headers,
      payload: { input: "Сначала ответь на это", clientMessageId: "user-priority" },
    });
    expect(queued.statusCode).toBe(202);
    const startsBefore = bridge.request.mock.calls.filter(
      ([method]) => method === "turn/start",
    ).length;

    bridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "thread", turn: testTurn("parent-running", "completed") },
    } satisfies ServerNotification);

    await vi.waitFor(() =>
      expect(bridge.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(
        startsBefore + 1,
      ),
    );
    const continuation = bridge.request.mock.calls
      .filter(([method]) => method === "turn/start")
      .at(-1)?.[1] as Record<string, unknown>;
    expect(continuation).toMatchObject({
      clientUserMessageId: "user-priority",
      input: [{ type: "text", text: "Сначала ответь на это", text_elements: [] }],
      additionalContext: {
        "codexnest.team.results": {
          kind: "application",
          value: expect.stringContaining("If this turn also contains an explicit user message"),
        },
      },
    });
    await vi.waitFor(() => expect(store.snapshot().messageQueues?.thread).toBeUndefined());
    expect(projection.summary("thread")?.currentTurnId).toBe("turn");

    await nextImmediate();
    expect(bridge.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(
      startsBefore + 1,
    );
    await app.close();
    await store.flushed();
  });

  it("runs four managed tasks and starts the fifth from the FIFO queue", async () => {
    const { app, bridge, store } = await createTeamHarness();
    const spawned = [];
    for (let index = 1; index <= 5; index += 1) {
      spawned.push(
        dynamicToolJson(
          await callTeamTool(bridge, "thread", "spawn_task", {
            title: `Задача ${index}`,
            prompt: `Выполни задачу ${index}.`,
          }),
        ),
      );
    }
    await vi.waitFor(() => {
      const tasks = store.snapshot().threadMeta.thread?.teamOrchestration?.tasks ?? {};
      expect(Object.values(tasks).filter((task) => task.status === "running")).toHaveLength(4);
      expect(tasks[String(spawned[4]!.taskId)]?.status).toBe("queued");
    });

    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: String(spawned[0]!.threadId),
        turn: {
          ...testTurn("first-terminal", "completed"),
          itemsView: "full",
          items: [
            {
              type: "agentMessage",
              id: "first-final",
              text: "Первая задача готова",
              phase: "final_answer",
              memoryCitation: null,
            },
          ],
        },
      },
    } satisfies ServerNotification);

    await vi.waitFor(() => {
      const tasks = store.snapshot().threadMeta.thread?.teamOrchestration?.tasks ?? {};
      expect(tasks[String(spawned[4]!.taskId)]?.status).toBe("running");
    });
    const childStarts = bridge.request.mock.calls.filter(
      ([method, params]) =>
        method === "turn/start" &&
        String((params as Record<string, unknown>).threadId) !== "thread",
    );
    expect(childStarts).toHaveLength(5);

    await app.close();
    await store.flushed();
  });

  it("arms the inactivity watchdog and lets the parent inspect, steer, and cancel", async () => {
    const { app, bridge, store } = await createTeamHarness();
    const spawned = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Долгая задача",
        prompt: "Выполни долгую задачу.",
      }),
    );
    await vi.waitFor(() => {
      const task =
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)];
      expect(task?.status).toBe("running");
    });
    const now = Date.now();
    await store.update((state) => {
      const task = state.threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)];
      if (task) task.lastActivityAt = now - 11 * 60_000;
    });
    await expect(triggerTeamWatchdogs(store, new Map(), now)).resolves.toEqual(new Set(["thread"]));
    expect(
      store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
        ?.watchdog,
    ).toMatchObject({ status: "pending" });

    expect(
      (
        await callTeamTool(bridge, "thread", "inspect_task", {
          taskId: spawned.taskId,
        })
      ).success,
    ).toBe(true);
    expect(
      (
        await callTeamTool(bridge, "thread", "steer_task", {
          taskId: spawned.taskId,
          message: "Проверь, не заблокирован ли процесс.",
        })
      ).success,
    ).toBe(true);
    expect(
      store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
        ?.watchdog,
    ).toBeUndefined();

    expect(
      (
        await callTeamTool(bridge, "thread", "cancel_task", {
          taskId: spawned.taskId,
          reason: "Больше не требуется",
        })
      ).success,
    ).toBe(true);
    expect(
      bridge.request.mock.calls.some(
        ([method, params]) =>
          method === "turn/interrupt" &&
          (params as Record<string, unknown>).threadId === spawned.threadId,
      ),
    ).toBe(true);

    await app.close();
    await store.flushed();
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
  missingRolloutThreadIds = new Set<string>();
  managedThreadSequence = 0;
  request = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === "thread/list") {
      return params.archived
        ? { data: [], nextCursor: null, backwardsCursor: null }
        : { data: [testThread()], nextCursor: null, backwardsCursor: null };
    }
    if (method === "thread/loaded/list") {
      return { data: ["thread"], nextCursor: null };
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
    if (method === "thread/start") {
      if (params.threadSource === "codexnest-managed-subagent") {
        this.managedThreadSequence += 1;
        return { thread: testThread(`managed-${this.managedThreadSequence}`) };
      }
      return { thread: testThread("created") };
    }
    if (method === "thread/resume") {
      const threadId = String(params.threadId);
      if (this.missingRolloutThreadIds.delete(threadId)) {
        throw new RpcError(-32_600, `no rollout found for thread id ${threadId}`);
      }
      return {};
    }
    if (method === "thread/metadata/update") {
      return { thread: testThread(String(params.threadId)) };
    }
    if (method === "thread/name/set") return {};
    if (method === "thread/delete") return {};
    if (method === "thread/turns/list") {
      return { data: [], nextCursor: null, backwardsCursor: null };
    }
    if (method === "turn/start") {
      if (this.failNextTurnStart) {
        this.failNextTurnStart = false;
        throw new Error("turn failed");
      }
      const threadId = String(params.threadId ?? "thread");
      return {
        turn: testTurn(threadId === "thread" ? "turn" : `turn-${threadId}`, "inProgress"),
      };
    }
    if (method === "turn/steer") return { turnId: "steered" };
    if (method === "turn/interrupt") return {};
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

async function createTeamHarness() {
  const directory = await mkdtemp(join(tmpdir(), "codexnest-team-api-test-"));
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
  await projection.setSettings("thread", {
    collaborationMode: "team",
    model: "gpt-a",
    reasoningEffort: "high",
  });
  await store.update((state) => {
    const meta = state.threadMeta.thread ?? { pinned: false, lastReadUpdatedAt: 0 };
    meta.teamToolsVersion = 1;
    state.threadMeta.thread = meta;
  });
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
    projectRoot: directory,
  });
  return {
    app,
    bridge,
    headers: { authorization: "Bearer correct" },
    projection,
    store,
  };
}

type TestDynamicToolResponse = {
  contentItems: Array<{ type: "inputText"; text: string }>;
  success: boolean;
};

async function callTeamTool(
  bridge: SettingsBridge,
  threadId: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<TestDynamicToolResponse> {
  return new Promise((resolve, reject) => {
    const requestId = `tool-${Math.random()}`;
    bridge.emit(
      "request",
      {
        method: "item/tool/call",
        id: requestId,
        params: {
          threadId,
          turnId: `turn-${threadId}`,
          callId: requestId,
          namespace: "codexnest",
          tool,
          arguments: args,
        },
      },
      {
        respond(id: string, result: TestDynamicToolResponse) {
          if (id !== requestId) {
            reject(new Error("Unexpected dynamic tool response id"));
            return;
          }
          resolve(result);
        },
        respondError(_id: string, _code: number, message: string) {
          reject(new Error(message));
        },
      },
    );
  });
}

function dynamicToolJson(response: TestDynamicToolResponse): Record<string, unknown> {
  const text = response.contentItems.find((item) => item.type === "inputText")?.text;
  if (!text) throw new Error("Dynamic tool response has no text");
  return JSON.parse(text) as Record<string, unknown>;
}

function nextImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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
