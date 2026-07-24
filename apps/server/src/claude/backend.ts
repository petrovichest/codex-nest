import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import { DEFAULT_SESSION_SETTINGS } from "@codexnest/protocol";
import type {
  ConnectionView,
  ModelOption,
  ServerEvent,
  SessionSettings,
  ThreadDetail,
  ThreadDraft,
  ThreadOutcome,
  ThreadState,
  ThreadSummary,
  TurnStartResult,
  TurnView,
  UpdateThreadDraftRequest,
  UserInputQuestion,
} from "@codexnest/protocol";

import type { FastifyBaseLogger } from "fastify";

import type { AttentionManager } from "../attention";
import type { AgentBackend, TurnInput } from "../backends/backend";
import {
  BackendUnavailableError,
  ThreadNotFoundError,
  UnsupportedForAgentError,
} from "../backends/backend";
import {
  deleteThreadMeta,
  markThreadRead,
  markThreadViewed,
  setThreadDraft,
  setThreadPinned,
  setThreadSettings,
} from "../backends/thread-meta";
import { safeError } from "../logging";
import type {
  ClaudeSessionState,
  CodexNestState,
  StateStore,
  TimelineArtifact,
} from "../state/store";
import { buildClaudeTurns, paginateClaudeTurns } from "./projection";
import { deleteClaudeSession, patchClaudeSession, upsertClaudeSession } from "./registry";
import { ClaudeVersionError, readClaudeVersion, type ClaudeSdk, type VersionRunner } from "./sdk";
import { ClaudeSession, type ClaudeSessionCallbacks } from "./session";
import type { ClaudeTitleGenerator } from "./title";

const CLI_MISSING = "Claude Code CLI не найден. Установите и выполните вход: claude login";
const STEER_UNSUPPORTED = "Claude Code не поддерживает изменение хода на лету";
const GOAL_UNSUPPORTED = "Цели доступны только в Codex";
/** Bounds retained transcripts (parsed TurnViews can hold base64 images) to ~8 threads. */
const TRANSCRIPT_CACHE_LIMIT = 8;
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_SESSIONS = 3;

export interface ClaudeProbeResult {
  version: string | null;
  unavailableReason: string | null;
}

export interface ClaudeBackendDeps {
  store: StateStore;
  sdk: ClaudeSdk;
  models: ModelOption[];
  bin: string;
  attention: AttentionManager;
  idleTimeoutMs?: number;
  maxSessions?: number;
  titles?: Pick<ClaudeTitleGenerator, "generate">;
  runVersion?: VersionRunner;
  log?: Pick<FastifyBaseLogger, "warn">;
}

interface TranscriptCacheEntry {
  cacheKey: string;
  turns: TurnView[];
}

interface PooledSession {
  session: ClaudeSession;
  lastActivityAt: number;
}

export class ClaudeBackend extends EventEmitter implements AgentBackend {
  readonly agent = "claude" as const;

  private readonly store: StateStore;
  private readonly sdk: ClaudeSdk;
  private readonly modelList: ModelOption[];
  private readonly bin: string;
  private readonly attention: AttentionManager;
  private readonly idleTimeoutMs: number;
  private readonly maxSessions: number;
  private readonly titles?: Pick<ClaudeTitleGenerator, "generate">;
  private readonly runVersion?: VersionRunner;
  private log?: Pick<FastifyBaseLogger, "warn">;
  private connectionState: ConnectionView = { state: "starting", message: null, syncedAt: null };
  private lastProbe: ClaudeProbeResult = { version: null, unavailableReason: null };
  private readonly transcriptCache = new Map<string, TranscriptCacheEntry>();
  private readonly sessions = new Map<string, PooledSession>();
  private readonly lastActivityAt = new Map<string, number>();
  private probePromise?: Promise<ClaudeProbeResult>;

  constructor(deps: ClaudeBackendDeps) {
    super();
    this.store = deps.store;
    this.sdk = deps.sdk;
    this.modelList = deps.models;
    this.bin = deps.bin;
    this.attention = deps.attention;
    this.idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxSessions = deps.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.titles = deps.titles;
    this.runVersion = deps.runVersion;
    this.log = deps.log;
  }

  setLogger(logger: Pick<FastifyBaseLogger, "warn">): void {
    this.log = logger;
  }

  get connection(): ConnectionView {
    return this.connectionState;
  }

  get models(): ModelOption[] {
    return this.modelList;
  }

  get newSessionSettings(): SessionSettings {
    const model = this.modelList.find((candidate) => candidate.isDefault) ?? this.modelList[0];
    const effort = model?.reasoningEfforts.find((option) => option.isDefault)?.value;
    return {
      ...DEFAULT_SESSION_SETTINGS,
      ...(model ? { model: model.id } : {}),
      ...(effort ? { reasoningEffort: effort } : {}),
    };
  }

  async start(): Promise<void> {
    // If index.ts already probed (to decide auto-mode enablement), reuse that result and
    // just seed the hub; otherwise probe now. Either way the CLI is probed exactly once.
    if (this.connectionState.state === "starting") await this.probe();
    else this.publish({ type: "connection.changed", connection: this.connectionState });
    this.publish({ type: "models.changed", models: this.models });
  }

  stop(): void {
    for (const pooled of [...this.sessions.values()]) pooled.session.close("shutdown");
  }

  async sync(): Promise<void> {
    await this.probe();
    this.republishThreads();
  }

  /** Runs the version probe (in-flight deduped), updates connection state, returns it. */
  probe(): Promise<ClaudeProbeResult> {
    if (this.probePromise) return this.probePromise;
    this.probePromise = this.runProbe().finally(() => {
      this.probePromise = undefined;
    });
    return this.probePromise;
  }

  private async runProbe(): Promise<ClaudeProbeResult> {
    try {
      const version = await readClaudeVersion(this.bin, this.runVersion);
      this.lastProbe = { version, unavailableReason: null };
      this.connectionState = { state: "ready", message: null, syncedAt: new Date().toISOString() };
    } catch (error) {
      const unavailableReason =
        error instanceof ClaudeVersionError && error.kind === "parse" ? error.message : CLI_MISSING;
      this.lastProbe = { version: null, unavailableReason };
      this.connectionState = {
        state: "unavailable",
        message: unavailableReason,
        syncedAt: this.connectionState.syncedAt,
      };
    }
    this.publish({ type: "connection.changed", connection: this.connectionState });
    return this.lastProbe;
  }

  currentProbe(): ClaudeProbeResult {
    return this.lastProbe;
  }

  /** Number of live sessions retained in the pool (diagnostics + capacity assertions). */
  get openSessionCount(): number {
    return this.sessions.size;
  }

  owns(threadId: string): boolean {
    return this.entry(threadId) !== undefined;
  }

  threads(): ThreadSummary[] {
    const state = this.store.snapshot();
    const sessions = state.claudeSessions ?? {};
    return Object.keys(sessions).map((threadId) =>
      this.toSummary(threadId, sessions[threadId]!, state),
    );
  }

  summary(threadId: string): ThreadSummary | undefined {
    const state = this.store.snapshot();
    const entry = state.claudeSessions?.[threadId];
    return entry ? this.toSummary(threadId, entry, state) : undefined;
  }

  async readThread(threadId: string, cursor?: string | null): Promise<ThreadDetail> {
    const state = this.store.snapshot();
    const entry = state.claudeSessions?.[threadId];
    if (!entry) throw new ThreadNotFoundError();
    const summary = this.toSummary(threadId, entry, state);
    const draft = state.threadMeta[threadId]?.draft ?? null;
    const queuedMessages = state.messageQueues?.[threadId] ?? [];
    const artifacts = state.threadMeta[threadId]?.timelineArtifacts ?? {};

    let turns: TurnView[] = entry.sessionId ? await this.loadTurns(threadId, entry) : [];
    const session = this.sessions.get(threadId)?.session;
    const rendered = session?.renderedTurn() ?? null;
    if (rendered) {
      // Overlay the live projector's view of the current-or-most-recent turn. It is
      // authoritative (converged item ids) and — crucially for a read right after
      // completion — complete before the transcript file has flushed the final messages.
      const active = session!.activeTurnId === rendered.turnId;
      const startedAt = rendered.progress.startedAt;
      const completedAt = active ? null : (this.lastActivityAt.get(threadId) ?? null);
      const view: TurnView = {
        id: rendered.turnId,
        status: active ? "inProgress" : (state.threadMeta[threadId]?.lastOutcome ?? "completed"),
        startedAt,
        completedAt,
        durationMs:
          startedAt !== null && completedAt !== null ? Math.max(0, completedAt - startedAt) : null,
        progress: rendered.progress,
        items: rendered.items,
      };
      const index = turns.findIndex((turn) => turn.id === view.id);
      if (index >= 0) turns[index] = view;
      else turns.push(view);
    }
    turns = turns.map((turn) => mergeArtifacts(turn, artifacts[turn.id] ?? []));
    const page = paginateClaudeTurns(turns, cursor ?? null);
    return {
      summary,
      turns: page.turns,
      queuedMessages,
      olderTurnsCursor: page.olderTurnsCursor,
      draft,
    };
  }

  async createThread(
    projectId: string,
    cwd: string,
    settings: SessionSettings,
  ): Promise<ThreadSummary> {
    const reusable = this.findReusableThread(projectId);
    const threadId = reusable ?? randomUUID();
    if (reusable) {
      // Reused empty thread may predate a project path change — keep cwd current.
      if (this.entry(reusable)?.cwd !== cwd) {
        await patchClaudeSession(this.store, threadId, { cwd });
      }
    } else {
      const entry: ClaudeSessionState = {
        sessionId: null,
        cwd,
        projectId,
        createdAt: Date.now(),
        title: null,
        preview: "",
        archived: false,
      };
      await upsertClaudeSession(this.store, threadId, entry);
    }
    await setThreadSettings(this.store, threadId, settings);
    this.publishThread(threadId);
    return this.summary(threadId)!;
  }

  async startTurn(
    threadId: string,
    input: TurnInput,
    options?: { goal?: boolean },
  ): Promise<TurnStartResult> {
    if (options?.goal) throw new UnsupportedForAgentError(GOAL_UNSUPPORTED);
    const entry = this.entry(threadId);
    if (!entry) throw new ThreadNotFoundError();
    if (this.connectionState.state !== "ready") {
      throw new BackendUnavailableError(this.pauseReason() ?? CLI_MISSING);
    }
    const state = this.store.snapshot();
    const settings = state.threadMeta[threadId]?.settings ?? this.newSessionSettings;
    const firstTurn = !entry.sessionId && entry.preview.trim() === "";
    const session = this.getOrCreateSession(threadId, entry, settings);
    const turnId = turnUuidFor(input.clientMessageId);

    this.lastActivityAt.set(threadId, Date.now());
    session.startTurn(input.text, input.images, turnId);

    if (firstTurn && input.text.trim()) {
      void patchClaudeSession(this.store, threadId, { preview: preview(input.text) }).then(() =>
        this.publishThread(threadId),
      );
      this.scheduleTitle(threadId, input.text, entry.cwd);
    }
    this.publishThread(threadId);
    return { turnId };
  }

  steerTurn(): Promise<string> {
    // Claude has no live steering; the queue delivers the next message at turn boundaries.
    return Promise.reject(new UnsupportedForAgentError(STEER_UNSUPPORTED));
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    const pooled = this.sessions.get(threadId);
    // Guard the turn id: a stale interrupt (its turn already finished, a queued one now
    // running) must not kill the wrong turn.
    if (!pooled || pooled.session.activeTurnId !== turnId) return;
    // Deny-settle the thread's pending attention BEFORE awaiting interrupt: if the CLI is
    // blocked inside canUseTool it may not ack the interrupt control-request, so resolving
    // the pending approval first lets the turn unwind instead of stalling until the watchdog.
    this.attention.expireByThread(threadId);
    await pooled.session.interrupt();
  }

  async renameThread(threadId: string, name: string): Promise<void> {
    this.assertOwned(threadId);
    await patchClaudeSession(this.store, threadId, { title: name });
    this.publishThread(threadId);
  }

  async deleteThread(threadId: string): Promise<void> {
    this.assertOwned(threadId);
    this.sessions.get(threadId)?.session.close("thread-deleted");
    await deleteClaudeSession(this.store, threadId);
    await deleteThreadMeta(this.store, threadId);
    this.transcriptCache.delete(threadId);
    this.lastActivityAt.delete(threadId);
    this.publish({ type: "thread.removed", threadId });
  }

  async setArchived(threadId: string, archived: boolean): Promise<void> {
    this.assertOwned(threadId);
    await patchClaudeSession(this.store, threadId, { archived });
    this.publishThread(threadId);
  }

  async setSettings(threadId: string, settings: SessionSettings): Promise<ThreadSummary> {
    this.assertOwned(threadId);
    await setThreadSettings(this.store, threadId, settings);
    this.publishThread(threadId);
    return this.summary(threadId)!;
  }

  setDraft(threadId: string, value: UpdateThreadDraftRequest): Promise<ThreadDraft | null> {
    this.assertOwned(threadId);
    return setThreadDraft(this.store, threadId, value);
  }

  async markRead(threadId: string, observedUpdatedAt: number): Promise<void> {
    const summary = this.summary(threadId);
    if (!summary) throw new ThreadNotFoundError();
    await markThreadRead(this.store, threadId, Math.min(observedUpdatedAt, summary.updatedAt));
    this.publishThread(threadId);
  }

  async markViewed(threadId: string, observedUpdatedAt: number): Promise<void> {
    const summary = this.summary(threadId);
    if (!summary) throw new ThreadNotFoundError();
    await markThreadViewed(this.store, threadId, Math.min(observedUpdatedAt, summary.updatedAt));
    this.publishThread(threadId);
  }

  async setPinned(threadId: string, pinned: boolean): Promise<void> {
    this.assertOwned(threadId);
    await setThreadPinned(this.store, threadId, pinned);
    this.publishThread(threadId);
  }

  recordAttentionResponse(): Promise<void> {
    // The live session's attention layer already records the userInputResponse artifact
    // and maps the SDK PermissionResult when the request settles; nothing to do here.
    return Promise.resolve();
  }

  pauseReason(): string | null {
    if (this.connectionState.state === "ready") return null;
    return this.connectionState.message ?? CLI_MISSING;
  }

  currentTurnId(threadId: string): string | null {
    return this.sessions.get(threadId)?.session.activeTurnId ?? null;
  }

  async wasDelivered(threadId: string, messageId: string): Promise<boolean> {
    const entry = this.entry(threadId);
    if (!entry?.sessionId) return false;
    const turnUuid = turnUuidFor(messageId);
    try {
      const messages = await this.sdk.getSessionMessages(entry.sessionId, { dir: entry.cwd });
      return messages.some(
        (message) =>
          message.type === "user" &&
          message.uuid === turnUuid &&
          message.parent_tool_use_id === null,
      );
    } catch {
      return false;
    }
  }

  // --- Session pool + live-turn plumbing ---

  private getOrCreateSession(
    threadId: string,
    entry: ClaudeSessionState,
    settings: SessionSettings,
  ): ClaudeSession {
    const existing = this.sessions.get(threadId);
    if (existing) {
      existing.lastActivityAt = Date.now();
      return existing.session;
    }
    this.enforcePoolCap();
    const session = new ClaudeSession({
      threadId,
      cwd: entry.cwd,
      sessionId: entry.sessionId,
      model: settings.model,
      effort: settings.reasoningEffort,
      permissionMode: settings.collaborationMode === "plan" ? "plan" : "default",
      bin: this.bin,
      idleTimeoutMs: this.idleTimeoutMs,
      sdk: this.sdk,
      attention: this.attention,
      callbacks: this.sessionCallbacks(threadId),
    });
    this.sessions.set(threadId, { session, lastActivityAt: Date.now() });
    return session;
  }

  /** Caps idle-session retention; a fully-busy pool still admits the new session. */
  private enforcePoolCap(): void {
    if (this.sessions.size < this.maxSessions) return;
    const idle = [...this.sessions.values()]
      .filter((pooled) => !pooled.session.busy)
      .sort((a, b) => a.lastActivityAt - b.lastActivityAt);
    idle[0]?.session.close("pool-evicted");
  }

  private sessionCallbacks(threadId: string): ClaudeSessionCallbacks {
    return {
      onInit: (sessionId) => {
        if (this.entry(threadId)?.sessionId !== sessionId) {
          void patchClaudeSession(this.store, threadId, { sessionId });
        }
      },
      onActivity: (item, turnId) => {
        this.lastActivityAt.set(threadId, Date.now());
        this.publish({ type: "activity.upserted", threadId, turnId, item });
      },
      onProgress: (progress, turnId) => {
        this.publish({ type: "turn.progressed", threadId, turnId, progress });
      },
      onTurnComplete: (outcome) => {
        void this.completeTurn(threadId, outcome);
      },
      onSessionClosed: () => this.onSessionClosed(threadId),
      onUserInputResponse: (turnId, itemId, questions, answers) => {
        void this.recordUserInput(threadId, turnId, itemId, questions, answers);
      },
      onPlanAccepted: () => {
        void this.acceptPlan(threadId);
      },
      onAuthError: (message) => this.setAuthError(message),
    };
  }

  private async completeTurn(threadId: string, outcome: ThreadOutcome): Promise<void> {
    const at = Date.now();
    this.lastActivityAt.set(threadId, at);
    await this.store.update((state) => {
      const meta = state.threadMeta[threadId] ?? { pinned: false, lastReadUpdatedAt: 0 };
      meta.lastOutcome = outcome;
      meta.outcomeUpdatedAt = at;
      state.threadMeta[threadId] = meta;
    });
    // The completed turn is now in the transcript — drop the cache so the next read merges it.
    this.transcriptCache.delete(threadId);
    this.publishThread(threadId);
  }

  private onSessionClosed(threadId: string): void {
    this.sessions.delete(threadId);
    this.attention.expireByThread(threadId);
    this.publishThread(threadId);
  }

  private async recordUserInput(
    threadId: string,
    turnId: string,
    itemId: string,
    questions: UserInputQuestion[],
    answers: Record<string, string[]>,
  ): Promise<void> {
    const item: TimelineArtifact = {
      type: "userInputResponse",
      id: `${itemId || turnId}-response`,
      status: "completed",
      entries: questions.map((question) => ({
        header: question.header,
        question: question.question,
        answers: answers[question.id] ?? [],
      })),
      timestamp: Date.now(),
      afterItemId: itemId || null,
    };
    await this.upsertArtifact(threadId, turnId, item);
    this.publish({ type: "activity.upserted", threadId, turnId, item });
  }

  private async acceptPlan(threadId: string): Promise<void> {
    const settings = this.store.snapshot().threadMeta[threadId]?.settings;
    if (settings?.collaborationMode !== "plan") return;
    await setThreadSettings(this.store, threadId, { ...settings, collaborationMode: "default" });
    this.publishThread(threadId);
  }

  private setAuthError(message: string): void {
    this.connectionState = {
      state: "unavailable",
      message,
      syncedAt: this.connectionState.syncedAt,
    };
    this.publish({ type: "connection.changed", connection: this.connectionState });
  }

  private scheduleTitle(threadId: string, input: string, cwd: string): void {
    if (!this.titles || !input.trim() || this.entry(threadId)?.title) return;
    void this.titles
      .generate(input, { cwd })
      .then(async (name) => {
        if (this.entry(threadId)?.title) return; // user renamed while generating
        await patchClaudeSession(this.store, threadId, { title: name });
        this.publishThread(threadId);
      })
      .catch((error: unknown) => {
        this.log?.warn(
          { err: safeError(error), threadId },
          "Failed to generate Claude thread title",
        );
      });
  }

  private async upsertArtifact(
    threadId: string,
    turnId: string,
    item: TimelineArtifact,
  ): Promise<void> {
    await this.store.update((state) => {
      const meta = state.threadMeta[threadId] ?? { pinned: false, lastReadUpdatedAt: 0 };
      meta.timelineArtifacts ??= {};
      const items = meta.timelineArtifacts[turnId] ?? [];
      const index = items.findIndex((candidate) => candidate.id === item.id);
      meta.timelineArtifacts[turnId] =
        index < 0
          ? [...items, item]
          : items.map((candidate, i) => (i === index ? item : candidate));
      state.threadMeta[threadId] = meta;
    });
  }

  private async loadTurns(threadId: string, entry: ClaudeSessionState): Promise<TurnView[]> {
    const info = await this.sdk.getSessionInfo(entry.sessionId!, { dir: entry.cwd });
    const cacheKey = info ? `${info.lastModified}:${info.fileSize ?? 0}` : null;
    const cached = this.transcriptCache.get(threadId);
    if (cacheKey && cached && cached.cacheKey === cacheKey) {
      this.touchCache(threadId, cached);
      return [...cached.turns];
    }
    const messages = await this.sdk.getSessionMessages(entry.sessionId!, { dir: entry.cwd });
    const turns = buildClaudeTurns(messages, entry.cwd);
    if (cacheKey) this.touchCache(threadId, { cacheKey, turns });
    else this.transcriptCache.delete(threadId);
    return [...turns];
  }

  /** Inserts/refreshes a cache entry and evicts the least-recently-used over the cap. */
  private touchCache(threadId: string, entry: TranscriptCacheEntry): void {
    this.transcriptCache.delete(threadId);
    this.transcriptCache.set(threadId, entry);
    while (this.transcriptCache.size > TRANSCRIPT_CACHE_LIMIT) {
      const oldest = this.transcriptCache.keys().next().value;
      if (oldest === undefined) break;
      this.transcriptCache.delete(oldest);
    }
  }

  private findReusableThread(projectId: string): string | null {
    const state = this.store.snapshot();
    const sessions = state.claudeSessions ?? {};
    for (const [threadId, entry] of Object.entries(sessions)) {
      if (
        entry.projectId === projectId &&
        entry.sessionId === null &&
        !entry.archived &&
        !entry.title &&
        entry.preview.trim() === "" &&
        (state.messageQueues?.[threadId]?.length ?? 0) === 0
      ) {
        return threadId;
      }
    }
    return null;
  }

  private toSummary(
    threadId: string,
    entry: ClaudeSessionState,
    state: CodexNestState,
  ): ThreadSummary {
    const meta = state.threadMeta[threadId] ?? { pinned: false, lastReadUpdatedAt: 0 };
    const currentTurnId = this.sessions.get(threadId)?.session.activeTurnId ?? null;
    const updatedAt = Math.max(
      entry.createdAt,
      meta.outcomeUpdatedAt ?? 0,
      this.lastActivityAt.get(threadId) ?? 0,
    );
    const threadState = this.threadState(threadId, currentTurnId, meta.lastOutcome);
    const unread = updatedAt > meta.lastReadUpdatedAt && isTerminal(threadState);
    return {
      id: threadId,
      agent: "claude",
      projectId: entry.projectId,
      title: entry.title?.trim() || entry.preview.trim() || "Без названия",
      preview: entry.preview,
      cwd: entry.cwd,
      state: threadState,
      unread,
      unseen: unread && updatedAt > (meta.lastViewedUpdatedAt ?? 0),
      pinned: meta.pinned,
      archived: entry.archived,
      createdAt: entry.createdAt,
      updatedAt,
      currentTurnId,
      queuedMessageCount: state.messageQueues?.[threadId]?.length ?? 0,
      settings: meta.settings ?? this.newSessionSettings,
    };
  }

  private threadState(
    threadId: string,
    currentTurnId: string | null,
    lastOutcome: ThreadOutcome | undefined,
  ): ThreadState {
    if (
      this.attention
        .list()
        .some((item) => item.threadId === threadId && item.kind !== "unsupported")
    ) {
      return "needsAttention";
    }
    if (currentTurnId) return "running";
    return lastOutcome ?? "idle";
  }

  private entry(threadId: string): ClaudeSessionState | undefined {
    return this.store.snapshot().claudeSessions?.[threadId];
  }

  private assertOwned(threadId: string): void {
    if (!this.entry(threadId)) throw new ThreadNotFoundError();
  }

  private republishThreads(): void {
    for (const summary of this.threads()) {
      this.publish({ type: "thread.upserted", thread: summary });
    }
  }

  private publishThread(threadId: string): void {
    const summary = this.summary(threadId);
    if (summary) this.publish({ type: "thread.upserted", thread: summary });
  }

  private publish(event: ServerEvent): void {
    this.emit("event", event);
  }
}

/**
 * Derives a stable, RFC-4122-valid v4 turn id from the queue message id, so a crash
 * mid-dispatch lets `wasDelivered` recompute the same id and look it up in the transcript
 * without a durable field on the queue record. The version (4) and variant (10xx) nibbles
 * are set so a future CLI uuid-format validation cannot reject it. Direct turns with no
 * client id get a random id.
 */
function turnUuidFor(clientMessageId: string | null): string {
  if (!clientMessageId) return randomUUID();
  const hex = createHash("sha256").update(clientMessageId).digest("hex").slice(0, 32).split("");
  hex[12] = "4"; // version 4
  hex[16] = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16); // variant 10xx
  const h = hex.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Inserts timeline artifacts into a turn's items after their anchor (or at the end). */
function mergeArtifacts(turn: TurnView, artifacts: TimelineArtifact[]): TurnView {
  if (!artifacts.length) return turn;
  const items = [...turn.items];
  for (const artifact of artifacts) {
    if (items.some((item) => item.id === artifact.id)) continue;
    const anchor = artifact.afterItemId
      ? items.findIndex((item) => item.id === artifact.afterItemId)
      : -1;
    items.splice(anchor >= 0 ? anchor + 1 : items.length, 0, artifact);
  }
  return { ...turn, items };
}

function preview(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, 200);
}

function isTerminal(state: ThreadState): boolean {
  return state === "completed" || state === "failed" || state === "interrupted";
}
