import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app";
import { AttentionManager } from "./attention";
import { hashToken } from "./auth";
import { CodexBackend } from "./backends/codex";
import { SessionHub } from "./backends/hub";
import { CodexManagementError, type CodexManager } from "./codex-management";
import { ClaudeBackend } from "./claude/backend";
import { ClaudeManager } from "./claude/manager";
import { DEFAULT_CLAUDE_MODELS } from "./claude/models";
import { patchClaudeSession } from "./claude/registry";
import type { ClaudeSdk, ClaudeTranscriptMessage, VersionRunner } from "./claude/sdk";
import { CodexBridge } from "./codex/bridge";
import { loadConfig } from "./config";
import { AppProjection } from "./projection";
import { PushNotifier } from "./push";
import { StateStore } from "./state/store";

const headers = { authorization: "Bearer correct" };
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const okRunner: VersionRunner = async () => ({ stdout: "2.1.218 (Claude Code)\n", stderr: "" });

function fixtureMessages(): ClaudeTranscriptMessage[] {
  const raw = readFileSync(
    new URL("./claude/fixtures/session-plain-text.json", import.meta.url),
    "utf8",
  );
  return (JSON.parse(raw) as { messages: ClaudeTranscriptMessage[] }).messages;
}

function maintenanceManager(): CodexManager {
  return {
    maintenanceActive: true,
    assertTurnsAllowed: vi.fn(() => {
      throw new CodexManagementError("busy", "Codex maintenance is in progress");
    }),
  } as unknown as CodexManager;
}

async function setup({
  withClaude = true,
  codexManager,
}: { withClaude?: boolean; codexManager?: CodexManager } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "codexnest-api-claude-"));
  directories.push(dir);
  const store = new StateStore(join(dir, "state.json"));
  await store.load();
  await store.update((state) => {
    state.auth.tokenSha256 = hashToken("correct");
    state.projects = [{ id: "p1", displayName: "P1", path: dir, createdAt: "t", updatedAt: "t" }];
  });
  // Codex intentionally left unavailable — health "ok" must still come from Claude.
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
  const codexBackend = new CodexBackend({ projection, bridge, store, codexManager });

  const sdk: ClaudeSdk = {
    query: () => {
      throw new Error("unused in Stage 2");
    },
    getSessionInfo: vi.fn(async () => ({ sessionId: "s", lastModified: 1, fileSize: 10 })),
    getSessionMessages: vi.fn(async () => fixtureMessages()),
  };
  let claudeBackend: ClaudeBackend | undefined;
  let claudeManager: ClaudeManager | undefined;
  if (withClaude) {
    claudeBackend = new ClaudeBackend({
      store,
      sdk,
      models: DEFAULT_CLAUDE_MODELS,
      bin: "claude",
      runVersion: okRunner,
    });
    const backend = claudeBackend;
    claudeManager = new ClaudeManager({
      path: "/usr/bin/claude",
      currentStatus: () => backend.currentProbe(),
      probe: () => backend.probe(),
    });
    await claudeBackend.start();
  }
  const hub = new SessionHub(
    claudeBackend ? [codexBackend, claudeBackend] : [codexBackend],
    store,
    attention,
    push.configured,
  );
  const config = loadConfig({
    statePath: store.path,
    clientDist: join(dir, "missing"),
    allowedOrigins: new Set(["http://localhost"]),
    websocketAuthTimeoutMs: 25,
  });
  const app = await buildApp(config, {
    bridge,
    store,
    projection,
    hub,
    codexBackend,
    attention,
    push,
    codexManager,
    claudeManager,
    projectRoot: dir,
  });
  return { app, store, claudeBackend, sdk };
}

describe("health with two backends", () => {
  it("reports ok when Claude is ready even though Codex is unavailable", async () => {
    const { app } = await setup();
    const health = (await app.inject({ url: "/api/v1/health" })).json();
    expect(health.status).toBe("ok");
    expect(health.appServer.state).toBe("unavailable");
    expect(health.backends).toEqual([
      {
        agent: "codex",
        state: "unavailable",
        installedVersion: "0.145.0",
        message: "Codex app-server is unavailable",
      },
      { agent: "claude", state: "ready", installedVersion: "2.1.218", message: null },
    ]);
    await app.close();
  });

  it("stays degraded when Claude is not registered and Codex is down", async () => {
    const { app } = await setup({ withClaude: false });
    const health = (await app.inject({ url: "/api/v1/health" })).json();
    expect(health.status).toBe("degraded");
    expect(health.backends.map((backend: { agent: string }) => backend.agent)).toEqual(["codex"]);
    await app.close();
  });
});

describe("GET/POST /settings/claude", () => {
  it("returns the live CLI status and re-probes on check", async () => {
    const { app } = await setup();
    const status = (await app.inject({ url: "/api/v1/settings/claude", headers })).json();
    expect(status).toEqual({
      supported: true,
      unavailableReason: null,
      cliVersion: "2.1.218",
      path: "/usr/bin/claude",
    });
    const checked = await app.inject({
      method: "POST",
      url: "/api/v1/settings/claude/check",
      headers,
    });
    expect(checked.statusCode).toBe(200);
    expect(checked.json()).toMatchObject({ cliVersion: "2.1.218", supported: true });
    await app.close();
  });

  it("reports the backend disabled when Claude is not configured", async () => {
    const { app } = await setup({ withClaude: false });
    const status = (await app.inject({ url: "/api/v1/settings/claude", headers })).json();
    expect(status).toMatchObject({ supported: false, cliVersion: null });
    await app.close();
  });

  it("requires authentication", async () => {
    const { app } = await setup();
    expect((await app.inject({ url: "/api/v1/settings/claude" })).statusCode).toBe(401);
    await app.close();
  });
});

describe("thread creation routing", () => {
  it("routes agent:claude to the Claude backend and reports turns are not ready yet", async () => {
    const { app, store } = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/threads",
      headers,
      payload: { projectId: "p1", input: "привет", agent: "claude" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "conflict", message: "Ходы Claude появятся на следующем этапе" },
    });
    // createThread ran on the Claude backend before startTurn rejected — a registry entry exists.
    expect(Object.keys(store.snapshot().claudeSessions ?? {})).toHaveLength(1);
    await app.close();
  });

  it("does not let Codex maintenance block Claude thread creation (carry-over b)", async () => {
    const { app } = await setup({ codexManager: maintenanceManager() });
    // Codex is gated by maintenance…
    const codex = await app.inject({
      method: "POST",
      url: "/api/v1/threads",
      headers,
      payload: { projectId: "p1", input: "hi", agent: "codex" },
    });
    expect(codex.statusCode).toBe(409);
    expect(codex.json().error.message).toBe("Codex maintenance is in progress");
    // …but Claude reaches its own turns-not-ready rejection, proving it was not gated.
    const claude = await app.inject({
      method: "POST",
      url: "/api/v1/threads",
      headers,
      payload: { projectId: "p1", input: "hi", agent: "claude" },
    });
    expect(claude.statusCode).toBe(409);
    expect(claude.json().error.message).toBe("Ходы Claude появятся на следующем этапе");
    await app.close();
  });

  it("409s for an unknown or disabled agent", async () => {
    const { app } = await setup({ withClaude: false });
    const unknown = await app.inject({
      method: "POST",
      url: "/api/v1/threads",
      headers,
      payload: { projectId: "p1", input: "hi", agent: "gemini" },
    });
    expect(unknown.statusCode).toBe(409);
    const disabled = await app.inject({
      method: "POST",
      url: "/api/v1/threads",
      headers,
      payload: { projectId: "p1", input: "hi", agent: "claude" },
    });
    expect(disabled.statusCode).toBe(409);
    await app.close();
  });
});

describe("Claude thread settings and goals", () => {
  it("does not push a Claude thread's reasoning effort into the Codex default (carry-over c)", async () => {
    const { app, store, claudeBackend } = await setup();
    const summary = await claudeBackend!.createThread("p1", "/work", {
      collaborationMode: "default",
    });
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/threads/${summary.id}/settings`,
      headers,
      payload: { reasoningEffort: "high" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().settings).toMatchObject({ reasoningEffort: "high" });
    expect(store.snapshot().defaultReasoningEffort).toBeUndefined();
    await app.close();
  });

  it("rejects goal routes for a Claude thread with a 409 (carry-over e)", async () => {
    const { app, claudeBackend } = await setup();
    const summary = await claudeBackend!.createThread("p1", "/work", {
      collaborationMode: "default",
    });
    const response = await app.inject({ url: `/api/v1/threads/${summary.id}/goal`, headers });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "conflict", message: "Цели доступны только в Codex" },
    });
    await app.close();
  });
});

describe("reading a Claude thread over HTTP", () => {
  it("returns the projected transcript once a session has materialized", async () => {
    const { app, store, claudeBackend } = await setup();
    const summary = await claudeBackend!.createThread("p1", "/work", {
      collaborationMode: "default",
    });
    await patchClaudeSession(store, summary.id, {
      sessionId: "session-abc",
      preview: "Reply with exactly: ok",
    });
    const detail = (await app.inject({ url: `/api/v1/threads/${summary.id}`, headers })).json();
    expect(detail.summary.agent).toBe("claude");
    expect(detail.turns).toHaveLength(1);
    expect(detail.turns[0].items.at(-1)).toMatchObject({ type: "agentMessage", text: "ok" });
    await app.close();
  });
});

describe("Claude queue is paused until Stage 3 (no drain livelock)", () => {
  it("keeps an enqueued message durably queued and never storms startTurn", async () => {
    const { app, store, claudeBackend } = await setup();
    const summary = await claudeBackend!.createThread("p1", "/work", {
      collaborationMode: "default",
    });
    const startSpy = vi.spyOn(claudeBackend!, "startTurn");

    const enqueue = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${summary.id}/queue`,
      headers,
      payload: { input: "позже" },
    });
    expect(enqueue.statusCode).toBe(202);
    // Let any fire-and-forget drain (and the thread.upserted-triggered redrain) settle.
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(startSpy).not.toHaveBeenCalled();
    const queued = store.snapshot().messageQueues?.[summary.id] ?? [];
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ status: "queued" });
    expect(claudeBackend!.summary(summary.id)?.queuedMessageCount).toBe(1);

    // sendNow surfaces the meaningful 409 instead of looping.
    const send = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${summary.id}/queue/${queued[0]!.id}/send`,
      headers,
    });
    expect(send.statusCode).toBe(409);
    expect(send.json().error.message).toBe("Ходы Claude появятся на следующем этапе");
    await app.close();
  });
});
