import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import { DEFAULT_SESSION_SETTINGS } from "@codexnest/protocol";
import type {
  ConnectionView,
  ModelOption,
  ServerEvent,
  SessionSettings,
  ThreadDetail,
  ThreadDraft,
  ThreadState,
  ThreadSummary,
  TurnStartResult,
  TurnView,
  UpdateThreadDraftRequest,
} from "@codexnest/protocol";

import type { FastifyBaseLogger } from "fastify";

import type { AgentBackend } from "../backends/backend";
import { ThreadNotFoundError, UnsupportedForAgentError } from "../backends/backend";
import {
  deleteThreadMeta,
  markThreadRead,
  markThreadViewed,
  setThreadDraft,
  setThreadPinned,
  setThreadSettings,
} from "../backends/thread-meta";
import type { ClaudeSessionState, StateStore } from "../state/store";
import { buildClaudeTurns, paginateClaudeTurns } from "./projection";
import { deleteClaudeSession, patchClaudeSession, upsertClaudeSession } from "./registry";
import { ClaudeVersionError, readClaudeVersion, type ClaudeSdk, type VersionRunner } from "./sdk";

const TURNS_UNSUPPORTED = "Ходы Claude появятся на следующем этапе";
const CLI_MISSING = "Claude Code CLI не найден. Установите и выполните вход: claude login";

export interface ClaudeProbeResult {
  version: string | null;
  unavailableReason: string | null;
}

export interface ClaudeBackendDeps {
  store: StateStore;
  sdk: ClaudeSdk;
  models: ModelOption[];
  bin: string;
  runVersion?: VersionRunner;
  log?: Pick<FastifyBaseLogger, "warn">;
}

interface TranscriptCacheEntry {
  cacheKey: string;
  turns: TurnView[];
}

export class ClaudeBackend extends EventEmitter implements AgentBackend {
  readonly agent = "claude" as const;

  private readonly store: StateStore;
  private readonly sdk: ClaudeSdk;
  private readonly modelList: ModelOption[];
  private readonly bin: string;
  private readonly runVersion?: VersionRunner;
  private log?: Pick<FastifyBaseLogger, "warn">;
  private connectionState: ConnectionView = { state: "starting", message: null, syncedAt: null };
  private lastProbe: ClaudeProbeResult = { version: null, unavailableReason: null };
  private readonly transcriptCache = new Map<string, TranscriptCacheEntry>();

  constructor(deps: ClaudeBackendDeps) {
    super();
    this.store = deps.store;
    this.sdk = deps.sdk;
    this.modelList = deps.models;
    this.bin = deps.bin;
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
    await this.probe();
    this.publish({ type: "models.changed", models: this.models });
  }

  stop(): void {
    // No long-lived resources in the read path; Stage 3 adds live sessions.
  }

  async sync(): Promise<void> {
    await this.probe();
    this.republishThreads();
  }

  /** Runs the version probe, updates connection state, and returns the outcome. */
  async probe(): Promise<ClaudeProbeResult> {
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

  owns(threadId: string): boolean {
    return this.entry(threadId) !== undefined;
  }

  threads(): ThreadSummary[] {
    const sessions = this.store.snapshot().claudeSessions ?? {};
    return Object.keys(sessions).map((threadId) => this.toSummary(threadId, sessions[threadId]!));
  }

  summary(threadId: string): ThreadSummary | undefined {
    const entry = this.entry(threadId);
    return entry ? this.toSummary(threadId, entry) : undefined;
  }

  async readThread(threadId: string, cursor?: string | null): Promise<ThreadDetail> {
    const entry = this.entry(threadId);
    if (!entry) throw new ThreadNotFoundError();
    const summary = this.toSummary(threadId, entry);
    const draft = this.store.snapshot().threadMeta[threadId]?.draft ?? null;
    if (!entry.sessionId) {
      return { summary, turns: [], queuedMessages: [], olderTurnsCursor: null, draft };
    }
    const turns = await this.loadTurns(threadId, entry);
    const page = paginateClaudeTurns(turns, cursor ?? null);
    return {
      summary,
      turns: page.turns,
      queuedMessages: [],
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
    if (!reusable) {
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

  // Live turns arrive in Stage 3; these reject/return constants so params are omitted.
  startTurn(): Promise<TurnStartResult> {
    return Promise.reject(new UnsupportedForAgentError(TURNS_UNSUPPORTED));
  }

  steerTurn(): Promise<string> {
    return Promise.reject(new UnsupportedForAgentError(TURNS_UNSUPPORTED));
  }

  interruptTurn(): Promise<void> {
    return Promise.reject(new UnsupportedForAgentError(TURNS_UNSUPPORTED));
  }

  async renameThread(threadId: string, name: string): Promise<void> {
    this.assertOwned(threadId);
    await patchClaudeSession(this.store, threadId, { title: name });
    this.publishThread(threadId);
  }

  async deleteThread(threadId: string): Promise<void> {
    this.assertOwned(threadId);
    await deleteClaudeSession(this.store, threadId);
    await deleteThreadMeta(this.store, threadId);
    this.transcriptCache.delete(threadId);
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
    const entry = this.entry(threadId);
    if (!entry) throw new ThreadNotFoundError();
    await markThreadRead(this.store, threadId, Math.min(observedUpdatedAt, entry.createdAt));
    this.publishThread(threadId);
  }

  async markViewed(threadId: string, observedUpdatedAt: number): Promise<void> {
    const entry = this.entry(threadId);
    if (!entry) throw new ThreadNotFoundError();
    await markThreadViewed(this.store, threadId, Math.min(observedUpdatedAt, entry.createdAt));
    this.publishThread(threadId);
  }

  async setPinned(threadId: string, pinned: boolean): Promise<void> {
    this.assertOwned(threadId);
    await setThreadPinned(this.store, threadId, pinned);
    this.publishThread(threadId);
  }

  recordAttentionResponse(): Promise<void> {
    // Claude attention lands in Stage 3.
    return Promise.resolve();
  }

  pauseReason(): string | null {
    return null;
  }

  currentTurnId(): string | null {
    return null;
  }

  wasDelivered(): Promise<boolean> {
    return Promise.resolve(false);
  }

  private async loadTurns(threadId: string, entry: ClaudeSessionState): Promise<TurnView[]> {
    const info = await this.sdk.getSessionInfo(entry.sessionId!, { dir: entry.cwd });
    const cacheKey = info ? `${info.lastModified}:${info.fileSize ?? 0}` : null;
    const cached = this.transcriptCache.get(threadId);
    if (cacheKey && cached && cached.cacheKey === cacheKey) return cached.turns;
    const messages = await this.sdk.getSessionMessages(entry.sessionId!, { dir: entry.cwd });
    const turns = buildClaudeTurns(messages, entry.cwd);
    if (cacheKey) this.transcriptCache.set(threadId, { cacheKey, turns });
    else this.transcriptCache.delete(threadId);
    return turns;
  }

  private findReusableThread(projectId: string): string | null {
    const sessions = this.store.snapshot().claudeSessions ?? {};
    for (const [threadId, entry] of Object.entries(sessions)) {
      if (
        entry.projectId === projectId &&
        entry.sessionId === null &&
        !entry.archived &&
        !entry.title &&
        entry.preview.trim() === ""
      ) {
        return threadId;
      }
    }
    return null;
  }

  private toSummary(threadId: string, entry: ClaudeSessionState): ThreadSummary {
    const state = this.store.snapshot();
    const meta = state.threadMeta[threadId] ?? { pinned: false, lastReadUpdatedAt: 0 };
    const updatedAt = entry.createdAt;
    const threadState: ThreadState = "idle";
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
      currentTurnId: null,
      queuedMessageCount: 0,
      settings: meta.settings ?? this.newSessionSettings,
    };
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

function isTerminal(state: ThreadState): boolean {
  return state === "completed" || state === "failed" || state === "interrupted";
}
