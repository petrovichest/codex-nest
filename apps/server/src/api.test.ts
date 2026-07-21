import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app";
import { AttentionManager } from "./attention";
import { hashToken } from "./auth";
import { CodexBridge } from "./codex/bridge";
import type { ServerNotification } from "./codex/generated/index";
import type { Thread, Turn } from "./codex/generated/v2/index";
import { RpcError } from "./codex/transport";
import { loadConfig } from "./config";
import { AppProjection } from "./projection";
import { PushNotifier } from "./push";
import { StateStore } from "./state/store";

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
    authorized.terminate();

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

    const missingGitChanges = await app.inject({
      url: "/api/v1/threads/missing/git-changes",
      headers,
    });
    expect(missingGitChanges.statusCode).toBe(404);
    expect(missingGitChanges.json()).toMatchObject({ error: { code: "not_found" } });

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
      payload: { input: "Составь план" },
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

    const queued = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/queue",
      headers,
      payload: { input: "Поставь в очередь" },
    });
    expect(queued.statusCode).toBe(202);
    expect(store.snapshot().messageQueues?.thread).toEqual([
      expect.objectContaining({
        id: queued.json().id,
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
    expect(store.snapshot().messageQueues?.thread).toBeUndefined();
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "turn/steer").at(-1)?.[1],
    ).toMatchObject({
      clientUserMessageId: queued.json().id,
      input: [{ type: "text", text: "Поставь в очередь", text_elements: [] }],
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
    expect(store.snapshot().messageQueues?.thread).toBeUndefined();

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
    const failedFirstTurn = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/turns",
      headers,
      payload: { input: "Эта цель не запустится", goal: true },
    });
    expect(failedFirstTurn.statusCode).toBe(500);
    expect(bridge.goal).toBeNull();

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
