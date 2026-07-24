import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServerEvent } from "@codexnest/protocol";

import { StateStore } from "../state/store";
import { patchClaudeSession } from "./registry";
import { ClaudeBackend } from "./backend";
import { DEFAULT_CLAUDE_MODELS } from "./models";
import type { ClaudeSdk, ClaudeTranscriptMessage, VersionRunner } from "./sdk";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const okRunner: VersionRunner = async () => ({ stdout: "2.1.218 (Claude Code)\n", stderr: "" });
const missingRunner: VersionRunner = async () => {
  throw new Error("spawn claude ENOENT");
};

function fixtureMessages(): ClaudeTranscriptMessage[] {
  const raw = readFileSync(new URL("./fixtures/session-plain-text.json", import.meta.url), "utf8");
  return (JSON.parse(raw) as { messages: ClaudeTranscriptMessage[] }).messages;
}

async function setup(options: { runVersion?: VersionRunner; sdk?: Partial<ClaudeSdk> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "codexnest-claude-backend-"));
  directories.push(dir);
  const store = new StateStore(join(dir, "state.json"));
  await store.load();
  const sdk: ClaudeSdk = {
    query: () => {
      throw new Error("query is not used before Stage 3");
    },
    getSessionInfo: vi.fn(async () => ({ sessionId: "s", lastModified: 1, fileSize: 10 })),
    getSessionMessages: vi.fn(async () => fixtureMessages()),
    ...options.sdk,
  };
  const events: ServerEvent[] = [];
  const backend = new ClaudeBackend({
    store,
    sdk,
    models: DEFAULT_CLAUDE_MODELS,
    bin: "claude",
    runVersion: options.runVersion ?? okRunner,
  });
  backend.on("event", (event: ServerEvent) => events.push(event));
  return { backend, store, sdk, events };
}

describe("ClaudeBackend probe + connection", () => {
  it("becomes ready and emits connection + models on start", async () => {
    const { backend, events } = await setup();
    await backend.start();
    expect(backend.connection.state).toBe("ready");
    expect(backend.currentProbe()).toEqual({ version: "2.1.218", unavailableReason: null });
    expect(events.map((event) => event.type)).toEqual(["connection.changed", "models.changed"]);
  });

  it("reports unavailable with an install hint when the CLI is missing", async () => {
    const { backend } = await setup({ runVersion: missingRunner });
    await backend.start();
    expect(backend.connection.state).toBe("unavailable");
    expect(backend.connection.message).toContain("claude login");
    expect(backend.currentProbe().version).toBeNull();
  });
});

describe("ClaudeBackend registry", () => {
  it("creates a thread with claude identity and persists settings", async () => {
    const { backend, store, events } = await setup();
    const summary = await backend.createThread("project-1", "/work", {
      collaborationMode: "default",
      model: "opus",
    });
    expect(summary).toMatchObject({
      agent: "claude",
      projectId: "project-1",
      cwd: "/work",
      state: "idle",
      archived: false,
      currentTurnId: null,
      queuedMessageCount: 0,
      title: "Без названия",
    });
    expect(summary.settings).toMatchObject({ model: "opus" });
    expect(backend.owns(summary.id)).toBe(true);
    expect(store.snapshot().claudeSessions?.[summary.id]).toMatchObject({ sessionId: null });
    expect(events.at(-1)).toMatchObject({ type: "thread.upserted" });
  });

  it("reuses an existing empty thread for the same project", async () => {
    const { backend } = await setup();
    const first = await backend.createThread("project-1", "/work", {
      collaborationMode: "default",
    });
    const second = await backend.createThread("project-1", "/work", {
      collaborationMode: "default",
    });
    expect(second.id).toBe(first.id);
    expect(backend.threads()).toHaveLength(1);
  });

  it("does not reuse a materialized thread", async () => {
    const { backend, store } = await setup();
    const first = await backend.createThread("project-1", "/work", {
      collaborationMode: "default",
    });
    await patchClaudeSession(store, first.id, { sessionId: "abc", preview: "hello" });
    const second = await backend.createThread("project-1", "/work", {
      collaborationMode: "default",
    });
    expect(second.id).not.toBe(first.id);
    expect(backend.threads()).toHaveLength(2);
  });

  it("renames, archives, pins and deletes threads", async () => {
    const { backend, store, events } = await setup();
    const { id } = await backend.createThread("p", "/work", { collaborationMode: "default" });

    await backend.renameThread(id, "Мой тред");
    expect(backend.summary(id)?.title).toBe("Мой тред");

    await backend.setArchived(id, true);
    expect(backend.summary(id)?.archived).toBe(true);

    await backend.setPinned(id, true);
    expect(backend.summary(id)?.pinned).toBe(true);

    await backend.deleteThread(id);
    expect(backend.owns(id)).toBe(false);
    expect(store.snapshot().claudeSessions?.[id]).toBeUndefined();
    expect(store.snapshot().threadMeta[id]).toBeUndefined();
    expect(events.at(-1)).toEqual({ type: "thread.removed", threadId: id });
  });
});

describe("ClaudeBackend readThread", () => {
  it("returns an empty detail before the session materializes", async () => {
    const { backend, sdk } = await setup();
    const { id } = await backend.createThread("p", "/work", { collaborationMode: "default" });
    const detail = await backend.readThread(id);
    expect(detail.turns).toEqual([]);
    expect(detail.olderTurnsCursor).toBeNull();
    expect(sdk.getSessionMessages).not.toHaveBeenCalled();
  });

  it("projects the transcript and caches it on lastModified/fileSize", async () => {
    const { backend, store, sdk } = await setup();
    const { id } = await backend.createThread("p", "/work", { collaborationMode: "default" });
    await patchClaudeSession(store, id, {
      sessionId: "session-abc",
      preview: "Reply with exactly: ok",
    });

    const first = await backend.readThread(id);
    expect(first.turns).toHaveLength(1);
    expect(first.turns[0]?.items.at(-1)).toMatchObject({ type: "agentMessage", text: "ok" });
    expect(sdk.getSessionMessages).toHaveBeenCalledTimes(1);

    // Same info fingerprint → served from cache.
    await backend.readThread(id);
    expect(sdk.getSessionMessages).toHaveBeenCalledTimes(1);

    // Changed fingerprint → transcript re-read.
    (sdk.getSessionInfo as ReturnType<typeof vi.fn>).mockResolvedValue({
      sessionId: "session-abc",
      lastModified: 2,
      fileSize: 20,
    });
    await backend.readThread(id);
    expect(sdk.getSessionMessages).toHaveBeenCalledTimes(2);
  });

  it("throws ThreadNotFoundError for an unknown thread", async () => {
    const { backend } = await setup();
    await expect(backend.readThread("nope")).rejects.toThrow("Thread not found");
  });
});

describe("ClaudeBackend turn operations are unsupported in Stage 2", () => {
  it("rejects startTurn/steerTurn/interruptTurn and reports no active turn", async () => {
    const { backend } = await setup();
    const { id } = await backend.createThread("p", "/work", { collaborationMode: "default" });
    await expect(
      backend.startTurn(id, { text: "hi", images: [], clientMessageId: null }),
    ).rejects.toThrow("Ходы Claude появятся на следующем этапе");
    await expect(
      backend.steerTurn(id, "t", { text: "hi", images: [], clientMessageId: null }),
    ).rejects.toThrow();
    await expect(backend.interruptTurn(id, "t")).rejects.toThrow();
    expect(backend.pauseReason()).toBeNull();
    expect(backend.currentTurnId(id)).toBeNull();
    await expect(backend.wasDelivered(id, "m")).resolves.toBe(false);
  });
});
