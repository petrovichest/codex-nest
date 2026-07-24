import { afterEach, describe, expect, it } from "vitest";

import type { ActivityItem, ThreadOutcome } from "@codexnest/protocol";

import { AttentionManager } from "../attention";
import { ClaudeSession, type ClaudeSessionCallbacks, type ClaudeSessionOptions } from "./session";
import type { ClaudeInterruptReceipt, ClaudeQuery, ClaudeSdk } from "./sdk";

/** A controllable fake ClaudeQuery: a pushable message script plus an interrupt hook. */
class FakeQuery implements AsyncGenerator<unknown, void, unknown> {
  private readonly queue: unknown[] = [];
  private waiter: (() => void) | null = null;
  private done = false;
  private error: unknown;
  interruptCount = 0;
  receipt: ClaudeInterruptReceipt | undefined = { still_queued: [] };
  onInterrupt?: () => void;

  emit(message: unknown): void {
    this.queue.push(message);
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
    this.onInterrupt?.();
    return this.receipt;
  }

  async next(): Promise<IteratorResult<unknown, void>> {
    for (;;) {
      if (this.queue.length) return { value: this.queue.shift(), done: false };
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

const flush = () => new Promise((resolve) => setImmediate(resolve));

function initMessage(sessionId = "session-live") {
  return { type: "system", subtype: "init", session_id: sessionId };
}
function assistantMessage(uuid: string, content: unknown[], stopReason: string | null) {
  return {
    type: "assistant",
    uuid,
    session_id: "s",
    parent_tool_use_id: null,
    message: { role: "assistant", content, stop_reason: stopReason },
  };
}
function resultMessage(subtype: string, errors: string[] = []) {
  return { type: "result", subtype, session_id: "s", errors };
}
function streamTextDelta(text: string) {
  return {
    type: "stream_event",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  };
}

function makeSession(overrides: Partial<ClaudeSessionOptions> = {}) {
  const fake = new FakeQuery();
  const events: {
    activities: Array<{ item: ActivityItem; turnId: string }>;
    outcomes: Array<{ outcome: ThreadOutcome; turnId: string; detail?: string }>;
    closed: string[];
    inits: string[];
    auth: string[];
  } = {
    activities: [],
    outcomes: [],
    closed: [],
    inits: [],
    auth: [],
  };
  const callbacks: ClaudeSessionCallbacks = {
    onInit: (id) => events.inits.push(id),
    onActivity: (item, turnId) => events.activities.push({ item, turnId }),
    onProgress: () => undefined,
    onTurnComplete: (outcome, turnId, detail) => events.outcomes.push({ outcome, turnId, detail }),
    onSessionClosed: (reason) => events.closed.push(reason),
    onUserInputResponse: () => undefined,
    onPlanAccepted: () => undefined,
    onAuthError: (message) => events.auth.push(message),
  };
  const sdk: Pick<ClaudeSdk, "query"> = { query: () => fake as unknown as ClaudeQuery };
  const session = new ClaudeSession({
    threadId: "thread-1",
    cwd: "/work",
    sessionId: null,
    permissionMode: "default",
    bin: "claude",
    idleTimeoutMs: 10_000,
    watchdogMs: 50,
    sdk: sdk as ClaudeSdk,
    attention: new AttentionManager(),
    callbacks,
    ...overrides,
  });
  return { session, fake, events };
}

const sessions: ClaudeSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.close("test-cleanup");
});
function track(session: ClaudeSession): ClaudeSession {
  sessions.push(session);
  return session;
}

describe("ClaudeSession lifecycle", () => {
  it("runs init → streaming → result and completes the turn", async () => {
    const { session, fake, events } = makeSession();
    track(session);
    const turnId = session.startTurn("Reply ok", []);
    expect(session.currentState).toBe("streaming");
    expect(session.activeTurnId).toBe(turnId);

    fake.emit(initMessage());
    fake.emit(assistantMessage("a1", [{ type: "text", text: "ok" }], "end_turn"));
    fake.emit(resultMessage("success"));
    await flush();

    expect(events.inits).toEqual(["session-live"]);
    expect(session.resolvedSessionId).toBe("session-live");
    const agents = events.activities.filter((a) => a.item.type === "agentMessage");
    expect(agents.at(-1)?.item).toMatchObject({
      type: "agentMessage",
      text: "ok",
      phase: "final_answer",
    });
    expect(events.outcomes).toEqual([{ outcome: "completed", turnId, detail: undefined }]);
    expect(session.currentState).toBe("idle");
    expect(session.activeTurnId).toBeNull();
  });

  it("emits the user prompt item immediately with the stamped turn id scheme", () => {
    const { session, events } = makeSession();
    track(session);
    const turnId = session.startTurn("hello", []);
    const prompt = events.activities.find((a) => a.item.type === "userMessage");
    expect(prompt?.item).toMatchObject({ type: "userMessage", text: "hello", id: `${turnId}:0` });
  });

  it("streams text deltas under a stable id that the finalizing message completes", async () => {
    const { session, fake, events } = makeSession();
    track(session);
    const turnId = session.startTurn("hi", []);
    fake.emit(initMessage());
    fake.emit(streamTextDelta("Hel"));
    fake.emit(streamTextDelta("lo"));
    await flush();

    const streamed = events.activities.filter((a) => a.item.type === "agentMessage");
    // One activity per delta, growing text, all inProgress under the same stable id.
    expect(streamed.map((a) => (a.item.type === "agentMessage" ? a.item.text : ""))).toEqual([
      "Hel",
      "Hello",
    ]);
    expect(streamed.every((a) => a.item.status === "inProgress")).toBe(true);
    const streamId = streamed[0]!.item.id;
    expect(streamId).toBe(`${turnId}:1`);
    expect(streamed.every((a) => a.item.id === streamId)).toBe(true);

    // The finalizing assistant message completes the SAME id (no provisional→canonical switch).
    fake.emit(assistantMessage("a1", [{ type: "text", text: "Hello" }], "end_turn"));
    fake.emit(resultMessage("success"));
    await flush();
    const finalAgent = events.activities.filter((a) => a.item.type === "agentMessage").at(-1);
    expect(finalAgent!.item.id).toBe(streamId);
    expect(finalAgent!.item).toMatchObject({
      status: "completed",
      text: "Hello",
      phase: "final_answer",
    });
  });

  it("closes cleanly after the idle timeout ends the input generator", async () => {
    const { session, fake, events } = makeSession({ idleTimeoutMs: 20 });
    track(session);
    session.startTurn("hi", []);
    fake.emit(initMessage());
    fake.emit(resultMessage("success"));
    await flush();
    expect(session.currentState).toBe("idle");
    await new Promise((resolve) => setTimeout(resolve, 40));
    await flush();
    expect(session.currentState).toBe("closed");
    expect(events.closed).toContain("idle-timeout");
  });
});

describe("ClaudeSession interrupt", () => {
  it("classifies a self-interrupt as interrupted (receipt path)", async () => {
    const { session, fake, events } = makeSession();
    track(session);
    const turnId = session.startTurn("sleep", []);
    fake.emit(initMessage());
    fake.emit(
      assistantMessage(
        "a1",
        [{ type: "tool_use", id: "t", name: "Bash", input: { command: "sleep 20" } }],
        "tool_use",
      ),
    );
    await flush();

    // Real SDK behavior: interrupt → error_during_execution result, then the iterator throws.
    fake.onInterrupt = () => {
      fake.emit(resultMessage("error_during_execution", ["interrupted"]));
      fake.throwNext(new Error("Claude Code returned an error result: [ede_diagnostic]"));
    };
    await session.interrupt();
    await flush();

    expect(fake.interruptCount).toBe(1);
    expect(events.outcomes).toEqual([{ outcome: "interrupted", turnId, detail: undefined }]);
    expect(session.currentState).toBe("closed");
    expect(events.closed).toContain("interrupted");
  });

  it("force-aborts via the watchdog when interrupt never settles", async () => {
    const { session, fake, events } = makeSession({ watchdogMs: 20 });
    track(session);
    const turnId = session.startTurn("sleep", []);
    fake.emit(initMessage());
    await flush();
    fake.onInterrupt = () => undefined; // interrupt() resolves but the stream never ends
    await session.interrupt();
    await new Promise((resolve) => setTimeout(resolve, 40));
    await flush();
    expect(session.currentState).toBe("closed");
    expect(events.closed).toContain("interrupt-watchdog");
    // A live turn interrupted by the watchdog still reports an outcome.
    expect(events.outcomes).toEqual([{ outcome: "interrupted", turnId, detail: undefined }]);
  });
});

describe("ClaudeSession failures", () => {
  it("classifies a non-interrupt iterator throw as failed and surfaces an error item", async () => {
    const { session, fake, events } = makeSession();
    track(session);
    const turnId = session.startTurn("do it", []);
    fake.emit(initMessage());
    await flush();
    fake.throwNext(new Error("Claude Code process exited with code 1"));
    await flush();

    expect(events.outcomes).toEqual([
      { outcome: "failed", turnId, detail: expect.stringContaining("exited") },
    ]);
    const error = events.activities.find((a) => a.item.type === "error");
    expect(error?.item).toMatchObject({ type: "error", status: "failed" });
    expect(session.currentState).toBe("closed");
  });

  it("reports an auth-shaped failure to the backend", async () => {
    const { session, fake, events } = makeSession();
    track(session);
    session.startTurn("do it", []);
    fake.emit(initMessage());
    await flush();
    fake.throwNext(new Error("Invalid API key; please run claude login"));
    await flush();
    expect(events.auth).toContain("Выполните `claude login` на сервере");
  });
});
