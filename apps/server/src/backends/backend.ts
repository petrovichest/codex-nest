import type { EventEmitter } from "node:events";

import type {
  AgentId,
  AttentionRequest,
  AttentionResponse,
  ConnectionView,
  ModelOption,
  ServerEvent,
  SessionSettings,
  ThreadDetail,
  ThreadDraft,
  ThreadSummary,
  TurnStartResult,
  UpdateThreadDraftRequest,
} from "@codexnest/protocol";

export interface TurnInput {
  text: string;
  images: string[]; // data: URLs, exactly as validated by api.ts today
  clientMessageId: string | null;
}

/**
 * An agent backend owns a set of threads and turns them into normalized DTOs.
 * It emits "event" (event: ServerEvent) without a sequence — the hub assigns the
 * global sequence. In Stage 1 the only backend is Codex.
 */
export interface AgentBackend extends EventEmitter {
  readonly agent: AgentId;
  readonly connection: ConnectionView;
  readonly models: ModelOption[];
  readonly newSessionSettings: SessionSettings;

  // Typed "event" channel so payload drift fails at compile time. Other EventEmitter
  // events keep their inherited (untyped) signatures.
  on(event: "event", listener: (payload: ServerEvent) => void): this;
  off(event: "event", listener: (payload: ServerEvent) => void): this;
  emit(event: "event", payload: ServerEvent): boolean;

  start(): Promise<void>;
  stop(): void;
  sync(): Promise<void>;

  owns(threadId: string): boolean;
  threads(): ThreadSummary[];
  summary(threadId: string): ThreadSummary | undefined;
  readThread(threadId: string, cursor?: string | null): Promise<ThreadDetail>;

  createThread(projectId: string, cwd: string, settings: SessionSettings): Promise<ThreadSummary>;
  /** Starts a turn. `options.goal` is Codex-only; non-codex backends must reject it. */
  startTurn(
    threadId: string,
    input: TurnInput,
    options?: { goal?: boolean },
  ): Promise<TurnStartResult>;
  steerTurn(threadId: string, turnId: string, input: TurnInput): Promise<string>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  renameThread(threadId: string, name: string): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  setArchived(threadId: string, archived: boolean): Promise<void>;

  setSettings(threadId: string, settings: SessionSettings): Promise<ThreadSummary>;
  setDraft(threadId: string, value: UpdateThreadDraftRequest): Promise<ThreadDraft | null>;
  markRead(threadId: string, observedUpdatedAt: number): Promise<void>;
  markViewed(threadId: string, observedUpdatedAt: number): Promise<void>;
  setPinned(threadId: string, pinned: boolean): Promise<void>;
  recordAttentionResponse(request: AttentionRequest, response: AttentionResponse): Promise<void>;

  /** Reason turns are currently paused (e.g. maintenance), or null when they may run. */
  pauseReason(): string | null;
  currentTurnId(threadId: string): string | null;
  wasDelivered(threadId: string, messageId: string): Promise<boolean>;
}

/** Thrown when no backend owns a thread; api.ts maps it to 404 not_found. */
export class ThreadNotFoundError extends Error {
  constructor(message = "Thread not found") {
    super(message);
    this.name = "ThreadNotFoundError";
  }
}

/** Thrown when a backend does not support an operation; api.ts maps it to 409 conflict. */
export class UnsupportedForAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedForAgentError";
  }
}
