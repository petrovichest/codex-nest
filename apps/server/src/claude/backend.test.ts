import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServerEvent } from "@codexnest/protocol";

import { AttentionManager } from "../attention";
import { StateStore } from "../state/store";
import { patchClaudeSession } from "./registry";
import { ClaudeBackend } from "./backend";
import { DEFAULT_CLAUDE_MODELS } from "./models";
import type {
  ClaudeInterruptReceipt,
  ClaudeQuery,
  ClaudeSdk,
  ClaudeTranscriptMessage,
  VersionRunner,
} from "./sdk";

const directories: string[] = [];
const backends: ClaudeBackend[] = [];
const stores: StateStore[] = [];
afterEach(async () => {
  for (const backend of backends.splice(0)) backend.stop();
  // Let background writes (outcome, preview, sessionId) settle before removing temp dirs.
  await Promise.all(stores.splice(0).map((store) => store.flushed().catch(() => undefined)));
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * Polls a predicate with real wall-clock delays — background writes finish through the
 * StateStore's fsync-heavy persist (3 fsyncs each), which outpaces bare microtask ticks.
 */
async function waitFor(predicate: () => boolean, tries = 200): Promise<void> {
  for (let index = 0; index < tries; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!predicate()) throw new Error("waitFor timed out");
}

const okRunner: VersionRunner = async () => ({ stdout: "2.1.218 (Claude Code)\n", stderr: "" });
const missingRunner: VersionRunner = async () => {
  throw new Error("spawn claude ENOENT");
};

/** A pushable fake query (drives live turns in backend tests). */
class FakeQuery implements AsyncGenerator<unknown, void, unknown> {
  private readonly q: unknown[] = [];
  private waiter: (() => void) | null = null;
  private done = false;
  private error: unknown;
  interruptCount = 0;
  emit(message: unknown): void {
    this.q.push(message);
    this.wake();
  }
  throwNext(error: unknown): void {
    this.error = error;
    this.wake();
  }
  finish(): void {
    this.done = true;
    this.wake();
  }
  async interrupt(): Promise<ClaudeInterruptReceipt | undefined> {
    this.interruptCount += 1;
    return { still_queued: [] };
  }
  async next(): Promise<IteratorResult<unknown, void>> {
    for (;;) {
      if (this.q.length) return { value: this.q.shift(), done: false };
      if (this.error) {
        const error = this.error;
        this.error = undefined;
        throw error;
      }
      if (this.done) return { value: undefined, done: true };
      await new Promise<void>((resolve) => (this.waiter = resolve));
      this.waiter = null;
    }
  }
  async return(): Promise<IteratorResult<unknown, void>> {
    this.done = true;
    return { value: undefined, done: true };
  }
  async throw(error: unknown): Promise<IteratorResult<unknown, void>> {
    throw error;
  }
  [Symbol.asyncIterator](): AsyncGenerator<unknown, void, unknown> {
    return this;
  }
  private wake(): void {
    this.waiter?.();
    this.waiter = null;
  }
}

function fixtureMessages(): ClaudeTranscriptMessage[] {
  const raw = readFileSync(new URL("./fixtures/session-plain-text.json", import.meta.url), "utf8");
  return (JSON.parse(raw) as { messages: ClaudeTranscriptMessage[] }).messages;
}

async function setup(options: { runVersion?: VersionRunner; sdk?: Partial<ClaudeSdk> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "codexnest-claude-backend-"));
  directories.push(dir);
  const store = new StateStore(join(dir, "state.json"));
  await store.load();
  stores.push(store);
  const queries: FakeQuery[] = [];
  const sdk: ClaudeSdk = {
    query: () => {
      const query = new FakeQuery();
      queries.push(query);
      return query as unknown as ClaudeQuery;
    },
    getSessionInfo: vi.fn(async () => ({ sessionId: "s", lastModified: 1, fileSize: 10 })),
    getSessionMessages: vi.fn(async () => fixtureMessages()),
    ...options.sdk,
  };
  const events: ServerEvent[] = [];
  const attention = new AttentionManager();
  const backend = new ClaudeBackend({
    store,
    sdk,
    models: DEFAULT_CLAUDE_MODELS,
    bin: "claude",
    attention,
    idleTimeoutMs: 10_000,
    maxSessions: 2,
    runVersion: options.runVersion ?? okRunner,
  });
  backends.push(backend);
  backend.on("event", (event: ServerEvent) => events.push(event));
  return { backend, store, sdk, events, attention, queries, dir };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

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

const initMsg = (sessionId = "sess-1") => ({
  type: "system",
  subtype: "init",
  session_id: sessionId,
});
const assistantText = (uuid: string, text: string) => ({
  type: "assistant",
  uuid,
  parent_tool_use_id: null,
  message: { role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" },
});
const resultMsg = (subtype = "success") => ({ type: "result", subtype });

describe("ClaudeBackend live turns", () => {
  it("dispatches a turn, streams to completion, and persists the outcome", async () => {
    const { backend, store, events, queries } = await setup();
    await backend.start();
    const { id } = await backend.createThread("p", "/work", { collaborationMode: "default" });

    const { turnId } = await backend.startTurn(id, {
      text: "hi",
      images: [],
      clientMessageId: null,
    });
    expect(backend.currentTurnId(id)).toBe(turnId);
    expect(backend.summary(id)?.state).toBe("running");
    // Prompt item + initial progress were emitted immediately.
    expect(
      events.some((e) => e.type === "activity.upserted" && e.item.type === "userMessage"),
    ).toBe(true);
    expect(events.some((e) => e.type === "turn.progressed")).toBe(true);

    const query = queries.at(-1)!;
    query.emit(initMsg("sess-1"));
    query.emit(assistantText("a1", "done"));
    query.emit(resultMsg("success"));
    await waitFor(() => backend.summary(id)?.state === "completed");

    expect(backend.currentTurnId(id)).toBeNull();
    expect(store.snapshot().threadMeta[id]?.lastOutcome).toBe("completed");
    expect(store.snapshot().claudeSessions?.[id]?.sessionId).toBe("sess-1");
    expect(store.snapshot().claudeSessions?.[id]?.preview).toBe("hi");
    const terminal = events
      .filter((e) => e.type === "thread.upserted" && e.thread.id === id)
      .at(-1);
    expect(terminal).toMatchObject({ thread: { state: "completed", currentTurnId: null } });
  });

  it("rejects the goal option and live steering", async () => {
    const { backend } = await setup();
    await backend.start();
    const { id } = await backend.createThread("p", "/work", { collaborationMode: "default" });
    await expect(
      backend.startTurn(id, { text: "hi", images: [], clientMessageId: null }, { goal: true }),
    ).rejects.toThrow("Цели доступны только в Codex");
    await expect(
      backend.steerTurn(id, "t", { text: "hi", images: [], clientMessageId: null }),
    ).rejects.toThrow("не поддерживает изменение хода");
  });

  it("rejects startTurn with an unavailable-backend error when the CLI is missing", async () => {
    const { backend } = await setup({ runVersion: missingRunner });
    await backend.start();
    const { id } = await backend.createThread("p", "/work", { collaborationMode: "default" });
    await expect(
      backend.startTurn(id, { text: "hi", images: [], clientMessageId: null }),
    ).rejects.toThrow("claude login");
    expect(backend.pauseReason()).toContain("claude login");
  });

  it("reports pauseReason null once ready (queue may drain)", async () => {
    const { backend } = await setup();
    await backend.start();
    expect(backend.pauseReason()).toBeNull();
  });

  it("classifies a self-interrupt as an interrupted outcome", async () => {
    const { backend, store, queries } = await setup();
    await backend.start();
    const { id } = await backend.createThread("p", "/work", { collaborationMode: "default" });
    const { turnId } = await backend.startTurn(id, {
      text: "sleep",
      images: [],
      clientMessageId: null,
    });
    const query = queries.at(-1)!;
    query.emit(initMsg());
    query.emit({
      type: "assistant",
      uuid: "a1",
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "sleep 9" } }],
        stop_reason: "tool_use",
      },
    });
    await flush();

    const interrupted = backend.interruptTurn(id, turnId);
    query.emit(resultMsg("error_during_execution"));
    query.throwNext(new Error("Claude Code returned an error result: [ede_diagnostic]"));
    await interrupted;
    await waitFor(() => store.snapshot().threadMeta[id]?.lastOutcome === "interrupted");
    expect(backend.currentTurnId(id)).toBeNull();
  });
});

describe("ClaudeBackend queue drain end-to-end", () => {
  it("delivers a queued message after the running turn completes", async () => {
    const { MessageQueue } = await import("../message-queue");
    const { backend, store, queries } = await setup();
    await backend.start();
    const { id } = await backend.createThread("p", "/work", { collaborationMode: "default" });

    const queue = new MessageQueue(store, {
      pauseReason: () => backend.pauseReason(),
      currentTurnId: (threadId) => backend.currentTurnId(threadId),
      start: (threadId, message) =>
        backend
          .startTurn(threadId, {
            text: message.text,
            images: message.images ?? [],
            clientMessageId: message.id,
          })
          .then((result) => result.turnId),
      steer: (threadId, turnId, message) =>
        backend.steerTurn(threadId, turnId, {
          text: message.text,
          images: message.images ?? [],
          clientMessageId: message.id,
        }),
      wasDelivered: (threadId, messageId) => backend.wasDelivered(threadId, messageId),
      publish: () => undefined,
    });
    // Mirror the api hub listener: a terminal thread.upserted drains the queue.
    backend.on("event", (event) => {
      if (event.type === "thread.upserted" && !event.thread.currentTurnId) {
        void queue.drain(event.thread.id).catch(() => undefined);
      }
    });

    await queue.enqueue(id, "first");
    await waitFor(() => backend.currentTurnId(id) !== null); // first turn dispatched
    await queue.enqueue(id, "second");
    await flush();
    expect(queue.count(id)).toBe(1); // second stays queued while the first runs

    // Complete the first turn → terminal thread.upserted drains → second dispatches.
    const first = queries.at(-1)!;
    first.emit(initMsg());
    first.emit(assistantText("a1", "ok"));
    first.emit(resultMsg("success"));
    await waitFor(() => queue.count(id) === 0);
    expect(backend.currentTurnId(id)).not.toBeNull(); // second turn now running
  });
});

describe("ClaudeBackend wasDelivered", () => {
  it("finds the stamped turn uuid in the transcript after a simulated crash", async () => {
    const { backend, store, sdk } = await setup();
    await backend.start();
    const { id } = await backend.createThread("p", "/work", { collaborationMode: "default" });
    await patchClaudeSession(store, id, { sessionId: "sess-abc" });

    const { turnId } = await backend.startTurn(id, {
      text: "hi",
      images: [],
      clientMessageId: "msg-1",
    });
    // The SDK persisted a user message stamped with our deterministic turn uuid.
    (sdk.getSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        type: "user",
        uuid: turnId,
        parent_tool_use_id: null,
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
    ]);
    await expect(backend.wasDelivered(id, "msg-1")).resolves.toBe(true);

    (sdk.getSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await expect(backend.wasDelivered(id, "msg-1")).resolves.toBe(false);
  });
});

describe("ClaudeBackend session pool", () => {
  it("caps idle-session retention with LRU eviction", async () => {
    const { backend, queries } = await setup(); // maxSessions: 2
    await backend.start();
    const threads = [] as string[];
    for (let index = 0; index < 3; index += 1) {
      const { id } = await backend.createThread("p", `/work/${index}`, {
        collaborationMode: "default",
      });
      threads.push(id);
      await backend.startTurn(id, { text: "hi", images: [], clientMessageId: null });
      const query = queries.at(-1)!;
      query.emit(initMsg(`sess-${index}`));
      query.emit(assistantText(`a${index}`, "ok"));
      query.emit(resultMsg("success"));
      await flush();
    }
    // Three threads ran, but only two idle sessions are retained.
    expect(backend.openSessionCount).toBe(2);
  });
});
