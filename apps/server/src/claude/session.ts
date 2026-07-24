import { randomUUID } from "node:crypto";

import type {
  ActivityItem,
  ThreadOutcome,
  TurnProgress,
  UserInputQuestion,
} from "@codexnest/protocol";

import type { AttentionManager } from "../attention";
import { TurnInProgressError } from "../backends/backend";
import { ClaudeAttention } from "./attention";
import { ClaudeLiveTurn, parseImageDataUrl } from "./projection";
import type { ClaudeQuery, ClaudeSdk, ClaudeTranscriptMessage } from "./sdk";

/** Watchdog after `interrupt()` before we force-abort the process. */
const INTERRUPT_WATCHDOG_MS = 10_000;
/**
 * Pragmatic auth-failure detection over the error text / captured stderr. This is a
 * heuristic keyed on wording, so it can false-positive on unrelated errors that merely
 * mention these words; it only sets a connection hint and never blocks a turn. Its match
 * against the real Claude CLI's auth-failure output is a documented Linux-host verification
 * step (see the "Claude Code" section of deploy/DEPLOYMENT.md); do not tune it without that.
 */
const AUTH_ERROR = /login|log in|authenticat|unauthor|api key|anthropic_api_key|oauth|credential/i;
const AUTH_MESSAGE = "Выполните `claude login` на сервере";

export type ClaudeSessionState =
  "idle" | "starting" | "streaming" | "awaiting-idle" | "interrupting" | "closed";

export interface ClaudeSessionCallbacks {
  /** The SDK reported (or refreshed) the resumable session id. */
  onInit(sessionId: string): void;
  onActivity(item: ActivityItem, turnId: string): void;
  onProgress(progress: TurnProgress, turnId: string): void;
  onTurnComplete(outcome: ThreadOutcome, turnId: string, errorDetail?: string): void;
  onSessionClosed(reason: string): void;
  /** An AskUserQuestion was answered (record the userInputResponse artifact). */
  onUserInputResponse(
    turnId: string,
    itemId: string,
    questions: UserInputQuestion[],
    answers: Record<string, string[]>,
  ): void;
  /** A plan was accepted (flip collaborationMode → default and publish it). */
  onPlanAccepted(turnId: string): void;
  /** An auth-shaped failure surfaced (set the connection message). */
  onAuthError(message: string): void;
}

export interface ClaudeSessionOptions {
  threadId: string;
  cwd: string;
  /** Existing SDK session id to resume, or null for a fresh session. */
  sessionId: string | null;
  model?: string;
  effort?: string;
  permissionMode: string;
  bin: string;
  idleTimeoutMs: number;
  /** Interrupt watchdog before force-abort; defaults to {@link INTERRUPT_WATCHDOG_MS}. */
  watchdogMs?: number;
  sdk: ClaudeSdk;
  attention: AttentionManager;
  callbacks: ClaudeSessionCallbacks;
}

interface PushableInput {
  iterable: AsyncIterable<unknown>;
  push(message: unknown): void;
  end(): void;
}

/**
 * One live `query` per active Claude session. Owns the pushable input generator, the SDK
 * query handle, the message-consume loop, the per-turn projector, canUseTool→attention
 * wiring, interrupt (receipt-or-watchdog), and an idle keep-alive timer. State machine:
 * idle → starting → streaming → awaiting-idle → idle, plus interrupting and terminal closed.
 */
export class ClaudeSession {
  private state: ClaudeSessionState = "idle";
  private query?: ClaudeQuery;
  private input?: PushableInput;
  private readonly abortController = new AbortController();
  private readonly attention: ClaudeAttention;
  private currentTurnId: string | null = null;
  private liveTurnProjector: ClaudeLiveTurn | null = null;
  private turnCompleted = false;
  private interruptRequested = false;
  private idleTimer?: NodeJS.Timeout;
  private watchdogTimer?: NodeJS.Timeout;
  private stderrTail = "";
  private sessionId: string | null;
  private permissionMode: string;
  private closing = false;

  constructor(private readonly options: ClaudeSessionOptions) {
    this.sessionId = options.sessionId;
    this.permissionMode = options.permissionMode;
    this.attention = new ClaudeAttention(options.threadId, options.cwd, options.attention, {
      onUserInputResponse: (turnId, itemId, questions, answers) =>
        this.options.callbacks.onUserInputResponse(turnId, itemId, questions, answers),
      onPlanAccepted: (turnId) => this.options.callbacks.onPlanAccepted(turnId),
      onCancel: () => void this.interrupt(),
    });
  }

  get currentState(): ClaudeSessionState {
    return this.state;
  }

  get activeTurnId(): string | null {
    return this.currentTurnId;
  }

  get resolvedSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * True while a turn is in flight or winding down — the pool must not close it for
   * capacity, and no new turn may start. "awaiting-idle" is included because after a
   * self-interrupt the session parks there until the iterator throws (or the watchdog
   * fires); dispatching into it would race the imminent teardown and lose the message.
   */
  get busy(): boolean {
    return (
      this.state === "starting" ||
      this.state === "streaming" ||
      this.state === "interrupting" ||
      this.state === "awaiting-idle"
    );
  }

  /**
   * The current-or-most-recent turn's items + progress. It survives turn completion
   * (until the next turn replaces the projector) so a read right after completion does
   * not race the SDK's transcript-file flush, which lags the `result` message. The
   * backend decides the turn's status from {@link activeTurnId}.
   */
  renderedTurn(): { turnId: string; items: ActivityItem[]; progress: TurnProgress } | null {
    if (!this.liveTurnProjector) return null;
    return {
      turnId: this.liveTurnProjector.turnId,
      items: this.liveTurnProjector.items,
      progress: this.liveTurnProjector.progress,
    };
  }

  /** Dispatches a user turn (turnId chosen by the backend); returns it. */
  startTurn(text: string, images: string[], turnId: string = randomUUID()): string {
    // Only an idle session accepts a turn. A closed/busy/awaiting-idle session rejects so
    // the queue re-queues and re-drains once a fresh session is idle (self-healing) — this
    // is what closes the interrupt+queue race (a terminal thread.upserted must not dispatch
    // into a dying session).
    if (this.state !== "idle") throw new TurnInProgressError();
    this.currentTurnId = turnId;
    this.turnCompleted = false;
    this.interruptRequested = false;
    this.clearIdleTimer();
    this.state = "starting";

    const projector = new ClaudeLiveTurn(turnId, this.options.cwd);
    this.liveTurnProjector = projector;
    for (const item of projector.prompt(text, images)) {
      this.options.callbacks.onActivity(item, turnId);
    }
    this.options.callbacks.onProgress(projector.progress, turnId);

    if (!this.query) this.startQuery();
    this.input!.push(userMessage(text, images, turnId));
    this.state = "streaming";
    return turnId;
  }

  /**
   * Updates the session's permission mode. Stored for the next `query` and, if one is live
   * (streaming input), forwarded to it so the change applies to the next tool decision.
   */
  setPermissionMode(mode: string): void {
    this.permissionMode = mode;
    void this.query?.setPermissionMode?.(mode).catch(() => {
      // A stale/closing query rejects; the stored mode still seeds the next query.
    });
  }

  /** Interrupts the running turn (receipt fast-path, watchdog force-abort fallback). */
  async interrupt(): Promise<void> {
    if (this.state !== "streaming" && this.state !== "starting") return;
    this.interruptRequested = true;
    this.state = "interrupting";
    this.armWatchdog();
    try {
      // The interrupt() receipt resolving does NOT clear the watchdog by design — only the
      // error_during_execution result arriving (→ finishTurn) does. The watchdog is the
      // force-close backstop for the case where that result never comes.
      await this.query?.interrupt();
    } catch {
      // Interrupt control-request failed; the watchdog force-aborts.
    }
  }

  /** Closes the session cleanly (idempotent). Completes any live turn as interrupted. */
  close(reason: string): void {
    if (this.closing) return;
    this.closing = true;
    this.clearIdleTimer();
    this.clearWatchdog();
    // A turn still live at teardown reads as interrupted (session death mid-turn).
    if (this.currentTurnId && !this.turnCompleted) this.finishTurn("interrupted");
    this.state = "closed";
    this.attention.dispose();
    this.input?.end();
    this.abortController.abort();
    this.options.callbacks.onSessionClosed(reason);
  }

  private startQuery(): void {
    const input = createInput();
    this.input = input;
    this.query = this.options.sdk.query({
      prompt: input.iterable,
      options: {
        cwd: this.options.cwd,
        ...(this.options.model ? { model: this.options.model } : {}),
        ...(this.options.effort ? { effort: this.options.effort } : {}),
        permissionMode: this.permissionMode,
        pathToClaudeCodeExecutable: this.options.bin,
        settingSources: [],
        strictMcpConfig: true,
        includePartialMessages: true,
        abortController: this.abortController,
        canUseTool: (
          toolName: string,
          toolInput: Record<string, unknown>,
          opts: { toolUseID: string },
        ) => this.attention.request(this.currentTurnId ?? "", toolName, toolInput, opts.toolUseID),
        stderr: (data: string) => {
          this.stderrTail = `${this.stderrTail}${data}`.slice(-2_000);
        },
        ...(this.sessionId ? { resume: this.sessionId } : {}),
      },
    });
    void this.consume();
  }

  private async consume(): Promise<void> {
    try {
      for await (const message of this.query!) {
        this.handleMessage(message as SdkMessage);
      }
      this.close("input-ended");
    } catch (error) {
      this.handleIteratorError(error);
    }
  }

  private handleMessage(message: SdkMessage): void {
    switch (message.type) {
      case "system":
        if (message.subtype === "init" && typeof message.session_id === "string") {
          this.sessionId = message.session_id;
          this.options.callbacks.onInit(message.session_id);
        }
        return;
      case "assistant":
        this.ingestStructural(this.liveTurnProjector?.ingestAssistant(toTranscript(message)));
        return;
      case "user":
        // SDKUserMessageReplay (isReplay) re-emits an earlier message; projecting it would
        // duplicate the prompt and shift every later ordinal, so drop it.
        if (message.isReplay) return;
        this.ingestStructural(this.liveTurnProjector?.ingestToolResult(toTranscript(message)));
        return;
      case "stream_event":
        this.handleStreamEvent(message);
        return;
      case "result":
        this.handleResult(message);
        return;
      default:
        return;
    }
  }

  private handleStreamEvent(message: SdkMessage): void {
    if (message.parent_tool_use_id) return; // sub-agent stream; not projected on the main thread
    const event = message.event;
    if (!isRecord(event) || event.type !== "content_block_delta") return;
    const delta = event.delta;
    if (!isRecord(delta) || !this.currentTurnId || !this.liveTurnProjector) return;
    let item: ActivityItem | null = null;
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      item = this.liveTurnProjector.streamDelta("text", delta.text);
    } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
      item = this.liveTurnProjector.streamDelta("thinking", delta.thinking);
    }
    if (item) this.options.callbacks.onActivity(item, this.currentTurnId);
  }

  private ingestStructural(items: ActivityItem[] | undefined): void {
    if (!items || !this.currentTurnId || !this.liveTurnProjector) return;
    for (const item of items) this.options.callbacks.onActivity(item, this.currentTurnId);
    this.options.callbacks.onProgress(this.liveTurnProjector.progress, this.currentTurnId);
  }

  private handleResult(message: SdkMessage): void {
    const outcome: ThreadOutcome = this.interruptRequested
      ? "interrupted"
      : message.subtype === "success"
        ? "completed"
        : "failed";
    const errorDetail = outcome === "failed" ? resultErrorDetail(message) : undefined;
    this.finishTurn(outcome, errorDetail);
    // A self-interrupt kills the iterator next (it throws); a normal result returns the
    // session to idle so it can accept the next turn.
    if (!this.interruptRequested) {
      this.state = "idle";
      this.armIdleTimer();
    }
  }

  private handleIteratorError(error: unknown): void {
    this.clearWatchdog();
    if (this.interruptRequested) {
      // Self-initiated interrupt: the turn already completed as interrupted.
      this.close("interrupted");
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    if (this.currentTurnId && !this.turnCompleted) {
      this.options.callbacks.onActivity(errorItem(this.currentTurnId, detail), this.currentTurnId);
      this.finishTurn("failed", detail);
    }
    if (AUTH_ERROR.test(`${detail} ${this.stderrTail}`)) {
      this.options.callbacks.onAuthError(AUTH_MESSAGE);
    }
    this.close("failed");
  }

  private finishTurn(outcome: ThreadOutcome, errorDetail?: string): void {
    if (!this.currentTurnId || this.turnCompleted) return;
    const turnId = this.currentTurnId;
    this.turnCompleted = true;
    const finalized = this.liveTurnProjector?.finalize();
    if (finalized) this.options.callbacks.onActivity(finalized, turnId);
    // On a self-interrupt keep the watchdog armed: the session parks in awaiting-idle until
    // the iterator throws (handleIteratorError clears it) — if that throw never lands, the
    // watchdog is the only thing that force-closes the session instead of parking forever.
    if (!this.interruptRequested) this.clearWatchdog();
    this.attention.expire();
    this.state = "awaiting-idle";
    this.currentTurnId = null;
    this.options.callbacks.onTurnComplete(outcome, turnId, errorDetail);
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (this.state === "idle") this.close("idle-timeout");
    }, this.options.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    this.watchdogTimer = setTimeout(() => {
      this.abortController.abort();
      this.close("interrupt-watchdog");
    }, this.options.watchdogMs ?? INTERRUPT_WATCHDOG_MS);
    this.watchdogTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = undefined;
  }
}

/** Structural view of the SDK messages the session reads (SDK typings stay in sdk.ts). */
interface SdkMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  uuid?: string;
  parent_tool_use_id?: string | null;
  isReplay?: boolean;
  message?: { role?: string; content?: unknown; stop_reason?: string | null };
  event?: unknown;
  errors?: unknown;
  result?: unknown;
}

/** Maps an SDK assistant/user message to the transcript shape the projection consumes. */
function toTranscript(message: SdkMessage): ClaudeTranscriptMessage {
  const api = message.message ?? {};
  return {
    type: message.type === "assistant" ? "assistant" : "user",
    uuid: message.uuid ?? randomUUID(),
    session_id: message.session_id ?? "",
    message: {
      role: message.type === "assistant" ? "assistant" : "user",
      content: (api.content ?? []) as never,
      stop_reason: api.stop_reason ?? null,
    },
    parent_tool_use_id: message.parent_tool_use_id ?? null,
    parent_agent_id: null,
    timestamp: new Date().toISOString(),
  };
}

function resultErrorDetail(message: SdkMessage): string | undefined {
  if (Array.isArray(message.errors) && message.errors.length) return String(message.errors[0]);
  if (typeof message.subtype === "string") return message.subtype;
  return undefined;
}

function errorItem(turnId: string, message: string): ActivityItem {
  return { type: "error", id: `${turnId}-error-${Date.now()}`, status: "failed", message };
}

function userMessage(text: string, images: string[], uuid: string): unknown {
  const content: Array<Record<string, unknown>> = [];
  if (text.trim()) content.push({ type: "text", text: text.trim() });
  for (const url of images) {
    const source = parseImageDataUrl(url);
    if (source) content.push({ type: "image", source });
  }
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null, uuid };
}

function createInput(): PushableInput {
  const queue: unknown[] = [];
  let notify: (() => void) | null = null;
  let done = false;
  const iterable = (async function* () {
    while (true) {
      while (queue.length) yield queue.shift();
      if (done) return;
      await new Promise<void>((resolve) => (notify = resolve));
      notify = null;
    }
  })();
  return {
    iterable,
    push(message: unknown) {
      queue.push(message);
      notify?.();
      notify = null;
    },
    end() {
      done = true;
      notify?.();
      notify = null;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
