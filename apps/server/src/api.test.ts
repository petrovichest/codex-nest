import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import {
  BROWSER_EXTENSION_PROTOCOL,
  BROWSER_EXTENSION_PROTOCOL_VERSION,
  BROWSER_EXTENSION_WEBSOCKET_PATH,
  BROWSER_TOOL_NAMES,
} from "@codexnest/protocol";

import { buildApp } from "./app";
import { triggerTeamWatchdogs } from "./api";
import type { AppManager } from "./app-management";
import { AttentionManager } from "./attention";
import { hashToken } from "./auth";
import { CodexBridge } from "./codex/bridge";
import type { ServerNotification, ServerRequest } from "./codex/generated/index";
import type { Thread, ThreadItem, Turn } from "./codex/generated/v2/index";
import { RpcError, type JsonlTransport } from "./codex/transport";
import type { CodexManager } from "./codex-management";
import { loadConfig } from "./config";
import { AppProjection } from "./projection";
import { RuntimeLifecycle } from "./runtime-lifecycle";
import { StateStore } from "./state/store";
import { computeTeamWorkspaceDelta, createTeamWorkspace } from "./team-workspace";
import { TranscriptionError } from "./transcription";

const directories: string[] = [];
const execFileAsync = promisify(execFile);
const TEAM_MARKER_TEXT =
  "Continue CodexNest Team orchestration using the attached managed-task results.";
afterEach(async () =>
  Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  ),
);

describe("HTTP authentication", () => {
  it("gates mutations until recovery and exposes a token-protected restart drain", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-recovery-api-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.auth.tokenSha256 = hashToken("correct");
    });
    const bridge = new SettingsBridge();
    const attention = new AttentionManager();
    const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
    const tokenPath = join(directory, "restart-token");
    const lifecycle = new RuntimeLifecycle({
      transport: "daemon",
      tokenPath,
      bridgeReady: () => true,
      checkpoint: () => store.checkpoint(),
      drainLeaseMs: 1_000,
    });
    await lifecycle.initialize();
    const appManager = {
      forceRestart: vi.fn(async () => ({ accepted: true as const })),
    } as unknown as AppManager;
    const codexManager = {
      maintenanceActive: false,
      forceRestart: vi.fn(async () => ({
        operation: "idle",
      })),
    } as unknown as CodexManager;
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
        lifecycle,
        appManager,
        codexManager,
      },
    );
    const headers = { authorization: "Bearer correct" };
    expect((await app.inject({ url: "/api/v1/health" })).json()).toMatchObject({
      status: "degraded",
      recoveryState: "starting",
      restartProtocolVersion: 2,
      transport: "daemon",
    });
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/settings/ui-language",
          headers,
          payload: { language: "ru" },
        })
      ).statusCode,
    ).toBe(503);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/settings/app/force-restart",
        })
      ).statusCode,
    ).toBe(401);

    lifecycle.ready();
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/settings/ui-language",
          headers,
          payload: { language: "ru" },
        })
      ).statusCode,
    ).toBe(200);
    const token = (await readFile(tokenPath, "utf8")).trim();
    await store.update((state) => {
      state.threadMeta["managed-parent"] = {
        pinned: false,
        lastReadUpdatedAt: 0,
        managedTeamToolsAvailable: true,
        teamOrchestration: {
          tasks: {
            managed: {
              id: "managed",
              childThreadId: "managed-child",
              title: "Managed recovery",
              prompt: "Remain recoverable across restart.",
              status: "running",
              createdAt: 1,
              lastActivityAt: 1,
            },
          },
        },
      };
    });
    const prepared = await app.inject({
      method: "POST",
      url: "/api/v1/internal/restart/prepare",
      headers: { "x-codexnest-restart-token": token },
    });
    expect(prepared.statusCode).toBe(200);
    expect(prepared.json()).toMatchObject({
      recoveryState: "draining",
      transport: "daemon",
      hasManagedWork: true,
      quiescent: false,
    });
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/settings/ui-language",
          headers,
          payload: { language: "en" },
        })
      ).statusCode,
    ).toBe(503);
    const appRestart = await app.inject({
      method: "POST",
      url: "/api/v1/settings/app/force-restart",
      headers,
    });
    expect(appRestart.statusCode).toBe(202);
    expect(appRestart.json()).toEqual({ accepted: true });
    const codexRestart = await app.inject({
      method: "POST",
      url: "/api/v1/settings/codex/force-restart",
      headers,
    });
    expect(codexRestart.statusCode).toBe(200);
    expect(appManager.forceRestart).toHaveBeenCalledOnce();
    expect(codexManager.forceRestart).toHaveBeenCalledOnce();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/internal/restart/resume",
          headers: { "x-codexnest-restart-token": token },
        })
      ).statusCode,
    ).toBe(204);
    expect(lifecycle.state).toBe("ready");
    await store.update((state) => {
      const task = state.threadMeta["managed-parent"]?.teamOrchestration?.tasks.managed;
      if (!task) return;
      task.status = "completed";
      task.terminalTurnId = "managed-terminal";
      task.result = { outcome: "success", summary: "Recovered", source: "status" };
      task.delivery = {
        status: "delivered",
        claimId: "managed-claim",
        parentTurnId: "parent-terminal",
      };
    });
    const historyOnly = await app.inject({
      method: "POST",
      url: "/api/v1/internal/restart/prepare",
      headers: { "x-codexnest-restart-token": token },
    });
    expect(historyOnly.json()).toMatchObject({ hasManagedWork: false, quiescent: true });
    await lifecycle.resume(token);
    await app.close();
    await lifecycle.close();
  });

  it("releases mutation tracking after the handler settles despite a client disconnect", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-aborted-mutation-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.auth.tokenSha256 = hashToken("correct");
    });
    const bridge = new SettingsBridge();
    const attention = new AttentionManager();
    const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
    const tokenPath = join(directory, "restart-token");
    const lifecycle = new RuntimeLifecycle({
      transport: "daemon",
      tokenPath,
      bridgeReady: () => true,
      checkpoint: () => store.checkpoint(),
      drainTimeoutMs: 500,
    });
    await lifecycle.initialize();
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
        lifecycle,
      },
    );
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseHandler!: () => void;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    app.put("/api/v1/test/slow-mutation", async () => {
      markStarted();
      await handlerGate;
      await store.update((state) => {
        state.uiLanguage = "ru";
      });
      return { ok: true };
    });
    lifecycle.ready();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test server");
    const controller = new AbortController();
    const response = fetch(`http://127.0.0.1:${address.port}/api/v1/test/slow-mutation`, {
      method: "PUT",
      headers: { authorization: "Bearer correct" },
      signal: controller.signal,
    }).then(
      () => "completed",
      () => "aborted",
    );
    await started;
    controller.abort();
    await expect(response).resolves.toBe("aborted");

    const token = (await readFile(tokenPath, "utf8")).trim();
    let prepared = false;
    const preparing = lifecycle.prepare(token).then(() => {
      prepared = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(prepared).toBe(false);

    releaseHandler();
    await preparing;
    expect(lifecycle.state).toBe("draining");
    await lifecycle.resume(token);
    expect(lifecycle.state).toBe("ready");
    await app.close();
    await lifecycle.close();
  });

  it("recovers orphaned startup state to ready instead of failed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-startup-recovery-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.auth.tokenSha256 = hashToken("correct");
      state.threadMeta["queued-thread"] = {
        pinned: false,
        lastReadUpdatedAt: 0,
      };
      state.messageQueues = {
        "queued-thread": [
          {
            id: "queued-message",
            threadId: "queued-thread",
            text: "Recover me",
            createdAt: 1,
            status: "dispatching",
          },
        ],
      };
    });
    const bridge = new EventEmitter() as EventEmitter & {
      state: "ready";
      request: ReturnType<typeof vi.fn>;
    };
    bridge.state = "ready";
    bridge.request = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === "thread/list") {
        if (params.archived) return { data: [], nextCursor: null, backwardsCursor: null };
        return {
          data: [
            {
              ...testThread("orphan-thread"),
              status: { type: "idle" as const },
              updatedAt: 5,
              recencyAt: 5,
            },
          ],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      if (method === "thread/loaded/list") return { data: [], nextCursor: null };
      if (method === "thread/turns/list" && params.threadId === "orphan-thread") {
        throw new RpcError(-32_600, "thread not loaded");
      }
      if (method === "thread/read" && params.threadId === "queued-thread") {
        throw new RpcError(-32_600, "thread not loaded");
      }
      if (method === "model/list") return { data: [], nextCursor: null };
      if (method === "thread/turns/list") {
        return { data: [], nextCursor: null, backwardsCursor: null };
      }
      throw new Error(`Unexpected ${method}`);
    });
    const attention = new AttentionManager();
    const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
    const tokenPath = join(directory, "restart-token");
    const lifecycle = new RuntimeLifecycle({
      transport: "daemon",
      tokenPath,
      bridgeReady: () => true,
      checkpoint: () => store.checkpoint(),
      drainLeaseMs: 1_000,
    });
    await lifecycle.initialize();
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
        lifecycle,
      },
    );
    lifecycle.syncing();
    await projection.sync();
    await vi.waitFor(() => expect(lifecycle.state).toBe("ready"));
    expect(store.snapshot().threadMeta["orphan-thread"]).toBeUndefined();
    expect(store.snapshot().threadMeta["queued-thread"]).toBeUndefined();
    expect(store.snapshot().messageQueues?.["queued-thread"]).toBeUndefined();
    await app.close();
    await lifecycle.close();
  });

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
    const projection = new AppProjection(bridge, store, attention);
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

describe("skills API and explicit invocation", () => {
  it("lists installed skills for an allowed cwd and toggles a discovered path", async () => {
    const harness = await createSkillsHarness();

    const listed = await harness.app.inject({
      url: "/api/v1/skills?cwd=%2Fwork&forceReload=true",
      headers: harness.headers,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ cwd: "/work" });
    expect(listed.json().skills).toContainEqual(
      expect.objectContaining({
        name: "review",
        displayName: "Code Review",
        path: "/skills/review/SKILL.md",
        enabled: true,
      }),
    );
    expect(listed.json().skills).not.toContainEqual(
      expect.objectContaining({ name: "openai-templates:artifact-template-analytics-dashboard" }),
    );

    const updated = await harness.app.inject({
      method: "PUT",
      url: "/api/v1/skills/config",
      headers: harness.headers,
      payload: { cwd: "/work", path: "/skills/review/SKILL.md", enabled: false },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({ path: "/skills/review/SKILL.md", enabled: false });
    expect(harness.bridge.request).toHaveBeenCalledWith("skills/config/write", {
      path: "/skills/review/SKILL.md",
      enabled: false,
    });

    await harness.app.close();
  });

  it("enriches dollar markers from the cached catalog without a send-path skills RPC", async () => {
    const harness = await createSkillsHarness();
    await harness.app.inject({
      url: "/api/v1/skills?cwd=%2Fwork&forceReload=false",
      headers: harness.headers,
    });
    const listCalls = harness.bridge.request.mock.calls.filter(
      ([method]) => method === "skills/list",
    ).length;

    const started = await harness.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/turns",
      headers: harness.headers,
      payload: { input: "$review, this change" },
    });

    expect(started.statusCode).toBe(201);
    expect(
      harness.bridge.request.mock.calls.filter(([method]) => method === "skills/list"),
    ).toHaveLength(listCalls);
    expect(
      harness.bridge.request.mock.calls.filter(([method]) => method === "turn/start").at(-1)?.[1],
    ).toMatchObject({
      input: [
        { type: "text", text: "$review, this change", text_elements: [] },
        { type: "skill", name: "review", path: "/skills/review/SKILL.md" },
      ],
    });

    await harness.app.close();
  });

  it("keeps an uncached dollar marker as text instead of blocking send on discovery", async () => {
    const harness = await createSkillsHarness();
    harness.bridge.request.mockClear();

    const started = await harness.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/turns",
      headers: harness.headers,
      payload: { input: "$review immediately" },
    });

    expect(started.statusCode).toBe(201);
    expect(
      harness.bridge.request.mock.calls.filter(([method]) => method === "skills/list"),
    ).toHaveLength(0);
    expect(
      harness.bridge.request.mock.calls.filter(([method]) => method === "turn/start").at(-1)?.[1],
    ).toMatchObject({
      input: [{ type: "text", text: "$review immediately", text_elements: [] }],
    });

    await harness.app.close();
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
    const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
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
    const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
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
    const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
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
    const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
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
      fileName: "app-debug.apk",
      size: 4,
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

describe("session forks", () => {
  it("forks through the selected completed reply with a generated title and fresh state", async () => {
    const harness = await createForkHarness();
    await harness.store.update((state) => {
      state.taskDefaults = { titleModel: "gpt-a" };
    });
    harness.bridge.threadTurns.set("thread", [
      {
        ...testTurn("selected-turn", "completed"),
        itemsView: "full",
        items: [
          agentMessage("empty-before", "  "),
          agentMessage("selected-answer", "Готовая реализация с проверками"),
          agentMessage("empty-after", "\n"),
        ],
      },
    ]);

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/forks",
      headers: harness.headers,
      payload: { lastTurnId: "selected-turn", agentMessageId: "selected-answer" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().thread).toMatchObject({
      id: "fork",
      title: "Готовая реализация",
      state: "completed",
      unread: true,
      unseen: true,
      pinned: false,
      currentTurnId: null,
      queuedMessageCount: 0,
      settings: {
        collaborationMode: "default",
        model: "gpt-b",
        reasoningEffort: "low",
      },
      relation: { kind: "session", sessionId: "fork", forkedFromId: "thread" },
    });
    expect(response.json().thread.relation).not.toHaveProperty("parentThreadId");
    expect(harness.threadTitles.generate).toHaveBeenCalledWith("Готовая реализация с проверками", {
      cwd: "/work",
      model: "gpt-a",
      effort: "high",
    });
    expect(harness.bridge.request).toHaveBeenCalledWith(
      "thread/turns/list",
      {
        threadId: "thread",
        cursor: null,
        limit: 100,
        sortDirection: "desc",
        itemsView: "full",
      },
      30_000,
    );
    expect(
      harness.bridge.request.mock.calls.some(([method]) => method === "thread/items/list"),
    ).toBe(false);
    expect(harness.bridge.request).toHaveBeenCalledWith("thread/fork", {
      threadId: "thread",
      lastTurnId: "selected-turn",
      excludeTurns: true,
    });
    expect(harness.threadTitles.generate.mock.invocationCallOrder[0]).toBeLessThan(
      harness.bridge.request.mock.invocationCallOrder[
        harness.bridge.request.mock.calls.findIndex(([method]) => method === "thread/fork")
      ]!,
    );
    expect(harness.bridge.request).toHaveBeenCalledWith("thread/goal/clear", {
      threadId: "fork",
    });
    expect(harness.bridge.request).toHaveBeenCalledWith("thread/name/set", {
      threadId: "fork",
      name: "Готовая реализация",
    });
    expect(harness.store.snapshot().threadMeta.fork).toEqual({
      pinned: false,
      lastReadUpdatedAt: 0,
      lastOutcome: "completed",
      outcomeUpdatedAt: 4_000,
      settings: {
        collaborationMode: "default",
        model: "gpt-b",
        reasoningEffort: "low",
      },
      managedTeamToolsAvailable: true,
      sessionSnapshot: {
        sessionId: "fork",
        forkedFromId: "thread",
        name: "Готовая реализация",
        preview: "Thread",
        cwd: "/work",
        createdAt: 3,
        updatedAt: 4,
        archived: false,
        currentTurnId: null,
      },
    });
    expect(harness.store.snapshot().messageQueues?.fork).toBeUndefined();
    expect(harness.projection.summary("fork")).toEqual(response.json().thread);
    await harness.app.close();
  });

  it("forks through a completed plan and preserves Plan mode", async () => {
    const harness = await createForkHarness();
    await harness.projection.setSettings("thread", {
      collaborationMode: "plan",
      model: "gpt-b",
      reasoningEffort: "low",
    });
    harness.bridge.threadTurns.set("thread", [
      {
        ...testTurn("plan-turn", "completed"),
        itemsView: "full",
        items: [
          agentMessage("earlier-answer", "Предварительный ответ"),
          { type: "plan", id: "selected-plan", text: "План реализации с проверками" },
        ],
      },
    ]);

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/forks",
      headers: harness.headers,
      payload: { lastTurnId: "plan-turn", agentMessageId: "selected-plan" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().thread).toMatchObject({
      id: "fork",
      state: "completed",
      settings: {
        collaborationMode: "plan",
        model: "gpt-b",
        reasoningEffort: "low",
      },
    });
    expect(harness.threadTitles.generate).toHaveBeenCalledWith("План реализации с проверками", {
      cwd: "/work",
      model: "gpt-b",
      effort: "low",
    });
    expect(harness.bridge.request).toHaveBeenCalledWith("thread/fork", {
      threadId: "thread",
      lastTurnId: "plan-turn",
      excludeTurns: true,
    });
    await harness.app.close();
  });

  it("rejects missing, subagent, unfinished, missing, and mismatched fork points", async () => {
    const harness = await createForkHarness();
    harness.bridge.missingThreadIds.add("missing");
    harness.projection.upsertThread({
      ...testThread("child"),
      parentThreadId: "thread",
      ephemeral: true,
    });
    harness.bridge.threadTurns.set("thread", [
      {
        ...testTurn("running-turn", "inProgress"),
        itemsView: "full",
        items: [agentMessage("running-answer", "Ещё работаю")],
      },
      {
        ...testTurn("completed-turn", "completed"),
        itemsView: "full",
        items: [
          agentMessage("earlier-answer", "Первый ответ"),
          agentMessage("last-answer", "Последний ответ"),
        ],
      },
    ]);

    const issue = (id: string, lastTurnId: string, agentMessageId: string) =>
      harness.app.inject({
        method: "POST",
        url: `/api/v1/threads/${id}/forks`,
        headers: harness.headers,
        payload: { lastTurnId, agentMessageId },
      });

    expect((await issue("missing", "completed-turn", "last-answer")).statusCode).toBe(404);
    expect((await issue("child", "completed-turn", "last-answer")).statusCode).toBe(409);
    expect((await issue("thread", "running-turn", "running-answer")).statusCode).toBe(409);
    expect((await issue("thread", "unknown-turn", "last-answer")).statusCode).toBe(400);
    const mismatched = await issue("thread", "completed-turn", "earlier-answer");
    expect(mismatched.statusCode).toBe(400);
    expect(mismatched.json()).toMatchObject({
      error: { message: expect.stringContaining("last non-empty agent message") },
    });
    expect(harness.threadTitles.generate).not.toHaveBeenCalled();
    expect(harness.bridge.request).not.toHaveBeenCalledWith("thread/fork", expect.anything());
    await harness.app.close();
  });

  it("does not create a native fork when synchronous title generation fails", async () => {
    const harness = await createForkHarness();
    harness.bridge.threadTurns.set("thread", [
      {
        ...testTurn("completed-turn", "completed"),
        itemsView: "full",
        items: [agentMessage("answer", "Готовый ответ")],
      },
    ]);
    harness.threadTitles.generate.mockRejectedValueOnce(new Error("title failed"));

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/forks",
      headers: harness.headers,
      payload: { lastTurnId: "completed-turn", agentMessageId: "answer" },
    });

    expect(response.statusCode).toBe(500);
    expect(harness.bridge.request).not.toHaveBeenCalledWith("thread/fork", expect.anything());
    expect(harness.projection.summary("fork")).toBeUndefined();
    await harness.app.close();
  });
});

describe("task defaults", () => {
  it("uses the title model for first-turn naming without changing the session model", async () => {
    const harness = await createForkHarness();
    await harness.projection.markUnmaterialized("thread");
    await harness.store.update((state) => {
      state.taskDefaults = { titleModel: "gpt-a" };
    });

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/turns",
      headers: harness.headers,
      payload: { input: "Первое сообщение" },
    });

    expect(response.statusCode).toBe(201);
    await vi.waitFor(() =>
      expect(harness.threadTitles.generate).toHaveBeenCalledWith("Первое сообщение", {
        cwd: "/work",
        model: "gpt-a",
        effort: "high",
      }),
    );
    expect(harness.projection.summary("thread")?.settings).toMatchObject({
      model: "gpt-b",
      reasoningEffort: "low",
    });
    await harness.app.close();
  });

  it("preserves omitted defaults and clears explicit null values", async () => {
    const harness = await createForkHarness();
    const save = (payload: Record<string, string | null>) =>
      harness.app.inject({
        method: "PUT",
        url: "/api/v1/settings/task-defaults",
        headers: harness.headers,
        payload,
      });

    expect(
      (
        await save({
          model: "gpt-a",
          titleModel: "gpt-b",
          serviceTier: "fast",
          personality: "friendly",
        })
      ).json(),
    ).toEqual({
      model: "gpt-a",
      titleModel: "gpt-b",
      serviceTier: "fast",
      personality: "friendly",
    });
    expect((await save({ titleModel: null })).json()).toEqual({
      model: "gpt-a",
      serviceTier: "fast",
      personality: "friendly",
    });
    expect((await save({ model: null })).json()).toEqual({
      serviceTier: "fast",
      personality: "friendly",
    });

    await harness.store.update((state) => {
      state.taskDefaults = {
        model: "retired-session-model",
        titleModel: "retired-title-model",
        serviceTier: "legacy-tier",
        personality: "friendly",
      };
    });
    expect((await save({ personality: "friendly" })).json()).toEqual({
      model: "retired-session-model",
      titleModel: "retired-title-model",
      serviceTier: "legacy-tier",
      personality: "friendly",
    });
    expect(harness.projection.newSessionSettings).toEqual({
      collaborationMode: "plan",
      personality: "friendly",
    });
    expect((await save({ titleModel: null })).json()).toEqual({
      model: "retired-session-model",
      serviceTier: "legacy-tier",
      personality: "friendly",
    });
    await harness.app.close();
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
    const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
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
      threadTitles,
      projectRoot: directory,
    });
    const headers = { authorization: "Bearer correct" };

    bridge.rejectFullTurnReads = true;
    const threadListsBeforeRefresh = bridge.request.mock.calls.filter(
      ([method]) => method === "thread/list",
    ).length;
    const modelListsBeforeRefresh = bridge.request.mock.calls.filter(
      ([method]) => method === "model/list",
    ).length;
    const threadReadsBeforeRefresh = bridge.request.mock.calls.filter(
      ([method]) => method === "thread/read",
    ).length;
    const refreshed = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/refresh",
      headers,
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toMatchObject({
      snapshot: {
        threads: [expect.objectContaining({ id: "thread" })],
      },
      detail: {
        summary: expect.objectContaining({ id: "thread" }),
        turns: [],
      },
    });
    expect(bridge.request.mock.calls.filter(([method]) => method === "thread/list").length).toBe(
      threadListsBeforeRefresh,
    );
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/read").length,
    ).toBeGreaterThan(threadReadsBeforeRefresh);
    expect(bridge.request.mock.calls.filter(([method]) => method === "model/list").length).toBe(
      modelListsBeforeRefresh,
    );
    expect(
      bridge.request.mock.calls.findLast(([method]) => method === "thread/turns/list")?.[1],
    ).toMatchObject({ threadId: "thread", itemsView: "summary" });

    const requestLogger = vi.spyOn(app.log, "child").mockReturnValue(app.log);
    const errorLog = vi.spyOn(app.log, "error");
    bridge.nextTurnListError = new RpcError(-32_000, "Rollout changed while reading turns");
    const failedRefresh = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/refresh",
      headers,
    });
    expect(failedRefresh.statusCode).toBe(500);
    expect(failedRefresh.json()).toEqual({
      error: { code: "internal_error", message: "Internal server error" },
    });
    expect(errorLog).toHaveBeenCalledWith(
      {
        err: { name: "RpcError", message: "Rollout changed while reading turns" },
        rpcCode: -32_000,
        method: "POST",
        route: "/api/v1/threads/:id/refresh",
      },
      "request failed",
    );
    errorLog.mockRestore();
    requestLogger.mockRestore();

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
    expect(viewed.json().summary).toMatchObject({ unread: true, unseen: true });
    expect(store.snapshot().threadMeta.viewed?.lastViewedUpdatedAt).toBeUndefined();

    const refreshedViewed = await app.inject({
      method: "POST",
      url: "/api/v1/threads/viewed/refresh",
      headers,
    });
    expect(refreshedViewed.statusCode).toBe(200);
    expect(refreshedViewed.json().detail.summary).toMatchObject({ unread: true, unseen: true });
    expect(store.snapshot().threadMeta.viewed?.lastViewedUpdatedAt).toBeUndefined();

    const viewedChanges = await app.inject({
      url: "/api/v1/threads/viewed/changes?cursor=cursor&anchorTurnId=turn&anchorRevision=revision",
      headers,
    });
    expect(viewedChanges.statusCode).toBe(200);
    expect(viewedChanges.json().summary).toMatchObject({ unread: true, unseen: true });
    expect(store.snapshot().threadMeta.viewed?.lastViewedUpdatedAt).toBeUndefined();

    const markedViewed = await app.inject({
      method: "PUT",
      url: "/api/v1/threads/viewed/viewed",
      headers,
      payload: { observedUpdatedAt: 2_000 },
    });
    expect(markedViewed.statusCode).toBe(204);
    expect(projection.summary("viewed")).toMatchObject({ unread: true, unseen: false });
    expect(store.snapshot().threadMeta.viewed?.lastViewedUpdatedAt).toBe(2_000);

    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/threads/viewed/viewed",
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/threads/missing/viewed",
          headers,
          payload: { observedUpdatedAt: 2_000 },
        })
      ).statusCode,
    ).toBe(404);

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

    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/threads/viewed/viewed",
          headers,
          payload: { observedUpdatedAt: 2_000 },
        })
      ).statusCode,
    ).toBe(204);
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
    projection.upsertThread({
      ...testThread("stale-empty"),
      cwd: "/work",
      preview: "",
      updatedAt: 3,
      recencyAt: 3,
    });
    await projection.markUnmaterialized("stale-empty");
    await store.update((state) => {
      const meta = state.threadMeta["stale-empty"]!;
      meta.managedTeamToolsAvailable = true;
      meta.sessionArtifactsVersion = 1;
    });
    bridge.missingRolloutThreadIds.add("stale-empty");
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
    expect(projection.summary("stale-empty")).toBeUndefined();
    expect(store.snapshot().threadMeta["stale-empty"]).toBeUndefined();
    expect(bridge.request).toHaveBeenCalledWith("thread/metadata/update", {
      threadId: "created",
      gitInfo: { sha: null },
    });
    expect(emptyCreated.json().thread.settings).toEqual({ collaborationMode: "plan" });
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/start").at(-1)?.[1],
    ).toMatchObject({ cwd: "/work", dynamicTools: expect.any(Array) });
    expect(bridge.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(
      turnsBeforeEmptyThread,
    );
    const disabledEmpty = await app.inject({
      method: "PATCH",
      url: "/api/v1/threads/created/settings",
      headers,
      payload: { collaborationMode: "default" },
    });
    expect(disabledEmpty.json().settings).toEqual({ collaborationMode: "default" });
    const resetEmpty = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project/threads",
      headers,
    });
    expect(resetEmpty.json().thread).toMatchObject({
      id: "created",
      settings: { collaborationMode: "plan" },
    });
    expect(bridge.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(
      threadStartsBeforeEmptyThread + 1,
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
          developerInstructions: expect.stringMatching(/standalone final deliverables/i),
        }),
        30_000,
      ],
      ["thread/metadata/update", { threadId: "created", gitInfo: { sha: null } }],
      [
        "thread/resume",
        expect.objectContaining({
          threadId: "created",
          config: { agents: { enabled: false } },
          developerInstructions: expect.stringMatching(/standalone final deliverables/i),
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
      collaborationMode: "plan",
      reasoningEffort: "high",
    });

    const resetPreference = await app.inject({
      method: "PATCH",
      url: "/api/v1/threads/thread/settings",
      headers,
      payload: { collaborationMode: "default", reasoningEffort: null },
    });
    expect(resetPreference.statusCode).toBe(200);
    expect(resetPreference.json().settings).toEqual({
      collaborationMode: "default",
      model: "gpt-a",
      serviceTier: "fast",
      personality: "friendly",
    });
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

    const userInputTransport = {
      respond: vi.fn(),
      respondError: vi.fn(),
    };
    const userInputRequest = attention.receive(
      {
        method: "item/tool/requestUserInput",
        id: 7,
        params: {
          threadId: "thread",
          turnId: "turn",
          itemId: "question",
          autoResolutionMs: null,
          questions: [
            {
              id: "transition",
              header: "Переходы",
              question: "Что делать с раскрытой веткой?",
              isOther: true,
              isSecret: false,
              options: [
                {
                  label: "Оставлять открытой",
                  description: "Сохранять состояние.",
                },
              ],
            },
          ],
        },
      } as ServerRequest,
      userInputTransport as unknown as JsonlTransport,
    );
    const steersBeforeUserInput = bridge.request.mock.calls.filter(
      ([method]) => method === "turn/steer",
    ).length;
    const queuedUserInput = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/queue",
      headers,
      payload: { input: "Закрывать автоматически", clientMessageId: "client-user-input" },
    });
    expect(queuedUserInput.statusCode).toBe(202);
    await vi.waitFor(() =>
      expect(userInputTransport.respond).toHaveBeenCalledWith(7, {
        answers: {
          transition: {
            answers: ["Закрывать автоматически"],
          },
        },
      }),
    );
    await vi.waitFor(() => expect(store.snapshot().messageQueues?.thread).toBeUndefined());
    expect(attention.list()).not.toContainEqual(
      expect.objectContaining({ id: userInputRequest.id }),
    );
    expect(bridge.request.mock.calls.filter(([method]) => method === "turn/steer")).toHaveLength(
      steersBeforeUserInput,
    );
    expect(store.snapshot().threadMeta.thread?.timelineArtifacts?.turn).toContainEqual(
      expect.objectContaining({
        type: "userInputResponse",
        entries: [
          expect.objectContaining({
            question: "Что делать с раскрытой веткой?",
            answers: ["Закрывать автоматически"],
          }),
        ],
      }),
    );
    const repeatedUserInputSend = await app.inject({
      method: "POST",
      url: `/api/v1/threads/thread/queue/${queuedUserInput.json().id}/send`,
      headers,
    });
    expect(repeatedUserInputSend.statusCode).toBe(200);
    expect(repeatedUserInputSend.json()).toEqual({ turnId: "turn" });

    const teamRoot = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project/threads",
      headers,
    });
    expect(teamRoot.statusCode).toBe(201);
    const teamThreadId = teamRoot.json().thread.id as string;
    const teamSettings = await app.inject({
      method: "PATCH",
      url: `/api/v1/threads/${teamThreadId}/settings`,
      headers,
      payload: {
        collaborationMode: "team",
        model: "gpt-a",
        reasoningEffort: "high",
      },
    });
    expect(teamSettings.statusCode).toBe(200);
    expect(teamSettings.json().settings).toEqual({
      collaborationMode: "team",
      model: "gpt-a",
      reasoningEffort: "high",
    });
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/resume").at(-1)?.[1],
    ).toMatchObject({
      config: { agents: { enabled: false } },
    });
    const teamThreadStart = bridge.request.mock.calls
      .filter(([method]) => method === "thread/start")
      .at(-1)?.[1] as {
      dynamicTools?: Array<{
        type: string;
        tools?: Array<{
          name: string;
          description: string;
          inputSchema: { properties?: Record<string, unknown> };
        }>;
      }>;
    };
    const teamCreated = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${teamThreadId}/turns`,
      headers,
      payload: { input: "Выполни многошаговый план" },
    });
    expect(teamCreated.statusCode).toBe(201);
    const managedTools = teamThreadStart.dynamicTools?.find(
      (candidate) => candidate.type === "namespace",
    )?.tools;
    for (const toolName of ["spawn_task", "followup_task"]) {
      const properties = managedTools?.find((candidate) => candidate.name === toolName)?.inputSchema
        .properties;
      expect(properties).toHaveProperty("reasoningEffort");
      expect(properties).not.toHaveProperty("model");
      expect(properties).not.toHaveProperty("tokenBudget");
      expect(properties).not.toHaveProperty("timeoutMinutes");
    }
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
            /may perform any part.*inspecting.*analyzing.*editing.*testing.*Delegate only.*materially useful.*codexnest managed-task tools.*never use native subagent tools.*smallest sufficient solution.*concrete, confirmed risk.*Before calling codexnest\.spawn_task.*necessary to achieve the user's original goal.*Honor an explicit user request.*main session.*Do not create managed tasks for optional improvements.*checks without a concrete target.*asks to stop or cancel subagents.*codexnest\.list_tasks.*codexnest\.cancel_task.*queued, starting, or running.*Do not create replacement tasks.*After every meaningful stage.*reassess the remaining plan.*only with steps that are still necessary.*Every test, command run, and checklist item.*specific product risk or an observed defect.*Omit it otherwise.*full conversation and complete plan only in the root coordinator's context.*only the single assigned plan step and the minimum task-specific context.*Never copy or summarize the conversation.*Once work is delegated.*do not duplicate the same scope.*fixed delay.*start, initial health check, sleep, and final inspection.*never wait in the parent.*codexnest\.inspect_task.*steer_task.*cancel_task.*prompts and steering messages in English.*task titles.*user's language/is,
          ),
        },
      },
    });
    const teamContext = (
      bridge.request.mock.calls.filter(([method]) => method === "turn/start").at(-1)?.[1] as {
        additionalContext?: Record<string, { value?: unknown }>;
      }
    ).additionalContext?.["codexnest.team"]?.value;
    expect(teamContext).toEqual(
      expect.stringMatching(
        /^This session is in CodexNest Team mode\..*Managed tasks are event-driven:.*automatically delivers its result and resumes this parent session\./s,
      ),
    );
    expect(teamContext).toEqual(
      expect.stringMatching(
        /Never keep the parent turn open.*queued or running.*never call tools merely to keep the turn alive.*finishing all independent parent work.*immediately finish the turn\./s,
      ),
    );
    expect(teamContext).toEqual(
      expect.stringMatching(
        /Never call sleep.*codexnest\.list_tasks.*codexnest\.inspect_task.*check whether a child is done.*waiting loop.*polling\./s,
      ),
    );
    expect(managedTools?.find((tool) => tool.name === "list_tasks")?.description).toMatch(
      /one-time snapshot.*explicit status request.*cancellation.*coordination decision.*Never use this tool to wait or poll.*completion automatically resumes the parent/i,
    );
    expect(managedTools?.find((tool) => tool.name === "inspect_task")?.description).toMatch(
      /explicit status request.*watchdog investigation.*corrective action.*terminal-result workspace review.*Never use this tool to monitor progress, wait, or poll.*completion automatically resumes the parent/i,
    );
    expect(teamContext).toEqual(
      expect.stringContaining(
        "set access.network to true in that case and leave it false for local-only work",
      ),
    );
    expect(teamContext).toEqual(
      expect.stringContaining("Never run parallel sharedWrite tasks whose write paths overlap"),
    );
    expect(teamContext).toEqual(
      expect.stringContaining("Parallel isolatedWrite tasks may edit overlapping files"),
    );
    expect(teamContext).toEqual(
      expect.stringContaining("codexnest.inspect_task to obtain workspacePath"),
    );
    const startsBeforeInvalidTeamGoal = bridge.request.mock.calls.filter(
      ([method]) => method === "turn/start",
    ).length;
    const invalidTeamGoal = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${teamThreadId}/turns`,
      headers,
      payload: {
        input: "Несовместимо",
        goal: true,
      },
    });
    expect(invalidTeamGoal.statusCode).toBe(409);
    expect(bridge.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(
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

    const steerWarning = vi.spyOn(app.log, "warn");
    const sentNow = await app.inject({
      method: "POST",
      url: `/api/v1/threads/thread/queue/${queued.json().id}/send`,
      headers,
    });
    expect(sentNow.statusCode).toBe(200);
    expect(sentNow.json()).toEqual({ turnId: "turn" });
    expect(queued.json().id).toBe("client-queued");
    expect(store.snapshot().messageQueues?.thread).toBeUndefined();
    expect(store.snapshot().messageReceipts?.["client-queued"]?.turnId).toBe("turn");
    expect(projection.summary("thread")?.currentTurnId).toBe("turn");
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "turn/steer").at(-1)?.[1],
    ).toMatchObject({
      clientUserMessageId: queued.json().id,
      input: [{ type: "text", text: "Исправленный текст", text_elements: [] }],
    });
    expect(activityEvents.at(-1)).toMatchObject({
      threadId: "thread",
      turnId: "turn",
      item: { type: "userMessage", id: "client-queued", text: "Исправленный текст" },
    });
    expect(steerWarning).toHaveBeenCalledTimes(1);
    expect(steerWarning).toHaveBeenCalledWith(
      { threadId: "thread", expectedTurnId: "turn", returnedTurnId: "steered" },
      "turn/steer returned an unexpected turn ID",
    );
    steerWarning.mockRestore();

    const queuedAfterSteer = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/queue",
      headers,
      payload: { input: "Продолжить после steering", clientMessageId: "client-after-steer" },
    });
    expect(queuedAfterSteer.statusCode).toBe(202);
    const startsBeforeSteeredCompletion = bridge.request.mock.calls.filter(
      ([method]) => method === "turn/start",
    ).length;
    bridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "thread", turn: testTurn("turn", "completed") },
    } satisfies ServerNotification);
    await vi.waitFor(() =>
      expect(bridge.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(
        startsBeforeSteeredCompletion + 1,
      ),
    );
    await vi.waitFor(() => expect(store.snapshot().messageQueues?.thread).toBeUndefined());
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "turn/start").at(-1)?.[1],
    ).toMatchObject({ clientUserMessageId: "client-after-steer" });

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
    expect(projection.summary("thread")?.currentTurnId).toBe("running");
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
      params: { threadId: "thread", turn: testTurn("running", "completed") },
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
      payload: {
        model: "gpt-a",
        titleModel: "gpt-b",
        serviceTier: "fast",
        personality: "friendly",
      },
    });
    expect(defaults.statusCode).toBe(200);
    expect(store.snapshot().taskDefaults).toEqual({
      model: "gpt-a",
      titleModel: "gpt-b",
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
      model: "gpt-a",
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
    expect(deleted.statusCode).toBe(404);
    expect(bridge.request).not.toHaveBeenCalledWith("thread/delete", { threadId: "thread" });
    expect(store.snapshot().threadMeta.thread).toBeDefined();
    await app.close();
  });

  it("saves validated active user-input drafts and rejects stale or incompatible requests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-user-input-draft-api-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.auth.tokenSha256 = hashToken("correct");
    });
    const bridge = new SettingsBridge();
    const attention = new AttentionManager();
    const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
    const app = await buildApp(
      loadConfig({
        statePath: store.path,
        clientDist: join(directory, "missing"),
        allowedOrigins: new Set(["http://localhost"]),
      }),
      { bridge: bridge as unknown as CodexBridge, store, projection, attention },
    );
    const headers = { authorization: "Bearer correct" };
    const userInput = attention.receive(
      {
        method: "item/tool/requestUserInput",
        id: 501,
        params: {
          threadId: "thread",
          turnId: "turn",
          itemId: "item",
          autoResolutionMs: null,
          questions: [
            {
              id: "choice",
              header: "Choice",
              question: "Which one?",
              isOther: true,
              isSecret: false,
              options: null,
            },
          ],
        },
      } as ServerRequest,
      { respond: vi.fn(), respondError: vi.fn() } as unknown as JsonlTransport,
    );

    const saved = await app.inject({
      method: "PUT",
      url: `/api/v1/attention/${userInput.id}/draft`,
      headers,
      payload: { answers: { choice: ["First"] }, currentQuestionId: "choice" },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      answers: { choice: ["First"] },
      currentQuestionId: "choice",
      revision: 1,
      updatedAt: expect.any(Number),
    });

    for (const payload of [
      { answers: { unknown: ["value"] }, currentQuestionId: null },
      { answers: { choice: [] }, currentQuestionId: null },
      { answers: { choice: ["   "] }, currentQuestionId: null },
      { answers: { choice: ["one", "two"] }, currentQuestionId: null },
      { answers: {}, currentQuestionId: "unknown" },
    ]) {
      expect(
        (
          await app.inject({
            method: "PUT",
            url: `/api/v1/attention/${userInput.id}/draft`,
            headers,
            payload,
          })
        ).statusCode,
      ).toBe(400);
    }

    attention.expireAll();
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/v1/attention/${userInput.id}/draft`,
          headers,
          payload: { answers: {}, currentQuestionId: null },
        })
      ).statusCode,
    ).toBe(409);
    const approval = attention.receive(
      {
        method: "item/commandExecution/requestApproval",
        id: 502,
        params: {
          threadId: "thread",
          turnId: "turn",
          itemId: "command",
          startedAtMs: 1,
          environmentId: null,
          command: "pwd",
          cwd: "/work",
        },
      } as ServerRequest,
      { respond: vi.fn(), respondError: vi.fn() } as unknown as JsonlTransport,
    );
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/v1/attention/${approval.id}/draft`,
          headers,
          payload: { answers: {}, currentQuestionId: null },
        })
      ).statusCode,
    ).toBe(409);
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
    const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
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
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_785_258_183_000 },
      secondary: {
        usedPercent: 40,
        windowDurationMins: 10_080,
        resetsAt: 1_785_344_583_000,
      },
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

describe("browser thread lifecycle", () => {
  it("requires explicit opt-in, rejects busy changes, rolls back attach, and fully disables", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-browser-api-test-"));
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
    const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
    await projection.sync();
    await projection.setSettings("thread", {
      collaborationMode: "team",
      model: "gpt-a",
      reasoningEffort: "high",
    });
    await store.update((state) => {
      state.threadMeta.thread!.managedTeamToolsAvailable = true;
    });
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
      },
    );
    await app.ready();
    projection.upsertThread({ ...testThread("native-child"), parentThreadId: "thread" });
    projection.upsertThread(testThread("archived-browser"), true);
    projection.upsertThread({ ...testThread("outside-project"), cwd: "/outside" });
    projection.upsertThread(testThread("managed-child"));
    await store.update((state) => {
      state.threadMeta["managed-child"] = {
        pinned: false,
        lastReadUpdatedAt: 0,
        managedParent: { parentThreadId: "thread", taskId: "task" },
      };
    });
    for (const threadId of [
      "native-child",
      "archived-browser",
      "outside-project",
      "managed-child",
    ]) {
      const rejected = await app.inject({
        method: "PATCH",
        url: `/api/v1/threads/${threadId}`,
        headers: { authorization: "Bearer correct" },
        payload: { browserEnabled: true },
      });
      expect(rejected.statusCode).toBe(409);
      expect(store.view().threadMeta[threadId]?.browserEnabled).toBeUndefined();
    }
    await store.update((state) => {
      state.threadMeta.thread!.browserBinding = {
        bindingId: "legacy-binding",
        instanceId: "extension-instance-1",
        attachedAt: 1,
      };
    });
    expect(projection.summary("thread")?.browserStatus).toBe("disabled");
    const socket = await app.injectWS(BROWSER_EXTENSION_WEBSOCKET_PATH, {
      headers: { origin: "http://localhost" },
    });
    const frames = websocketFrames(socket);
    socket.send(
      JSON.stringify({
        type: "client.hello",
        protocol: BROWSER_EXTENSION_PROTOCOL,
        version: BROWSER_EXTENSION_PROTOCOL_VERSION,
        token: "correct",
        instanceId: "extension-instance-1",
        extensionVersion: "0.1.6",
        browser: { name: "chrome", version: "128" },
        capabilities: {
          tools: BROWSER_TOOL_NAMES,
          maxProjectFileBytes: 100 * 1024 * 1024,
          screenshots: ["image/jpeg", "image/png"],
        },
        bindings: [],
      }),
    );
    await frames.nextType("server.hello");

    const invalidCombinedPatch = await app.inject({
      method: "PATCH",
      url: "/api/v1/threads/thread",
      headers: { authorization: "Bearer correct" },
      payload: { browserEnabled: true, pinned: "yes" },
    });
    expect(invalidCombinedPatch.statusCode).toBe(400);
    expect(store.view().threadMeta.thread?.browserEnabled).toBeUndefined();

    await projection.setCurrentTurn("thread", "busy-turn");
    const busyEnable = await app.inject({
      method: "PATCH",
      url: "/api/v1/threads/thread",
      headers: { authorization: "Bearer correct" },
      payload: { browserEnabled: true },
    });
    expect(busyEnable.statusCode).toBe(409);
    expect(store.view().threadMeta.thread?.browserEnabled).toBeUndefined();
    await projection.markInterrupted("thread", ["busy-turn"]);

    const enabled = await app.inject({
      method: "PATCH",
      url: "/api/v1/threads/thread",
      headers: { authorization: "Bearer correct" },
      payload: { browserEnabled: true },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({ browserStatus: "disconnected" });
    expect(store.view().threadMeta.thread?.browserEnabled).toBe(true);
    expect(store.view().threadMeta.thread?.browserBinding).toBeUndefined();
    expect(
      bridge.request.mock.calls.findLast(([method]) => method === "thread/resume")?.[1],
    ).not.toHaveProperty("config.mcp_servers");

    await projection.setCurrentTurn("thread", "busy-attach");
    socket.send(
      JSON.stringify({
        type: "session.request",
        requestId: "attach-busy",
        target: { kind: "existing", threadId: "thread" },
        tab: browserTabSummary(),
      }),
    );
    expect(await frames.nextType("session.error")).toMatchObject({
      requestId: "attach-busy",
      error: { code: "thread_busy" },
    });
    await projection.markInterrupted("thread", ["busy-attach"]);

    bridge.failBrowserResumeOnce = true;
    socket.send(
      JSON.stringify({
        type: "session.request",
        requestId: "attach-failed",
        target: { kind: "existing", threadId: "thread" },
        tab: browserTabSummary(),
      }),
    );
    expect(await frames.nextType("session.error")).toMatchObject({
      requestId: "attach-failed",
      error: expect.any(Object),
    });
    expect(store.view().threadMeta.thread?.browserBinding).toBeUndefined();
    const rollbackCalls = bridge.request.mock.calls
      .filter(([method]) => method === "thread/resume")
      .slice(-2);
    expect(rollbackCalls[0]?.[1]).toMatchObject({
      config: {
        agents: { enabled: false },
        mcp_servers: { codexnest_browser: expect.any(Object) },
      },
    });
    expect(rollbackCalls[1]?.[1]).toMatchObject({ config: { agents: { enabled: false } } });
    expect(rollbackCalls[1]?.[1]).not.toHaveProperty("config.mcp_servers");

    socket.send(
      JSON.stringify({
        type: "session.request",
        requestId: "attach-success",
        target: { kind: "existing", threadId: "thread" },
        tab: browserTabSummary(),
      }),
    );
    expect(await frames.nextType("session.result")).toMatchObject({
      requestId: "attach-success",
      action: "attached",
    });
    const binding = store.view().threadMeta.thread?.browserBinding;
    expect(binding).toMatchObject({ instanceId: "extension-instance-1" });
    expect(
      bridge.request.mock.calls.findLast(([method]) => method === "thread/resume")?.[1],
    ).toMatchObject({
      config: {
        agents: { enabled: false },
        mcp_servers: { codexnest_browser: expect.any(Object) },
      },
    });

    const turn = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/turns",
      headers: { authorization: "Bearer correct" },
      payload: { input: "Use the attached browser" },
    });
    expect(turn.statusCode).toBe(201);
    expect(
      bridge.request.mock.calls.findLast(([method]) => method === "thread/resume")?.[1],
    ).toMatchObject({
      config: {
        agents: { enabled: false },
        mcp_servers: { codexnest_browser: expect.any(Object) },
      },
    });
    const detached = await app.inject({
      method: "PATCH",
      url: "/api/v1/threads/thread",
      headers: { authorization: "Bearer correct" },
      payload: { browserEnabled: false },
    });
    expect(detached.statusCode).toBe(409);
    expect(store.view().threadMeta.thread?.browserEnabled).toBe(true);

    const interrupted = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/interrupt",
      headers: { authorization: "Bearer correct" },
      payload: { turnId: turn.json().turnId },
    });
    expect(interrupted.statusCode).toBe(204);

    const disabled = await app.inject({
      method: "DELETE",
      url: "/api/v1/threads/thread/browser-binding",
      headers: { authorization: "Bearer correct" },
    });
    expect(disabled.statusCode).toBe(204);
    expect(await frames.nextType("binding.detach")).toMatchObject({ threadId: "thread" });
    expect(store.view().threadMeta.thread?.browserBinding).toBeUndefined();
    expect(store.view().threadMeta.thread?.browserEnabled).toBeUndefined();
    expect(
      bridge.request.mock.calls.findLast(([method]) => method === "thread/resume")?.[1],
    ).toMatchObject({
      config: { agents: { enabled: false } },
    });
    expect(
      bridge.request.mock.calls.findLast(([method]) => method === "thread/resume")?.[1],
    ).not.toHaveProperty("config.mcp_servers");

    socket.send(
      JSON.stringify({
        type: "session.request",
        requestId: "create-fresh",
        target: { kind: "new", projectId: "project" },
        tab: browserTabSummary(),
      }),
    );
    expect(await frames.nextType("session.error")).toMatchObject({
      requestId: "create-fresh",
      error: { code: "unsupported" },
    });

    socket.terminate();
    await app.close();
  });
});

describe("explicit session artifacts", () => {
  it("does not reuse an old empty root that lacks the artifact tool", async () => {
    const { app, bridge, headers } = await createTeamHarness();
    const startsBefore = bridge.request.mock.calls.filter(
      ([method]) => method === "thread/start",
    ).length;

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project/threads",
      headers,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().thread.id).toBe("created");
    expect(bridge.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(
      startsBefore + 1,
    );
    await app.close();
  });

  it("attaches only to new roots and validates, persists, deduplicates, and lists files", async () => {
    const repository = await createApiTestRepository();
    await mkdir(join(repository, "deliverables"));
    await writeFile(join(repository, "deliverables", "report.txt"), "report\n");
    await writeFile(join(repository, "deliverables", "notes.txt"), "notes\n");
    const outside = await mkdtemp(join(tmpdir(), "codexnest-artifact-outside-"));
    directories.push(outside);
    await writeFile(join(outside, "secret.txt"), "secret\n");
    await symlink(join(outside, "secret.txt"), join(repository, "deliverables", "escape.txt"));

    const { app, bridge, headers, store } = await createTeamHarness({ projectPath: repository });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project/threads",
      headers,
    });
    expect(created.statusCode).toBe(201);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/v1/threads/created/settings",
          headers,
          payload: { collaborationMode: "team", model: "gpt-a", reasoningEffort: "high" },
        })
      ).statusCode,
    ).toBe(200);
    expect(store.snapshot().threadMeta.created).toMatchObject({
      managedTeamToolsAvailable: true,
      sessionArtifactsVersion: 1,
    });
    const rootStart = bridge.request.mock.calls
      .filter(
        ([method, params]) =>
          method === "thread/start" &&
          !String(params.threadSource).startsWith("codexnest-managed:"),
      )
      .at(-1)?.[1] as Record<string, unknown>;
    expect(rootStart.developerInstructions).toMatch(/standalone final deliverables/i);
    expect(
      (rootStart.dynamicTools as Array<{ tools: Array<{ name: string }> }>)[0]?.tools.map(
        (tool) => tool.name,
      ),
    ).toContain("publish_artifact");

    const clock = vi.spyOn(Date, "now").mockReturnValue(100);
    const first = dynamicToolJson(
      await callTeamTool(
        bridge,
        "created",
        "publish_artifact",
        { path: "deliverables/report.txt" },
        "publish-first",
        "turn-first",
      ),
    ).artifact as Record<string, unknown>;
    expect(first).toMatchObject({
      label: "report.txt",
      path: "deliverables/report.txt",
      turnId: "turn-first",
      createdAt: 100,
    });
    clock.mockReturnValue(200);
    await callTeamTool(bridge, "created", "publish_artifact", {
      path: join(repository, "deliverables", "notes.txt"),
      label: "Release notes",
    });
    clock.mockReturnValue(300);
    const republished = dynamicToolJson(
      await callTeamTool(
        bridge,
        "created",
        "publish_artifact",
        {
          path: "deliverables/report.txt",
          label: "Final report",
        },
        "publish-again",
        "turn-republish",
      ),
    ).artifact as Record<string, unknown>;
    clock.mockRestore();
    expect(republished).toMatchObject({
      id: first.id,
      label: "Final report",
      turnId: "turn-republish",
      createdAt: 300,
    });
    expect(store.snapshot().threadMeta.created?.sessionArtifacts).toEqual([
      expect.objectContaining({ id: first.id, path: "deliverables/report.txt" }),
      expect.objectContaining({ path: "deliverables/notes.txt" }),
    ]);

    for (const path of [
      "../secret.txt",
      "deliverables/missing.txt",
      "deliverables",
      "deliverables/escape.txt",
    ]) {
      const rejected = await callTeamTool(bridge, "created", "publish_artifact", { path });
      expect(rejected.success, path).toBe(false);
    }

    const listed = await app.inject({ url: "/api/v1/threads/created/artifacts", headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({
      capability: "explicit",
      artifacts: [
        expect.objectContaining({
          id: first.id,
          label: "Final report",
          path: await realpath(join(repository, "deliverables", "report.txt")),
        }),
        expect.objectContaining({
          label: "Release notes",
          path: await realpath(join(repository, "deliverables", "notes.txt")),
        }),
      ],
    });

    expect(
      (
        await callTeamTool(bridge, "thread", "publish_artifact", {
          path: "src/index.ts",
        })
      ).success,
    ).toBe(false);
    expect((await app.inject({ url: "/api/v1/threads/thread/artifacts", headers })).json()).toEqual(
      {
        capability: "unavailable",
        artifacts: [],
      },
    );

    const spawned = dynamicToolJson(
      await callTeamTool(bridge, "created", "spawn_task", {
        title: "Prepare supporting result",
        prompt: "Return a result without publishing it to the session.",
      }),
    );
    const childId = String(spawned.threadId);
    expect(
      (
        await callTeamTool(bridge, childId, "publish_artifact", {
          path: "deliverables/report.txt",
        })
      ).success,
    ).toBe(false);
    const childStart = bridge.request.mock.calls
      .filter(
        ([method, params]) =>
          method === "thread/start" && String(params.threadSource).startsWith("codexnest-managed:"),
      )
      .at(-1)?.[1] as { dynamicTools: Array<{ tools: Array<{ name: string }> }> };
    expect(childStart.dynamicTools[0]?.tools.map((tool) => tool.name)).toEqual(["submit_result"]);
    await callTeamTool(bridge, childId, "submit_result", {
      outcome: "success",
      summary: "Supporting result",
      artifacts: [{ label: "Team report", path: "deliverables/report.txt" }],
    });
    expect(store.snapshot().threadMeta.created?.sessionArtifacts).toHaveLength(2);

    await app.close();
  });
});

describe("Team orchestration", () => {
  it("reattaches an ambiguously created child by its durable source marker", async () => {
    const { app, bridge, store } = await createTeamHarness();
    const callId = "ambiguous-spawn-call";
    const operationKey = createHash("sha256")
      .update(`thread\0turn-thread\0${callId}\0spawn_task`)
      .digest("hex");
    const childThreadSource = `codexnest-managed:${operationKey.slice(0, 32)}`;
    bridge.managedThreads.push({
      ...testThread("recovered-managed"),
      threadSource: childThreadSource,
    });
    await store.update((state) => {
      state.teamToolOperations = {
        [operationKey]: {
          threadId: "thread",
          turnId: "turn-thread",
          callId,
          tool: "spawn_task",
          argumentsHash: createHash("sha256")
            .update('{"prompt":"Восстанови созданный child.","title":"Восстановить создание"}')
            .digest("hex"),
          status: "prepared",
          createdAt: 1,
          updatedAt: 1,
          taskId: "recovered-task",
          childThreadSource,
        },
      };
    });
    const response = dynamicToolJson(
      await callTeamTool(
        bridge,
        "thread",
        "spawn_task",
        {
          title: "Восстановить создание",
          prompt: "Восстанови созданный child.",
        },
        callId,
      ),
    );
    expect(response).toMatchObject({
      taskId: "recovered-task",
      threadId: "recovered-managed",
    });
    expect(bridge.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(
      0,
    );
    await app.close();
  });

  it("replays mutating tool calls without duplicating child threads or steering messages", async () => {
    const { app, bridge, store } = await createTeamHarness();
    const requestId = "stable-spawn-call";
    const args = {
      title: "Идемпотентная задача",
      prompt: "Проверь идемпотентность.",
    };
    const first = await callTeamTool(bridge, "thread", "spawn_task", args, requestId);
    const managedStartsAfterFirst = bridge.request.mock.calls.filter(
      ([method, params]) =>
        method === "thread/start" &&
        String((params as Record<string, unknown>).threadSource).startsWith("codexnest-managed:"),
    ).length;
    const replay = await callTeamTool(bridge, "thread", "spawn_task", args, requestId);
    expect(replay).toEqual(first);
    expect(
      bridge.request.mock.calls.filter(
        ([method, params]) =>
          method === "thread/start" &&
          String((params as Record<string, unknown>).threadSource).startsWith("codexnest-managed:"),
      ),
    ).toHaveLength(managedStartsAfterFirst);
    const conflict = await callTeamTool(
      bridge,
      "thread",
      "spawn_task",
      { ...args, prompt: "Другие аргументы." },
      requestId,
    );
    expect(conflict.success).toBe(false);

    const spawned = dynamicToolJson(first);
    await vi.waitFor(() =>
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
          ?.status,
      ).toBe("running"),
    );
    const steerArgs = { taskId: spawned.taskId, message: "Продолжай один раз." };
    const steer = await callTeamTool(
      bridge,
      "thread",
      "steer_task",
      steerArgs,
      "stable-steer-call",
    );
    const steerCount = bridge.request.mock.calls.filter(
      ([method]) => method === "turn/steer",
    ).length;
    const steerOperationKey = createHash("sha256")
      .update("thread\0turn-thread\0stable-steer-call\0steer_task")
      .digest("hex");
    await store.update((state) => {
      const operation = state.teamToolOperations?.[steerOperationKey];
      if (!operation) return;
      operation.status = "prepared";
      delete operation.response;
    });
    const steerReplay = await callTeamTool(
      bridge,
      "thread",
      "steer_task",
      steerArgs,
      "stable-steer-call",
    );
    expect(steerReplay).toEqual(steer);
    expect(bridge.request.mock.calls.filter(([method]) => method === "turn/steer")).toHaveLength(
      steerCount,
    );

    await app.close();
  });

  it("uses the durable receipt when the tool response transport is lost", async () => {
    const { app, bridge, store } = await createTeamHarness();
    const requestId = "lost-response-spawn";
    bridge.emit(
      "request",
      {
        method: "item/tool/call",
        id: requestId,
        params: {
          threadId: "thread",
          turnId: "turn-thread",
          callId: requestId,
          namespace: "codexnest",
          tool: "spawn_task",
          arguments: {
            title: "Ответ потерян",
            prompt: "Не создавай дубль после replay.",
          },
        },
      },
      {
        respond() {
          throw new Error("transport disconnected");
        },
        respondError() {
          throw new Error("transport disconnected");
        },
      },
    );
    await vi.waitFor(() =>
      expect(Object.values(store.snapshot().teamToolOperations ?? {})[0]?.status).toBe("applied"),
    );
    expect(
      Object.values(store.snapshot().threadMeta.thread?.teamOrchestration?.tasks ?? {}),
    ).toEqual([expect.objectContaining({ status: "queued" })]);

    const replay = await callTeamTool(
      bridge,
      "thread",
      "spawn_task",
      {
        title: "Ответ потерян",
        prompt: "Не создавай дубль после replay.",
      },
      requestId,
    );
    expect(replay.success).toBe(true);
    await vi.waitFor(() =>
      expect(
        Object.values(store.snapshot().threadMeta.thread?.teamOrchestration?.tasks ?? {})[0]
          ?.status,
      ).toBe("running"),
    );
    expect(bridge.managedThreads).toHaveLength(1);
    await app.close();
  });

  it("deduplicates replayed tool requests while reconnect recovery is pending", async () => {
    const { app, bridge, lifecycle, projection, store } = await createTeamHarness({
      lifecycle: true,
    });
    const requestId = "reconnect-spawn";
    const request = {
      method: "item/tool/call",
      id: requestId,
      params: {
        threadId: "thread",
        turnId: "turn-thread",
        callId: requestId,
        namespace: "codexnest",
        tool: "spawn_task",
        arguments: {
          title: "Replay после reconnect",
          prompt: "Создай ровно одну задачу.",
        },
      },
    };
    const staleRespond = vi.fn();
    let resolveResponse!: (response: TestDynamicToolResponse) => void;
    const response = new Promise<TestDynamicToolResponse>((resolve) => {
      resolveResponse = resolve;
    });
    bridge.emit("request", request, {
      respond: staleRespond,
      respondError: vi.fn(),
    });
    bridge.emit("request", request, {
      respond: (_id: string, result: TestDynamicToolResponse) => resolveResponse(result),
      respondError: (_id: string, _code: number, message: string) =>
        resolveResponse({
          success: false,
          contentItems: [{ type: "inputText", text: message }],
        }),
    });
    expect(bridge.managedThreads).toHaveLength(0);

    projection.emit("event", 3, { type: "resync.required" });
    expect((await response).success).toBe(true);
    await vi.waitFor(() =>
      expect(
        Object.values(store.snapshot().threadMeta.thread?.teamOrchestration?.tasks ?? {})[0]
          ?.status,
      ).toBe("running"),
    );
    expect(staleRespond).not.toHaveBeenCalled();
    expect(bridge.managedThreads).toHaveLength(1);
    expect(lifecycle?.state).toBe("ready");
    await app.close();
    await lifecycle?.close();
  });

  it("recovers starting tasks and delivered parent claims from durable Codex markers", async () => {
    const { app, bridge, projection, store } = await createTeamHarness();
    const spawned = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Восстановить задачу",
        prompt: "Проверь восстановление.",
      }),
    );
    await vi.waitFor(() =>
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
          ?.status,
      ).toBe("running"),
    );
    await store.update((state) => {
      const task = state.threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)];
      if (!task) return;
      task.status = "starting";
      delete task.childTurnId;
    });
    projection.emit("event", 0, { type: "resync.required" });
    await vi.waitFor(() =>
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)],
      ).toMatchObject({ status: "running", childTurnId: `turn-${String(spawned.threadId)}` }),
    );

    const claimId = "recovered-claim";
    const markerId = `codexnest-team-continuation:${claimId}`;
    await store.update((state) => {
      const task = state.threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)];
      if (!task) return;
      task.status = "completed";
      task.terminalTurnId = "child-terminal";
      task.result = { summary: "Готово", source: "submitted" };
      task.delivery = {
        status: "claimed",
        claimId,
        markerId,
        dispatchStartedAt: Date.now(),
      };
    });
    bridge.threadTurns.set("thread", [
      {
        ...testTurn("recovered-parent-turn", "completed"),
        itemsView: "full",
        items: [
          {
            type: "userMessage",
            id: "claim-marker",
            clientId: markerId,
            content: [{ type: "text", text: TEAM_MARKER_TEXT, text_elements: [] }],
          },
        ],
      },
    ]);
    const parentStarts = bridge.request.mock.calls.filter(
      ([method, params]) =>
        method === "turn/start" && (params as Record<string, unknown>).threadId === "thread",
    ).length;
    projection.emit("event", 1, { type: "resync.required" });
    await vi.waitFor(() =>
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
          ?.delivery,
      ).toMatchObject({ status: "delivered", parentTurnId: "recovered-parent-turn" }),
    );
    expect(
      store.snapshot().threadMeta.thread?.timelineArtifacts?.["recovered-parent-turn"]?.[0],
    ).toMatchObject({ afterItemId: null });
    expect(
      bridge.request.mock.calls.filter(
        ([method, params]) =>
          method === "turn/start" && (params as Record<string, unknown>).threadId === "thread",
      ),
    ).toHaveLength(parentStarts);
    await app.close();
  });

  it("serializes claim recovery with an in-flight parent continuation", async () => {
    const { app, bridge, projection, store } = await createTeamHarness();
    const spawned = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Deliver once",
        prompt: "Return one result.",
      }),
    );
    await vi.waitFor(() =>
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
          ?.status,
      ).toBe("running"),
    );
    await callTeamTool(bridge, String(spawned.threadId), "submit_result", {
      outcome: "success",
      summary: "One durable result",
    });

    let releaseParentStart!: () => void;
    bridge.parentTurnStartGate = new Promise<void>((resolve) => {
      releaseParentStart = resolve;
    });
    let markParentStartEntered!: () => void;
    const parentStartEntered = new Promise<void>((resolve) => {
      markParentStartEntered = resolve;
    });
    bridge.parentTurnStartEntered = markParentStartEntered;
    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: String(spawned.threadId),
        turn: {
          ...testTurn(`turn-${String(spawned.threadId)}`, "completed"),
          itemsView: "full",
        },
      },
    } satisfies ServerNotification);

    await parentStartEntered;
    expect(
      store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
        ?.delivery,
    ).toMatchObject({ status: "claimed" });
    projection.emit("event", 2, { type: "resync.required" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    bridge.parentTurnStartGate = null;
    releaseParentStart();
    await vi.waitFor(() =>
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
          ?.delivery,
      ).toMatchObject({ status: "delivered" }),
    );
    expect(
      bridge.request.mock.calls.filter(
        ([method, params]) =>
          method === "turn/start" && (params as Record<string, unknown>).threadId === "thread",
      ),
    ).toHaveLength(1);
    await app.close();
  });

  it("releases an ambiguous parent claim after the active parent turn finishes", async () => {
    const { app, bridge, projection, store } = await createTeamHarness();
    const spawned = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Не потерять результат",
        prompt: "Проверь восстановление claim.",
      }),
    );
    await vi.waitFor(() =>
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
          ?.status,
      ).toBe("running"),
    );
    await projection.setCurrentTurn("thread", "active-parent-turn");
    await store.update((state) => {
      const task = state.threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)];
      if (!task) return;
      task.status = "completed";
      task.terminalTurnId = "child-terminal";
      task.result = { summary: "Готово", source: "submitted" };
      task.delivery = {
        status: "claimed",
        claimId: "ambiguous-claim",
        markerId: "codexnest-team-claim:ambiguous-claim",
        dispatchStartedAt: Date.now(),
      };
    });

    projection.emit("event", 2, { type: "resync.required" });
    await vi.waitFor(() =>
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
          ?.delivery,
      ).toMatchObject({ status: "claimed" }),
    );
    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "thread",
        turn: testTurn("active-parent-turn", "completed"),
      },
    } satisfies ServerNotification);

    await vi.waitFor(() =>
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
          ?.delivery,
      ).toMatchObject({ status: "delivered" }),
    );
    expect(
      bridge.request.mock.calls.filter(
        ([method, params]) =>
          method === "turn/start" && (params as Record<string, unknown>).threadId === "thread",
      ),
    ).toHaveLength(1);
    await app.close();
  });

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
      outcome: "success",
      summary: "Интерфейс проверен",
      details: "Ошибок не обнаружено.",
    });
    expect(submitted.success).toBe(true);
    const startsBefore = bridge.request.mock.calls.filter(
      ([method]) => method === "turn/start",
    ).length;
    const firstChildTurnId =
      store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(firstResult.taskId)]
        ?.childTurnId;

    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: String(firstResult.threadId),
        turn: {
          ...testTurn(String(firstChildTurnId), "completed"),
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
      clientUserMessageId: expect.stringMatching(/^codexnest-team-claim:/),
      input: [{ type: "text", text: TEAM_MARKER_TEXT, text_elements: [] }],
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
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(firstResult.taskId)]
          ?.delivery,
      ).toMatchObject({ status: "delivered" }),
    );
    expect(
      store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(secondResult.taskId)],
    ).toMatchObject({ status: "running" });
    await vi.waitFor(() =>
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
      ]),
    );
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
        turn: testTurn(String(firstChildTurnId), "completed"),
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
    const childTurnId =
      store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
        ?.childTurnId;
    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: String(spawned.threadId),
        turn: {
          ...testTurn(String(childTurnId), "completed"),
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

  it("runs ten child tasks and starts the eleventh from the FIFO queue", async () => {
    const { app, bridge, store } = await createTeamHarness();
    const spawned = [];
    for (let index = 1; index <= 11; index += 1) {
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
      expect(Object.values(tasks).filter((task) => task.status === "running")).toHaveLength(10);
      expect(tasks[String(spawned[10]!.taskId)]?.status).toBe("queued");
    });
    const firstTurnId =
      store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned[0]!.taskId)]
        ?.childTurnId;

    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: String(spawned[0]!.threadId),
        turn: {
          ...testTurn(String(firstTurnId), "completed"),
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
      expect(tasks[String(spawned[10]!.taskId)]?.status).toBe("running");
    });
    const childStarts = bridge.request.mock.calls.filter(
      ([method, params]) =>
        method === "turn/start" &&
        String((params as Record<string, unknown>).threadId) !== "thread",
    );
    expect(childStarts).toHaveLength(11);
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

  it("stops a completed Team orchestration without interrupting managed children", async () => {
    const { app, bridge, headers, projection, store } = await createTeamHarness();
    const spawned = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Долгая задача",
        prompt: "Выполни долгую задачу.",
      }),
    );
    await vi.waitFor(() =>
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
          ?.status,
      ).toBe("running"),
    );
    await store.update((state) => {
      const task = state.threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)];
      if (!task) return;
      task.status = "completed";
      task.terminalTurnId = "child-terminal";
      task.result = { summary: "Готово", source: "submitted" };
    });
    expect(projection.summary("thread")).toMatchObject({
      state: "running",
      currentTurnId: null,
    });

    const stopped = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/interrupt",
      headers,
      payload: {},
    });

    expect(stopped.statusCode).toBe(204);
    expect(store.snapshot().threadMeta.thread?.teamOrchestration).toBeUndefined();
    expect(
      bridge.request.mock.calls.some(
        ([method, params]) =>
          method === "turn/interrupt" &&
          (params as Record<string, unknown>).threadId === spawned.threadId,
      ),
    ).toBe(false);
    expect(projection.summary("thread")).toMatchObject({
      state: "interrupted",
      currentTurnId: null,
    });
    await app.close();
    await store.flushed();
  });

  it("keeps Team enabled until the root agent cancels and processes running subagents", async () => {
    const { app, bridge, headers, projection, store } = await createTeamHarness();
    const spawned = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Остановить по запросу",
        prompt: "Жди команды главного агента.",
      }),
    );
    await vi.waitFor(() =>
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
          ?.status,
      ).toBe("running"),
    );
    await projection.setCurrentTurn("thread", "parent-running");

    const stopped = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/interrupt",
      headers,
      payload: { turnId: "parent-running" },
    });
    expect(stopped.statusCode).toBe(204);
    expect(
      store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]?.status,
    ).toBe("running");
    expect(
      bridge.request.mock.calls.some(
        ([method, params]) =>
          method === "turn/interrupt" &&
          (params as Record<string, unknown>).threadId === spawned.threadId,
      ),
    ).toBe(false);

    const blocked = await app.inject({
      method: "PATCH",
      url: "/api/v1/threads/thread/settings",
      headers,
      payload: { collaborationMode: "default" },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({
      error: {
        code: "conflict",
        message:
          "Нельзя выключить Team, пока субагенты работают или их результаты ещё не обработаны. Попросите главного агента завершить или отменить их.",
      },
    });
    expect(projection.summary("thread")?.settings.collaborationMode).toBe("team");

    expect(
      (
        await callTeamTool(bridge, "thread", "cancel_task", {
          taskId: spawned.taskId,
          reason: "Пользователь попросил остановить субагентов",
        })
      ).success,
    ).toBe(true);
    const processed = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/turns",
      headers,
      payload: { input: "Останови субагентов" },
    });
    expect(processed.statusCode).toBe(201);
    expect(store.snapshot().threadMeta.thread?.teamOrchestration).toBeUndefined();

    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "thread",
        turn: testTurn(String(processed.json().turnId), "completed"),
      },
    } satisfies ServerNotification);
    await vi.waitFor(() => expect(projection.summary("thread")?.currentTurnId).toBeNull());

    const disabled = await app.inject({
      method: "PATCH",
      url: "/api/v1/threads/thread/settings",
      headers,
      payload: { collaborationMode: "default" },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().settings.collaborationMode).toBe("default");
    await app.close();
    await store.flushed();
  });

  it("keeps stopped Team state while workspace work still needs a decision", async () => {
    const { app, bridge, headers, store } = await createTeamHarness();
    const spawned = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Preserve isolated changes",
        prompt: "Prepare an isolated change.",
      }),
    );
    const cleanup = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Retry workspace cleanup",
        prompt: "Wait for cleanup recovery.",
      }),
    );
    await vi.waitFor(() =>
      expect(
        Object.values(store.snapshot().threadMeta.thread?.teamOrchestration?.tasks ?? {}).map(
          (task) => task.status,
        ),
      ).toEqual(["running", "running"]),
    );
    await store.update((state) => {
      const task = state.threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)];
      if (!task) return;
      task.status = "completed";
      task.terminalTurnId = String(task.childTurnId);
      task.result = { outcome: "success", summary: "Change prepared.", source: "submitted" };
      task.workspace = {
        lifecycle: "ready",
        repositoryRoot: "/work",
        gitCommonDir: "/work/.git",
        worktreePath: `/work/.git/codexnest/worktrees/${String(spawned.taskId)}`,
        head: "a".repeat(40),
        baseline: {},
        changedPaths: ["src/change.ts"],
        createdAt: 1,
        updatedAt: 2,
      };
      const cleanupTask = state.threadMeta.thread?.teamOrchestration?.tasks[String(cleanup.taskId)];
      if (!cleanupTask) return;
      cleanupTask.status = "completed";
      cleanupTask.terminalTurnId = String(cleanupTask.childTurnId);
      cleanupTask.result = { outcome: "success", summary: "Integrated.", source: "submitted" };
      cleanupTask.workspace = {
        lifecycle: "integrated",
        repositoryRoot: "/work",
        gitCommonDir: "/work/.git",
        worktreePath: `/work/.git/codexnest/worktrees/${String(cleanup.taskId)}`,
        head: "b".repeat(40),
        baseline: {},
        error: "cleanup pending",
        createdAt: 1,
        updatedAt: 2,
      };
    });

    const stopped = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/interrupt",
      headers,
      payload: {},
    });

    expect(stopped.statusCode).toBe(204);
    expect(
      store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
        ?.workspace,
    ).toMatchObject({ lifecycle: "ready", changedPaths: ["src/change.ts"] });
    expect(
      store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(cleanup.taskId)]
        ?.workspace,
    ).toMatchObject({ lifecycle: "integrated", error: "cleanup pending" });
    await app.close();
    await store.flushed();
  });

  it("enforces Team task settings and preserves structured results", async () => {
    const { app, bridge, store } = await createTeamHarness();
    const unsafeWriteRoot = await callTeamTool(bridge, "thread", "spawn_task", {
      title: "Unsafe Git metadata write",
      prompt: "Do not start.",
      access: { mode: "sharedWrite", writePaths: ["src/.GiT/config"] },
    });
    expect(unsafeWriteRoot.success).toBe(false);
    expect(unsafeWriteRoot.contentItems[0]?.text).toContain(
      "Unsafe repository-relative write path",
    );
    const spawned = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Read-only audit",
        prompt: "Inspect the current implementation.",
        access: { mode: "readOnly", network: false },
        reasoningEffort: "high",
        serviceTier: "fast",
      }),
    );
    await vi.waitFor(() => {
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
          ?.status,
      ).toBe("running");
    });
    const childStart = bridge.request.mock.calls.find(
      ([method, params]) =>
        method === "turn/start" &&
        (params as Record<string, unknown>).threadId === spawned.threadId,
    )?.[1];
    expect(childStart).toMatchObject({
      cwd: "/work",
      runtimeWorkspaceRoots: ["/work"],
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      model: "gpt-5.6-sol",
      effort: "high",
      serviceTier: "fast",
    });
    const childThreadStart = bridge.request.mock.calls.find(
      ([method, params]) =>
        method === "thread/start" &&
        String((params as Record<string, unknown>).threadSource).startsWith("codexnest-managed:"),
    )?.[1];
    expect(childThreadStart).toMatchObject({ model: "gpt-5.6-sol", serviceTier: "fast" });
    const childResume = bridge.request.mock.calls.find(
      ([method, params]) =>
        method === "thread/resume" &&
        (params as Record<string, unknown>).threadId === spawned.threadId,
    )?.[1];
    expect(childResume).toMatchObject({ model: "gpt-5.6-sol", serviceTier: "fast" });

    const submitted = await callTeamTool(bridge, String(spawned.threadId), "submit_result", {
      outcome: "success",
      summary: "Audit complete",
      details: "No defects found.",
      checks: [{ name: "server tests", outcome: "passed" }],
      risks: ["None observed"],
      artifacts: [{ label: "Reference", url: "https://example.com/result" }],
    });
    expect(submitted.success).toBe(true);
    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: String(spawned.threadId),
        turn: { ...testTurn(`turn-${String(spawned.threadId)}`, "completed"), itemsView: "full" },
      },
    } satisfies ServerNotification);
    await vi.waitFor(() => {
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
          ?.result,
      ).toMatchObject({
        outcome: "success",
        summary: "Audit complete",
        checks: [{ name: "server tests", outcome: "passed" }],
        risks: ["None observed"],
        artifacts: [{ label: "Reference", url: "https://example.com/result" }],
      });
    });
    const listed = dynamicToolJson(await callTeamTool(bridge, "thread", "list_tasks", {}));
    expect(listed.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: spawned.taskId,
          access: { mode: "readOnly", network: false },
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
        }),
      ]),
    );
    expect((listed.tasks as Array<Record<string, unknown>>)[0]).not.toHaveProperty("tokenBudget");
    expect((listed.tasks as Array<Record<string, unknown>>)[0]).not.toHaveProperty(
      "timeoutMinutes",
    );
    await app.close();
    await store.flushed();
  });

  it("rejects unsupported managed-child effort before creating a thread", async () => {
    const { app, bridge } = await createTeamHarness();

    const response = await callTeamTool(bridge, "thread", "spawn_task", {
      title: "Unsupported effort",
      prompt: "Do not start.",
      reasoningEffort: "low",
    });

    expect(response.success).toBe(false);
    expect(response.contentItems[0]?.text).toContain(
      "The requested reasoning effort is unavailable",
    );
    expect(bridge.managedThreads).toHaveLength(0);
    await app.close();
  });

  it("rejects managed tasks when gpt-5.6-sol is unavailable", async () => {
    const { app, bridge } = await createTeamHarness({ includeManagedModel: false });

    const response = await callTeamTool(bridge, "thread", "spawn_task", {
      title: "Missing fixed model",
      prompt: "Do not start.",
    });

    expect(response.success).toBe(false);
    expect(response.contentItems[0]?.text).toContain(
      "The required managed-task model gpt-5.6-sol is unavailable",
    );
    expect(bridge.managedThreads).toHaveLength(0);
    await app.close();
  });

  it("blocks isolated integration while a shared-write task is active", async () => {
    const repository = await createApiTestRepository();
    const { app, bridge, store } = await createTeamHarness({
      projectPath: repository,
    });
    const isolated = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Prepare isolated change",
        prompt: "Change src/index.ts.",
        access: { mode: "isolatedWrite", writePaths: ["src"] },
      }),
    );
    const shared = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Update shared files",
        prompt: "Work in the parent repository.",
        access: { mode: "sharedWrite", writePaths: ["src"] },
      }),
    );
    await vi.waitFor(() => {
      const tasks = store.snapshot().threadMeta.thread?.teamOrchestration?.tasks ?? {};
      expect(tasks[String(isolated.taskId)]?.workspace).toBeTruthy();
      expect(tasks[String(shared.taskId)]?.status).toBe("running");
    });
    await store.update((state) => {
      const task = state.threadMeta.thread?.teamOrchestration?.tasks[String(isolated.taskId)];
      if (!task) return;
      task.status = "completed";
      task.terminalTurnId = String(task.childTurnId);
      task.result = { outcome: "success", summary: "Change ready.", source: "submitted" };
    });

    const response = await callTeamTool(bridge, "thread", "integrate_task", {
      taskId: isolated.taskId,
    });
    expect(response.success).toBe(false);
    expect(response.contentItems[0]?.text).toContain(
      `Wait for shared-write task Update shared files [${String(shared.taskId)}]`,
    );
    expect(
      store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(isolated.taskId)]
        ?.workspace?.lifecycle,
    ).not.toBe("integrating");
    await app.close();
    await store.flushed();
  });

  it("exposes overlapping isolated workspaces for sequential root-side synthesis", async () => {
    const repository = await createApiTestRepository();
    const { app, bridge, store } = await createTeamHarness({
      projectPath: repository,
    });
    const first = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "First isolated approach",
        prompt: "Change src/index.ts using the first approach.",
        access: { mode: "isolatedWrite", writePaths: ["src"] },
      }),
    );
    const second = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Second isolated approach",
        prompt: "Change src/index.ts using the second approach.",
        access: { mode: "isolatedWrite", writePaths: ["src"] },
      }),
    );
    await vi.waitFor(() => {
      const tasks = store.snapshot().threadMeta.thread?.teamOrchestration?.tasks ?? {};
      expect(tasks[String(first.taskId)]?.status).toBe("running");
      expect(tasks[String(second.taskId)]?.status).toBe("running");
      expect(tasks[String(first.taskId)]?.workspace?.worktreePath).toBeTruthy();
      expect(tasks[String(second.taskId)]?.workspace?.worktreePath).toBeTruthy();
    });
    const tasks = store.snapshot().threadMeta.thread?.teamOrchestration?.tasks ?? {};
    const firstWorkspace = tasks[String(first.taskId)]?.workspace;
    const secondWorkspace = tasks[String(second.taskId)]?.workspace;
    if (!firstWorkspace || !secondWorkspace) throw new Error("Expected isolated workspaces");
    expect(firstWorkspace.worktreePath).not.toBe(secondWorkspace.worktreePath);

    await writeFile(join(firstWorkspace.worktreePath, "src", "index.ts"), "first approach\n");
    await writeFile(join(secondWorkspace.worktreePath, "src", "index.ts"), "second approach\n");
    await store.update((state) => {
      for (const taskId of [String(first.taskId), String(second.taskId)]) {
        const task = state.threadMeta.thread?.teamOrchestration?.tasks[taskId];
        if (!task) continue;
        task.status = "completed";
        task.terminalTurnId = String(task.childTurnId);
        task.result = { outcome: "success", summary: "Approach ready.", source: "submitted" };
      }
    });

    expect(
      (
        await callTeamTool(bridge, "thread", "integrate_task", {
          taskId: first.taskId,
        })
      ).success,
    ).toBe(true);
    const conflicting = await callTeamTool(bridge, "thread", "integrate_task", {
      taskId: second.taskId,
    });
    expect(conflicting.success).toBe(false);
    expect(conflicting.contentItems[0]?.text).toContain("parent workspace changed");

    const inspected = dynamicToolJson(
      await callTeamTool(bridge, "thread", "inspect_task", { taskId: second.taskId }),
    );
    expect(inspected.workspacePath).toBe(secondWorkspace.worktreePath);
    expect(inspected.workspace).toMatchObject({
      lifecycle: "conflicted",
      conflictPaths: ["src/index.ts"],
    });

    await writeFile(join(repository, "src", "index.ts"), "merged first and second approaches\n");
    expect(
      (
        await callTeamTool(bridge, "thread", "discard_task_changes", {
          taskId: second.taskId,
        })
      ).success,
    ).toBe(true);
    await expect(readFile(join(repository, "src", "index.ts"), "utf8")).resolves.toBe(
      "merged first and second approaches\n",
    );
    await app.close();
    await store.flushed();
  });

  it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
    "keeps failed integrated-workspace cleanup retryable",
    async () => {
      const repository = await createApiTestRepository();
      const workspace = await createTeamWorkspace(repository, "cleanup recovery");
      const { app, headers, projection, store } = await createTeamHarness({
        projectPath: repository,
      });
      await store.update((state) => {
        state.threadMeta.thread!.teamOrchestration = {
          tasks: {
            cleanup: {
              id: "cleanup",
              parentThreadId: "thread",
              childThreadId: "managed-cleanup",
              childThreadSource: "codexnest-managed:cleanup",
              title: "Cleanup integrated workspace",
              prompt: "Cleanup only.",
              status: "completed",
              createdAt: 1,
              startedAt: 2,
              lastActivityAt: 3,
              completedAt: 3,
              terminalTurnId: "managed-cleanup-turn",
              result: { outcome: "success", summary: "Integrated.", source: "submitted" },
              workspace: {
                ...workspace,
                lifecycle: "integrated",
                error: "cleanup pending",
                createdAt: 1,
                updatedAt: 1,
              },
            },
          },
        };
      });

      const gitDirectory = join(repository, ".git");
      await chmod(gitDirectory, 0o000);
      try {
        projection.emit("event", 101, { type: "resync.required" });
        await vi.waitFor(() => {
          const recovered =
            store.snapshot().threadMeta.thread?.teamOrchestration?.tasks.cleanup?.workspace;
          expect(recovered?.lifecycle).toBe("integrated");
          expect(recovered?.error).toBeTruthy();
          expect(recovered?.error).not.toBe("cleanup pending");
        });
      } finally {
        await chmod(gitDirectory, 0o700);
      }

      const deletion = await app.inject({
        method: "DELETE",
        url: "/api/v1/threads/thread",
        headers,
      });
      expect(deletion.statusCode).toBe(404);
      const disableTeam = await app.inject({
        method: "PATCH",
        url: "/api/v1/threads/thread/settings",
        headers,
        payload: { collaborationMode: "default" },
      });
      expect(disableTeam.statusCode).toBe(409);
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks.cleanup?.workspace,
      ).toMatchObject({ lifecycle: "integrated", error: expect.any(String) });

      projection.emit("event", 102, { type: "resync.required" });
      await vi.waitFor(() =>
        expect(
          store.snapshot().threadMeta.thread?.teamOrchestration?.tasks.cleanup?.workspace,
        ).toMatchObject({ lifecycle: "integrated", error: undefined }),
      );
      await expect(access(workspace.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
      await app.close();
      await store.flushed();
    },
  );

  it("removes implicit temporary-directory writes from isolated child sandboxes", async () => {
    const repository = await createApiTestRepository();
    const { app, bridge, store } = await createTeamHarness({
      projectPath: repository,
    });
    const spawned = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Scoped temporary repository write",
        prompt: "Edit only src.",
        access: { mode: "isolatedWrite", writePaths: ["src"] },
      }),
    );
    await vi.waitFor(() =>
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
          ?.status,
      ).toBe("running"),
    );
    const workspace =
      store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
        ?.workspace;
    if (!workspace) throw new Error("Expected an isolated Team workspace");
    for (const name of [".agents", ".codex"]) {
      expect((await lstat(join(workspace.worktreePath, name))).isDirectory()).toBe(true);
      await expect(access(join(repository, name))).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(computeTeamWorkspaceDelta(workspace)).resolves.toEqual({
      changedPaths: [],
      changes: [],
    });
    const childTurnStart = bridge.request.mock.calls.find(
      ([method, params]) =>
        method === "turn/start" &&
        (params as Record<string, unknown>).threadId === spawned.threadId,
    )?.[1];
    expect(childTurnStart).toMatchObject({
      sandboxPolicy: {
        type: "workspaceWrite",
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
    });
    await app.close();
    await store.flushed();
  });

  it("recreates sandbox mountpoints when an isolated workspace is reused", async () => {
    const repository = await createApiTestRepository();
    const { app, bridge, store } = await createTeamHarness({
      projectPath: repository,
    });
    const first = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Prepare a reusable isolated change",
        prompt: "Edit src/index.ts.",
        access: { mode: "isolatedWrite", writePaths: ["src"] },
      }),
    );
    await vi.waitFor(() =>
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(first.taskId)]?.status,
      ).toBe("running"),
    );
    const running =
      store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(first.taskId)];
    if (!running?.workspace || !running.childTurnId) {
      throw new Error("Expected a running task with an isolated workspace");
    }
    await writeFile(
      join(running.workspace.worktreePath, "src", "index.ts"),
      "export const value = 2;\n",
    );
    await callTeamTool(bridge, String(first.threadId), "submit_result", {
      outcome: "success",
      summary: "Change prepared.",
    });
    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: String(first.threadId),
        turn: { ...testTurn(running.childTurnId, "completed"), itemsView: "full" },
      },
    } satisfies ServerNotification);
    await vi.waitFor(() => {
      const completed =
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(first.taskId)];
      expect(completed?.status).toBe("completed");
      expect(completed?.delivery?.status).toBe("delivered");
      expect(completed?.workspace?.lifecycle).toBe("ready");
    });

    for (const name of [".agents", ".codex"]) {
      await rm(join(running.workspace.worktreePath, name), { recursive: true });
    }
    const followup = dynamicToolJson(
      await callTeamTool(bridge, "thread", "followup_task", {
        taskId: first.taskId,
        prompt: "Continue in the existing workspace.",
      }),
    );
    await vi.waitFor(() =>
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(followup.taskId)]
          ?.status,
      ).toBe("running"),
    );
    const reused =
      store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(followup.taskId)]
        ?.workspace;
    expect(reused?.worktreePath).toBe(running.workspace.worktreePath);
    for (const name of [".agents", ".codex"]) {
      expect((await lstat(join(running.workspace.worktreePath, name))).isDirectory()).toBe(true);
    }
    await app.close();
    await store.flushed();
  });

  it("tracks Team task usage without enforcing retired token or time budgets", async () => {
    const { app, bridge, store } = await createTeamHarness();
    const taskResult = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Unbounded task",
        prompt: "Inspect briefly.",
        // Simulate a stale caller that still sends retired fields. Production tool schemas reject
        // these additional properties, and the handler must never turn them into hard limits.
        tokenBudget: 10,
        timeoutMinutes: 1,
      }),
    );
    await vi.waitFor(() => {
      const task =
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(taskResult.taskId)];
      expect(task?.status).toBe("running");
      expect(task).not.toHaveProperty("tokenBudget");
      expect(task).not.toHaveProperty("timeoutMinutes");
    });
    const usage = {
      totalTokens: 10,
      inputTokens: 6,
      cachedInputTokens: 0,
      outputTokens: 4,
      reasoningOutputTokens: 0,
    };
    bridge.failInterrupts = 1;
    bridge.emit("notification", {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: String(taskResult.threadId),
        turnId: `turn-${String(taskResult.threadId)}`,
        tokenUsage: { total: usage, last: usage, modelContextWindow: 100_000 },
      },
    } satisfies ServerNotification);
    await vi.waitFor(() => {
      const task =
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(taskResult.taskId)];
      expect(task?.tokensUsed).toBe(10);
      expect(task).not.toHaveProperty("budgetReason");
    });
    expect(
      bridge.request.mock.calls.filter(
        ([method, params]) =>
          method === "turn/interrupt" &&
          (params as Record<string, unknown>).threadId === taskResult.threadId,
      ),
    ).toHaveLength(0);

    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: String(taskResult.threadId),
        turn: {
          ...testTurn(`turn-${String(taskResult.threadId)}`, "completed"),
          itemsView: "full",
        },
      },
    } satisfies ServerNotification);
    await vi.waitFor(() => {
      const task =
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(taskResult.taskId)];
      expect(task?.result).toMatchObject({
        outcome: "success",
        summary: "Managed task completed without an agent message.",
      });
      expect(task?.failureReason).toBeUndefined();
    });
    await app.close();
    await store.flushed();
  });

  it("waits for delivered dependencies and reuses a child thread for follow-up work", async () => {
    const { app, bridge, projection, store } = await createTeamHarness();
    const first = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Inspect API",
        prompt: "Inspect the API.",
      }),
    );
    const dependent = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Use inspection",
        prompt: "Use the completed inspection.",
        dependsOn: [first.taskId],
      }),
    );
    await vi.waitFor(() => {
      const tasks = store.snapshot().threadMeta.thread?.teamOrchestration?.tasks ?? {};
      expect(tasks[String(first.taskId)]?.status).toBe("running");
      expect(tasks[String(dependent.taskId)]?.status).toBe("queued");
    });

    await callTeamTool(bridge, String(first.threadId), "submit_result", {
      outcome: "success",
      summary: "Inspection complete",
    });
    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: String(first.threadId),
        turn: { ...testTurn(`turn-${String(first.threadId)}`, "completed"), itemsView: "full" },
      },
    } satisfies ServerNotification);
    await vi.waitFor(() => {
      const tasks = store.snapshot().threadMeta.thread?.teamOrchestration?.tasks ?? {};
      expect(tasks[String(first.taskId)]?.delivery?.status).toBe("delivered");
      expect(tasks[String(dependent.taskId)]?.status).toBe("running");
    });

    const childStartsBeforeFollowup = bridge.request.mock.calls.filter(
      ([method]) => method === "thread/start",
    ).length;
    const followup = dynamicToolJson(
      await callTeamTool(bridge, "thread", "followup_task", {
        taskId: first.taskId,
        prompt: "Clarify one point from the inspection.",
      }),
    );
    expect(followup).toMatchObject({ threadId: first.threadId });
    expect(followup.taskId).not.toBe(first.taskId);
    await vi.waitFor(() => {
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(followup.taskId)]
          ?.status,
      ).toBe("running");
    });
    expect(bridge.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(
      childStartsBeforeFollowup,
    );

    const tasks = store.snapshot().threadMeta.thread?.teamOrchestration?.tasks ?? {};
    const predecessorTurnId = tasks[String(first.taskId)]?.childTurnId;
    const followupTurnId = tasks[String(followup.taskId)]?.childTurnId;
    expect(predecessorTurnId).toBe(`turn-${String(first.threadId)}`);
    expect(followupTurnId).toBe(`turn-${String(first.threadId)}-2`);

    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: String(first.threadId),
        turn: { ...testTurn(String(predecessorTurnId), "completed"), itemsView: "full" },
      },
    } satisfies ServerNotification);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await store.flushed();
    expect(
      store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(followup.taskId)],
    ).toMatchObject({ status: "running", childTurnId: followupTurnId });

    await projection.markInterrupted(String(first.threadId), [String(followupTurnId)]);
    await store.update((state) => {
      const current = state.threadMeta.thread?.teamOrchestration?.tasks[String(followup.taskId)];
      if (!current) return;
      current.status = "starting";
      delete current.childTurnId;
      delete current.startedAt;
    });
    bridge.threadTurns.set(String(first.threadId), [
      {
        ...testTurn(String(predecessorTurnId), "completed"),
        itemsView: "full",
        items: [],
      },
    ]);
    projection.emit("event", 20, { type: "resync.required" });
    await vi.waitFor(() => {
      const recovered =
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(followup.taskId)];
      expect(recovered?.status).toBe("running");
      expect(recovered?.childTurnId).not.toBe(predecessorTurnId);
      expect(recovered?.result).toBeUndefined();
    });
    await app.close();
    await store.flushed();
  });

  it("pauses the watchdog while a managed child uses the built-in sleep tool", async () => {
    const { app, bridge, store } = await createTeamHarness();
    const spawned = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Проверить результат через час",
        prompt: "Запусти скрипт и проверь результат через час.",
      }),
    );
    await vi.waitFor(() => {
      const task =
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)];
      expect(task?.status).toBe("running");
    });

    const childStart = bridge.request.mock.calls.find(
      ([method, params]) =>
        method === "thread/start" &&
        String((params as Record<string, unknown>).threadSource).startsWith("codexnest-managed:"),
    );
    expect(childStart?.[1]).toMatchObject({
      developerInstructions: expect.stringMatching(
        /fixed delay.*asynchronously.*startup check.*built-in sleep tool once.*remaining time.*submit_result with outcome/is,
      ),
    });

    const startedAt = Date.now();
    bridge.emit("notification", {
      method: "item/started",
      params: {
        threadId: String(spawned.threadId),
        turnId: `turn-${String(spawned.threadId)}`,
        item: { type: "sleep", id: "sleep", durationMs: 60 * 60_000 },
        startedAtMs: startedAt,
      },
    } satisfies ServerNotification);

    await vi.waitFor(() =>
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
          ?.expectedWakeAt,
      ).toBe(startedAt + 60 * 60_000),
    );
    await expect(triggerTeamWatchdogs(store, new Map(), startedAt + 69 * 60_000)).resolves.toEqual(
      new Set(),
    );
    await expect(triggerTeamWatchdogs(store, new Map(), startedAt + 70 * 60_000)).resolves.toEqual(
      new Set(["thread"]),
    );

    bridge.emit("notification", {
      method: "item/completed",
      params: {
        threadId: String(spawned.threadId),
        turnId: `turn-${String(spawned.threadId)}`,
        item: { type: "sleep", id: "sleep", durationMs: 60 * 60_000 },
        completedAtMs: startedAt + 60 * 60_000,
      },
    } satisfies ServerNotification);
    await vi.waitFor(() => {
      const task =
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)];
      expect(task?.expectedWakeAt).toBeUndefined();
      expect(task?.watchdog).toBeUndefined();
    });

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
    forceRestart: vi.fn(async () => codexStatus),
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
    forceRestart: vi.fn(async () => ({ accepted: true as const })),
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
  failBrowserResumeOnce = false;
  failNextGoalActivation = false;
  failInterrupts = 0;
  parentTurnStartEntered: (() => void) | null = null;
  parentTurnStartGate: Promise<void> | null = null;
  rejectFullTurnReads = false;
  nextTurnListError: RpcError | null = null;
  missingRolloutThreadIds = new Set<string>();
  missingThreadIds = new Set<string>();
  managedThreadSequence = 0;
  managedTurnSequences = new Map<string, number>();
  managedThreads: Thread[] = [];
  threadTurns = new Map<string, Turn[]>();
  includeManagedModel = true;
  skills = [
    {
      name: "review",
      description: "Review a change",
      interface: { displayName: "Code Review", shortDescription: "Review this change" },
      path: "/skills/review/SKILL.md",
      scope: "user",
      enabled: true,
    },
    {
      name: "disabled",
      description: "Disabled skill",
      path: "/skills/disabled/SKILL.md",
      scope: "system",
      enabled: false,
    },
    {
      name: "openai-templates:artifact-template-analytics-dashboard",
      description: "Create a spreadsheet from the default Analytics Dashboard template",
      path: "/plugins/openai-templates/skills/artifact-template-analytics-dashboard/SKILL.md",
      scope: "user",
      enabled: true,
    },
  ];
  request = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === "thread/list") {
      return params.archived
        ? { data: [], nextCursor: null, backwardsCursor: null }
        : { data: [testThread(), ...this.managedThreads], nextCursor: null, backwardsCursor: null };
    }
    if (method === "thread/loaded/list") {
      return { data: ["thread"], nextCursor: null };
    }
    if (method === "model/list") {
      return {
        data: [
          testModel("gpt-a", "high", true, [{ id: "fast", name: "Fast" }]),
          testModel("gpt-b", "low", false, []),
          ...(this.includeManagedModel
            ? [testModel("gpt-5.6-sol", "high", true, [{ id: "fast", name: "Fast" }])]
            : []),
        ],
        nextCursor: null,
      };
    }
    if (method === "skills/list") {
      return {
        data: (Array.isArray(params.cwds) ? params.cwds : ["/work"]).map((cwd) => ({
          cwd,
          skills: this.skills,
          errors: [],
        })),
      };
    }
    if (method === "skills/config/write") {
      const enabled = Boolean(params.enabled);
      const skill = this.skills.find((candidate) => candidate.path === params.path);
      if (skill) skill.enabled = enabled;
      return { effectiveEnabled: enabled };
    }
    if (method === "thread/start") {
      if (String(params.threadSource).startsWith("codexnest-managed:")) {
        this.managedThreadSequence += 1;
        const thread = {
          ...testThread(`managed-${this.managedThreadSequence}`),
          threadSource: String(params.threadSource),
        };
        this.managedThreads.push(thread);
        return { thread };
      }
      return { thread: { ...testThread("created"), cwd: String(params.cwd ?? "/work") } };
    }
    if (method === "thread/fork") {
      const thread = {
        ...testThread("fork"),
        sessionId: "fork",
        forkedFromId: String(params.threadId),
        createdAt: 3,
        updatedAt: 4,
        recencyAt: 4,
        status: { type: "idle" as const },
      };
      this.managedThreads.push(thread);
      return { thread };
    }
    if (method === "thread/resume") {
      const threadId = String(params.threadId);
      if (this.missingRolloutThreadIds.delete(threadId)) {
        throw new RpcError(-32_600, `no rollout found for thread id ${threadId}`);
      }
      const config = params.config;
      if (
        this.failBrowserResumeOnce &&
        config &&
        typeof config === "object" &&
        "mcp_servers" in config
      ) {
        this.failBrowserResumeOnce = false;
        throw new Error("browser resume failed");
      }
      return {};
    }
    if (method === "thread/unsubscribe") return {};
    if (method === "thread/metadata/update") {
      const threadId = String(params.threadId);
      if (this.missingRolloutThreadIds.delete(threadId)) {
        throw new RpcError(-32_600, `no rollout found for thread id ${threadId}`);
      }
      return { thread: testThread(String(params.threadId)) };
    }
    if (method === "thread/name/set") return {};
    if (method === "thread/delete") return {};
    if (method === "thread/turns/list") {
      if (this.rejectFullTurnReads && params.itemsView === "full") {
        throw new RpcError(-32_000, "Rollout changed while reading turns");
      }
      if (this.nextTurnListError) {
        const error = this.nextTurnListError;
        this.nextTurnListError = null;
        throw error;
      }
      return {
        data: [...(this.threadTurns.get(String(params.threadId)) ?? [])].reverse(),
        nextCursor: null,
        backwardsCursor: null,
      };
    }
    if (method === "thread/items/list") {
      const turn = (this.threadTurns.get(String(params.threadId)) ?? []).find(
        (candidate) => candidate.id === params.turnId,
      );
      return {
        data: turn?.items ?? [],
        nextCursor: null,
        backwardsCursor: null,
      };
    }
    if (method === "thread/read") {
      const threadId = String(params.threadId);
      if (this.missingThreadIds.has(threadId)) {
        throw new RpcError(-32_600, `thread ${threadId} not found`);
      }
      const thread =
        threadId === "thread"
          ? testThread()
          : (this.managedThreads.find((candidate) => candidate.id === threadId) ??
            testThread(threadId));
      return { thread: { ...thread, turns: this.threadTurns.get(threadId) ?? [] } };
    }
    if (method === "turn/start") {
      if (this.failNextTurnStart) {
        this.failNextTurnStart = false;
        throw new Error("turn failed");
      }
      const threadId = String(params.threadId ?? "thread");
      if (threadId === "thread" && this.parentTurnStartGate) {
        this.parentTurnStartEntered?.();
        await this.parentTurnStartGate;
      }
      const managedTurnSequence = (this.managedTurnSequences.get(threadId) ?? 0) + 1;
      this.managedTurnSequences.set(threadId, managedTurnSequence);
      const turnId =
        threadId === "thread"
          ? "turn"
          : managedTurnSequence === 1
            ? `turn-${threadId}`
            : `turn-${threadId}-${managedTurnSequence}`;
      const input = Array.isArray(params.input) ? params.input : [];
      const turn: Turn = {
        ...testTurn(turnId, "inProgress"),
        itemsView: "full",
        items: input.length
          ? [
              {
                type: "userMessage",
                id: `user-${turnId}`,
                clientId:
                  typeof params.clientUserMessageId === "string"
                    ? params.clientUserMessageId
                    : null,
                content: input as Extract<ThreadItem, { type: "userMessage" }>["content"],
              },
            ]
          : [],
      };
      this.threadTurns.set(threadId, [...(this.threadTurns.get(threadId) ?? []), turn]);
      return {
        turn,
      };
    }
    if (method === "turn/steer") {
      const threadId = String(params.threadId);
      const turns = this.threadTurns.get(threadId) ?? [];
      const active = turns.at(-1);
      if (active && Array.isArray(params.input)) {
        active.items.push({
          type: "userMessage",
          id: `user-steer-${active.items.length}`,
          clientId:
            typeof params.clientUserMessageId === "string" ? params.clientUserMessageId : null,
          content: params.input as Extract<ThreadItem, { type: "userMessage" }>["content"],
        });
      }
      return { turnId: threadId.startsWith("managed-") ? (active?.id ?? "steered") : "steered" };
    }
    if (method === "turn/interrupt") {
      if (this.failInterrupts > 0) {
        this.failInterrupts -= 1;
        throw new RpcError(-32_000, "interrupt temporarily unavailable");
      }
      return {};
    }
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
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_785_258_183 },
            secondary: {
              usedPercent: 40,
              windowDurationMins: 10_080,
              resetsAt: 1_785_344_583,
            },
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

async function createSkillsHarness() {
  const directory = await mkdtemp(join(tmpdir(), "codexnest-skills-api-test-"));
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
  const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
  await projection.sync();
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
    },
  );
  return {
    app,
    bridge,
    headers: { authorization: "Bearer correct" },
  };
}

async function createForkHarness() {
  const directory = await mkdtemp(join(tmpdir(), "codexnest-fork-api-test-"));
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
  const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
  await projection.sync();
  await projection.setSettings("thread", {
    collaborationMode: "default",
    model: "gpt-b",
    reasoningEffort: "low",
  });
  await store.update((state) => {
    const meta = state.threadMeta.thread!;
    meta.pinned = true;
    meta.managedTeamToolsAvailable = true;
    meta.draft = {
      input: "source draft",
      images: [],
      goalMode: false,
      annotations: [],
      updatedAt: 1,
    };
    meta.teamOrchestration = { tasks: {} };
  });
  const threadTitles = {
    generate: vi.fn(async () => "Готовая реализация"),
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
      threadTitles,
    },
  );
  return {
    app,
    bridge,
    headers: { authorization: "Bearer correct" },
    projection,
    store,
    threadTitles,
  };
}

async function createTeamHarness(
  options: { lifecycle?: boolean; projectPath?: string; includeManagedModel?: boolean } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "codexnest-team-api-test-"));
  directories.push(directory);
  const store = new StateStore(join(directory, "state.json"));
  await store.load();
  await store.update((state) => {
    state.auth.tokenSha256 = hashToken("correct");
    state.projects.push({
      id: "project",
      displayName: "Project",
      path: options.projectPath ?? "/work",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    });
  });
  const bridge = new SettingsBridge();
  bridge.includeManagedModel = options.includeManagedModel ?? true;
  const attention = new AttentionManager();
  const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
  await projection.sync();
  if (options.projectPath) {
    projection.upsertThread({ ...testThread(), cwd: options.projectPath });
  }
  await projection.setSettings("thread", {
    collaborationMode: "team",
    model: "gpt-a",
    reasoningEffort: "high",
  });
  await store.update((state) => {
    const meta = state.threadMeta.thread ?? { pinned: false, lastReadUpdatedAt: 0 };
    meta.managedTeamToolsAvailable = true;
    state.threadMeta.thread = meta;
  });
  const config = loadConfig({
    statePath: store.path,
    clientDist: join(directory, "missing"),
    allowedOrigins: new Set(["http://localhost"]),
    websocketAuthTimeoutMs: 25,
  });
  const lifecycle = options.lifecycle
    ? new RuntimeLifecycle({
        transport: "daemon",
        tokenPath: join(directory, "restart-token"),
        bridgeReady: () => true,
        checkpoint: () => store.checkpoint(),
      })
    : undefined;
  await lifecycle?.initialize();
  const app = await buildApp(config, {
    bridge: bridge as unknown as CodexBridge,
    store,
    projection,
    attention,
    projectRoot: directory,
    lifecycle,
  });
  return {
    app,
    bridge,
    headers: { authorization: "Bearer correct" },
    projection,
    store,
    lifecycle,
  };
}

async function createApiTestRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codexnest-team-api-repository-"));
  directories.push(directory);
  await mkdir(join(directory, "src"));
  await writeFile(join(directory, "src", "index.ts"), "export const value = 1;\n");
  await execFileAsync("git", ["-C", directory, "init", "--quiet"]);
  await execFileAsync("git", ["-C", directory, "add", "."]);
  await execFileAsync("git", [
    "-C",
    directory,
    "-c",
    "user.name=CodexNest Test",
    "-c",
    "user.email=test@codexnest.invalid",
    "commit",
    "--quiet",
    "-m",
    "initial",
  ]);
  return directory;
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
  requestId = `tool-${Math.random()}`,
  turnId = `turn-${threadId}`,
): Promise<TestDynamicToolResponse> {
  return new Promise((resolve, reject) => {
    bridge.emit(
      "request",
      {
        method: "item/tool/call",
        id: requestId,
        params: {
          threadId,
          turnId,
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

function websocketFrames(socket: WebSocket) {
  const queued: Array<Record<string, unknown>> = [];
  const waiters: Array<(frame: Record<string, unknown>) => void> = [];
  socket.on("message", (data) => {
    const frame = JSON.parse(data.toString()) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else queued.push(frame);
  });
  const next = (): Promise<Record<string, unknown>> => {
    const frame = queued.shift();
    return frame ? Promise.resolve(frame) : new Promise((resolve) => waiters.push(resolve));
  };
  return {
    async nextType(type: string): Promise<Record<string, unknown>> {
      for (;;) {
        const frame = await next();
        if (frame.type === type) return frame;
      }
    },
  };
}

function nextImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function browserTabSummary() {
  return {
    id: 1,
    windowId: 1,
    groupId: -1,
    active: true,
    title: "Tab",
    url: "https://example.com",
  };
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

function agentMessage(id: string, text: string): ThreadItem {
  return { type: "agentMessage", id, text, phase: null, memoryCitation: null };
}
