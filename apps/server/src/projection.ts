import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import { DEFAULT_SESSION_SETTINGS } from "@codexnest/protocol";
import type {
  ActivityItem,
  AttentionRequest,
  AttentionResponse,
  AppSnapshot,
  ModelOption,
  Project,
  QueuedMessage,
  SessionSettings,
  ServerEvent,
  TaskDefaults,
  ThreadChanges,
  ThreadDetail,
  ThreadDraft,
  UpdateThreadDraftRequest,
  ThreadGoal,
  ThreadOutcome,
  ThreadState,
  ThreadSummary,
  ThreadSyncPoint,
  TurnItemsResponse,
  TurnProgress,
  TurnView,
  UiLanguage,
  VoiceTranscriptionJob,
} from "@codexnest/protocol";

import type { AttentionManager } from "./attention";
import type { CodexBridge } from "./codex/bridge";
import type { ServerNotification } from "./codex/generated/index";
import type { Model, Thread, Turn } from "./codex/generated/v2/index";
import {
  parseModelList,
  parseThreadList,
  parseThreadLoadedList,
  parseThreadRead,
  parseThreadResume,
  parseTurnsList,
} from "./codex/guards";
import { RpcError } from "./codex/transport";
import { HistoryCache, type CachedTurnsPage } from "./history-cache";
import { pathContains, projectForCwd } from "./projects";
import type {
  CodexNestState,
  CodexNestStateView,
  DeepReadonly,
  SessionSnapshotState,
  StateStore,
  TimelineArtifact,
  VoiceTranscriptionState,
} from "./state/store";

interface CachedThread {
  thread: Thread;
  archived: boolean;
  currentTurnId: string | null;
  liveOutcome?: ThreadOutcome;
  goalStatus?: ThreadGoal["status"] | null;
}

const THREAD_TURN_PAGE_SIZE = 20;
const MANAGED_RECOVERY_DELAYS_MS = [1_000, 5_000, 30_000] as const;
const LOADED_RECOVERY_DELAYS_MS = [1_000, 5_000, 30_000] as const;

export class AppProjection extends EventEmitter {
  private readonly threads = new Map<string, CachedThread>();
  private readonly unmaterializedThreads = new Set<string>();
  private readonly activity = new Map<string, ActivityItem>();
  private readonly progress = new Map<string, TurnProgress>();
  private readonly historyRevisions = new Map<string, number>();
  private readonly subscribedThreads = new Set<string>();
  private readonly hiddenThreads = new Set<string>();
  private readonly pendingSubagentTitles = new Map<string, string>();
  private readonly subagentTitleUpdates = new Set<string>();
  private readonly deliveredNativeWaits = new Set<string>();
  private models: ModelOption[] = [];
  private sequence = 0;
  private syncedAt: string | null = null;
  private syncPromise?: Promise<void>;
  private recoverLoadedThreads = true;
  private loadedRecoveryAttempt = 0;
  private loadedRecoveryTimer?: NodeJS.Timeout;
  private managedRecoveryAttempt = 0;
  private managedRecoveryTimer?: NodeJS.Timeout;
  private readonly historyCache: HistoryCache;

  constructor(
    private readonly bridge: CodexBridge,
    private readonly store: StateStore,
    private readonly attention: AttentionManager,
    private readonly pushConfigured: boolean,
  ) {
    super();
    this.historyCache = new HistoryCache(store.path);
    for (const [threadId, meta] of Object.entries(store.view().threadMeta)) {
      if (!meta.sessionSnapshot) continue;
      this.threads.set(threadId, cachedThreadFromSessionSnapshot(threadId, meta.sessionSnapshot));
    }
    bridge.on("state", (state) => {
      if (state !== "ready") {
        if (this.loadedRecoveryTimer) clearTimeout(this.loadedRecoveryTimer);
        this.loadedRecoveryTimer = undefined;
        this.loadedRecoveryAttempt = 0;
        if (this.managedRecoveryTimer) clearTimeout(this.managedRecoveryTimer);
        this.managedRecoveryTimer = undefined;
        this.managedRecoveryAttempt = 0;
        this.subscribedThreads.clear();
        this.hiddenThreads.clear();
        this.pendingSubagentTitles.clear();
        this.subagentTitleUpdates.clear();
        for (const cached of this.threads.values()) cached.goalStatus = undefined;
      } else {
        this.recoverLoadedThreads = true;
        this.loadedRecoveryAttempt = 0;
        this.managedRecoveryAttempt = 0;
      }
      this.publish({ type: "connection.changed", connection: this.connection });
    });
    bridge.on("notification", (notification: ServerNotification) => {
      void this.onNotification(notification).catch((error: unknown) => {
        this.emit("projectionError", error instanceof Error ? error : new Error(String(error)));
      });
    });
    attention.on("upserted", (request) => {
      const cached = request.threadId ? this.threads.get(request.threadId) : undefined;
      if (cached && request.turnId) {
        cached.currentTurnId = request.turnId;
        cached.liveOutcome = undefined;
        cached.thread.status = { type: "active", activeFlags: [] };
      }
      if (!request.threadId) {
        this.publish({ type: "attention.upserted", attention: request });
        return;
      }
      const state = this.store.view();
      if (this.isThreadVisible(request.threadId, state)) {
        this.publish({ type: "attention.upserted", attention: request });
      }
      this.publishThread(request.threadId, state);
    });
    attention.on("removed", (attentionId: string) => {
      this.publish({ type: "attention.removed", attentionId });
      const state = this.store.view();
      for (const threadId of this.threads.keys()) this.publishThread(threadId, state);
    });
  }

  get connection(): AppSnapshot["connection"] {
    return {
      state: this.bridge.state,
      message: this.bridge.state === "ready" ? null : "Codex app-server недоступен",
      syncedAt: this.syncedAt,
    };
  }

  snapshot(): AppSnapshot {
    const state = this.store.view();
    const threads = this.sortedThreads(state).filter((thread) =>
      this.isCwdVisible(thread.cwd, state),
    );
    const visibleThreadIds = new Set(threads.map((thread) => thread.id));
    return {
      sequence: this.sequence,
      uiLanguage: state.uiLanguage,
      connection: this.connection,
      projects: cloneView<Project[]>(state.projects),
      threads,
      attention: this.attention
        .list()
        .filter((request) => !request.threadId || visibleThreadIds.has(request.threadId)),
      models: this.models,
      defaultReasoningEffort: state.defaultReasoningEffort,
      taskDefaults: state.taskDefaults ?? {},
      pushConfigured: this.pushConfigured,
      voiceTranscriptions: Object.values(state.voiceTranscriptions ?? {})
        .filter((job) => visibleThreadIds.has(job.threadId))
        .map(publicVoiceTranscription)
        .sort((left, right) => left.createdAt - right.createdAt),
    };
  }

  get threadCount(): number {
    return this.threads.size;
  }

  get lastSyncedAt(): string | null {
    return this.syncedAt;
  }

  get availableModels(): ModelOption[] {
    return structuredClone(this.models);
  }

  get newSessionSettings(): SessionSettings {
    const state = this.store.view();
    const settings = { ...DEFAULT_SESSION_SETTINGS, ...(state.taskDefaults ?? {}) };
    const reasoningEffort = state.defaultReasoningEffort;
    const model = this.models.find((candidate) => candidate.isDefault) ?? this.models[0];
    if (
      reasoningEffort &&
      (!model || model.reasoningEfforts.some((option) => option.value === reasoningEffort))
    ) {
      settings.reasoningEffort = reasoningEffort;
    }
    return settings;
  }

  summary(id: string): ThreadSummary | undefined {
    const cached = this.threads.get(id);
    return cached ? this.toSummary(cached) : undefined;
  }

  hasExplicitName(id: string): boolean {
    return !!this.threads.get(id)?.thread.name?.trim();
  }

  async sync(): Promise<void> {
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.performSync()
      .catch((error: unknown) => {
        if (this.recoverLoadedThreads) this.scheduleLoadedRecovery();
        throw error;
      })
      .finally(() => {
        this.syncPromise = undefined;
      });
    return this.syncPromise;
  }

  async readThread(id: string, cursor: string | null = null): Promise<ThreadDetail> {
    const local = this.threads.get(id);
    const meta = this.store.view().threadMeta[id];
    const subagent = local ? hasSubagentTranscript(local.thread, meta) : false;
    if (local && this.isUnmaterialized(id)) {
      const state = this.store.view();
      return {
        summary: this.toSummary(local),
        turns: [],
        queuedMessages: cloneView<QueuedMessage[]>(state.messageQueues?.[id] ?? []),
        olderTurnsCursor: null,
        draft: cloneView<ThreadDraft | null>(state.threadMeta[id]?.draft ?? null),
      };
    }
    const cached = this.threads.get(id);
    if (!cached) throw new Error("Thread not found");
    const page = await this.readTurnsPage(id, subagent ? null : cursor, "desc", !subagent);
    if (cursor === null) await this.restoreActiveTurnFromPage(cached, page.turns);
    const state = this.store.view();
    const visibleTurns = subagent
      ? subagentTranscriptTurnViews(cached.thread, page.turns, meta)
      : page.turns;
    const syncPoint =
      !subagent && cursor === null
        ? syncPointForPage(page.backwardsCursor, visibleTurns)
        : undefined;
    return {
      summary: this.toSummary(cached),
      turns: visibleTurns,
      queuedMessages: cloneView<QueuedMessage[]>(state.messageQueues?.[id] ?? []),
      olderTurnsCursor: subagent ? null : page.nextCursor,
      draft: cloneView<ThreadDraft | null>(state.threadMeta[id]?.draft ?? null),
      ...(syncPoint === undefined ? {} : { syncPoint }),
    };
  }

  async readThreadChanges(
    id: string,
    syncPoint: ThreadSyncPoint,
    continuationCursor: string | null = null,
  ): Promise<ThreadChanges> {
    const cached = this.threads.get(id);
    if (!cached) throw new Error("Thread not found");
    if (hasSubagentTranscript(cached.thread, this.store.view().threadMeta[id])) {
      return this.resetThreadChanges(id);
    }

    let page: CachedTurnsPage;
    try {
      page = await this.readTurnsPage(id, continuationCursor ?? syncPoint.cursor, "asc", false);
    } catch (error) {
      if (!(error instanceof RpcError)) throw error;
      return this.resetThreadChanges(id);
    }

    let turns = page.turns;
    if (continuationCursor === null) {
      const anchorIndex = turns.findIndex((turn) => turn.id === syncPoint.anchorTurnId);
      if (anchorIndex < 0) return this.resetThreadChanges(id);
      turns = turns.slice(anchorIndex);
      const boundary = turns[0];
      if (boundary && turnRevision(boundary) === syncPoint.anchorRevision) {
        turns = turns.slice(1);
      }
    }
    await this.restoreActiveTurnFromPage(cached, turns);

    const state = this.store.view();
    let nextSyncPoint: ThreadSyncPoint | null = null;
    if (page.nextCursor === null) {
      const latest = page.turns.at(-1);
      if (!latest || latest.id === syncPoint.anchorTurnId) {
        const boundary = page.turns.find((turn) => turn.id === syncPoint.anchorTurnId);
        nextSyncPoint = {
          ...syncPoint,
          anchorRevision: boundary ? turnRevision(boundary) : syncPoint.anchorRevision,
        };
      } else {
        const head = await this.readTurnsPage(id, null, "desc", false, 1);
        nextSyncPoint = syncPointForPage(head.backwardsCursor, head.turns);
      }
    }
    return {
      summary: this.toSummary(cached),
      turns,
      queuedMessages: cloneView<QueuedMessage[]>(state.messageQueues?.[id] ?? []),
      draft: cloneView<ThreadDraft | null>(state.threadMeta[id]?.draft ?? null),
      continuationCursor: page.nextCursor,
      syncPoint: nextSyncPoint,
      resetLatest: false,
      olderTurnsCursor: null,
    };
  }

  invalidateHistory(threadId: string): Promise<void> {
    return this.historyCache.invalidateThread(threadId);
  }

  private async resetThreadChanges(id: string): Promise<ThreadChanges> {
    await this.historyCache.invalidateThread(id).catch(() => undefined);
    const detail = await this.readThread(id);
    return {
      summary: detail.summary,
      turns: detail.turns,
      queuedMessages: detail.queuedMessages,
      draft: detail.draft ?? null,
      continuationCursor: null,
      syncPoint: detail.syncPoint ?? null,
      resetLatest: true,
      olderTurnsCursor: detail.olderTurnsCursor,
    };
  }

  private async restoreActiveTurnFromPage(cached: CachedThread, turns: TurnView[]): Promise<void> {
    if (cached.currentTurnId) return;
    const activeTurn = [...turns].reverse().find((turn) => turn.status === "inProgress");
    if (!activeTurn) return;
    const knownTurn = cached.thread.turns.find((turn) => turn.id === activeTurn.id);
    if (knownTurn && knownTurn.status !== "inProgress") return;
    const outcomeUpdatedAt = this.store.view().threadMeta[cached.thread.id]?.outcomeUpdatedAt;
    const startedAt = activeTurn.startedAt ?? activeTurn.progress.startedAt;
    if (outcomeUpdatedAt !== undefined && (startedAt === null || startedAt < outcomeUpdatedAt)) {
      return;
    }
    await this.setCurrentTurn(cached.thread.id, activeTurn.id);
  }

  private async readTurnsPage(
    id: string,
    cursor: string | null,
    direction: "asc" | "desc",
    allowCache: boolean,
    limit = THREAD_TURN_PAGE_SIZE,
  ): Promise<CachedTurnsPage> {
    const local = this.threads.get(id);
    if (!local) throw new Error("Thread not found");
    const threadUpdatedAt = local.thread.updatedAt * 1_000;
    const canReadCache =
      allowCache &&
      direction === "desc" &&
      limit === THREAD_TURN_PAGE_SIZE &&
      (cursor !== null || local.currentTurnId === null);
    if (canReadCache) {
      const cached = await this.historyCache.get(id, cursor, direction);
      if (
        cached &&
        (cursor !== null ||
          (cached.threadUpdatedAt === threadUpdatedAt &&
            cached.historyRevision === this.historyRevision(id)))
      ) {
        return cached;
      }
    }

    const startedAt = Date.now();
    const response = parseTurnsList(
      await this.bridge.request<unknown>(
        "thread/turns/list",
        {
          threadId: id,
          cursor,
          limit,
          sortDirection: direction,
          itemsView: "summary",
        },
        30_000,
      ),
    );
    const durationMs = Date.now() - startedAt;
    if (durationMs >= 500) {
      process.stderr.write(
        `CodexNest thread history read slow (${durationMs}ms, ${response.data.length} turns)\n`,
      );
    }
    const state = this.store.view();
    const artifacts = state.threadMeta[id]?.timelineArtifacts ?? {};
    const ordered = direction === "desc" ? response.data.slice().reverse() : response.data;
    const page: CachedTurnsPage = {
      threadId: id,
      cursor,
      direction,
      threadUpdatedAt,
      historyRevision: this.historyRevision(id),
      turns: ordered.map((turn) =>
        normalizeTurn(
          turn,
          this.progress.get(turnKey(id, turn.id)),
          this.liveActivities(id, turn.id),
          cloneView<TimelineArtifact[]>(artifacts[turn.id] ?? []),
          false,
        ),
      ),
      nextCursor: response.nextCursor,
      backwardsCursor: response.backwardsCursor ?? null,
    };
    if (canReadCache) {
      await this.historyCache.set(page).catch((error: unknown) => {
        this.emit("projectionError", error instanceof Error ? error : new Error(String(error)));
      });
    }
    return page;
  }

  async setDraft(threadId: string, value: UpdateThreadDraftRequest): Promise<ThreadDraft | null> {
    if (!this.threads.has(threadId)) throw new Error("Thread not found");
    const empty =
      value.input === "" &&
      value.images.length === 0 &&
      !value.goalMode &&
      value.annotations.length === 0;
    let draft: ThreadDraft | null = null;
    await this.store.update((state) => {
      const meta = state.threadMeta[threadId] ?? { pinned: false, lastReadUpdatedAt: 0 };
      if (empty) {
        delete meta.draft;
      } else {
        draft = { ...structuredClone(value), updatedAt: Date.now() };
        meta.draft = draft;
      }
      state.threadMeta[threadId] = meta;
    });
    return draft;
  }

  emptyThreadCandidates(
    projectId: string,
  ): Array<{ thread: ThreadSummary; knownUnmaterialized: boolean }> {
    const state = this.store.view();
    return [...this.threads.values()]
      .map((cached) => ({ cached, summary: this.toSummary(cached, state) }))
      .filter(({ cached, summary }) => {
        const unmaterialized = state.threadMeta[cached.thread.id]?.unmaterialized;
        return (
          !isSpawnedSubagent(cached.thread) &&
          !cached.archived &&
          summary.projectId === projectId &&
          cached.currentTurnId === null &&
          !cached.thread.name?.trim() &&
          (unmaterialized === true || !cached.thread.preview.trim()) &&
          (state.messageQueues?.[cached.thread.id]?.length ?? 0) === 0 &&
          unmaterialized !== false
        );
      })
      .sort((a, b) => {
        const aKnown = state.threadMeta[a.cached.thread.id]?.unmaterialized === true ? 1 : 0;
        const bKnown = state.threadMeta[b.cached.thread.id]?.unmaterialized === true ? 1 : 0;
        return bKnown - aKnown || b.cached.thread.updatedAt - a.cached.thread.updatedAt;
      })
      .map(({ cached, summary }) => ({
        thread: summary,
        knownUnmaterialized: state.threadMeta[cached.thread.id]?.unmaterialized === true,
      }));
  }

  async markRead(threadId: string, observedUpdatedAt: number): Promise<void> {
    const cached = this.threads.get(threadId);
    if (!cached) throw new Error("Thread not found");
    const safeObserved = Math.min(observedUpdatedAt, cached.thread.updatedAt * 1_000);
    await this.store.update((state) => {
      const meta = state.threadMeta[threadId] ?? { pinned: false, lastReadUpdatedAt: 0 };
      meta.lastReadUpdatedAt = Math.max(meta.lastReadUpdatedAt, safeObserved);
      state.threadMeta[threadId] = meta;
    });
    this.publishThread(threadId);
  }

  async markViewed(threadId: string, observedUpdatedAt: number): Promise<void> {
    const cached = this.threads.get(threadId);
    if (!cached) throw new Error("Thread not found");
    const safeObserved = Math.min(observedUpdatedAt, cached.thread.updatedAt * 1_000);
    await this.store.update((state) => {
      const meta = state.threadMeta[threadId] ?? { pinned: false, lastReadUpdatedAt: 0 };
      meta.lastViewedUpdatedAt = Math.max(meta.lastViewedUpdatedAt ?? 0, safeObserved);
      state.threadMeta[threadId] = meta;
    });
    this.publishThread(threadId);
  }

  async setPinned(threadId: string, pinned: boolean): Promise<void> {
    if (!this.threads.has(threadId)) throw new Error("Thread not found");
    await this.store.update((state) => {
      const meta = state.threadMeta[threadId] ?? { pinned: false, lastReadUpdatedAt: 0 };
      meta.pinned = pinned;
      state.threadMeta[threadId] = meta;
    });
    this.publishThread(threadId);
  }

  async setSettings(threadId: string, settings: SessionSettings): Promise<ThreadSummary> {
    if (!this.threads.has(threadId)) throw new Error("Thread not found");
    await this.store.update((state) => {
      const meta = state.threadMeta[threadId] ?? { pinned: false, lastReadUpdatedAt: 0 };
      meta.settings = settings;
      state.threadMeta[threadId] = meta;
    });
    this.publishThread(threadId);
    return this.summary(threadId)!;
  }

  async setDefaultReasoningEffort(reasoningEffort?: string): Promise<void> {
    await this.store.update((state) => {
      if (reasoningEffort) state.defaultReasoningEffort = reasoningEffort;
      else delete state.defaultReasoningEffort;
    });
    this.publish({
      type: "defaultReasoningEffort.changed",
      reasoningEffort: reasoningEffort ?? null,
    });
  }

  async setTaskDefaults(taskDefaults: TaskDefaults): Promise<void> {
    await this.store.update((state) => {
      if (Object.keys(taskDefaults).length) state.taskDefaults = taskDefaults;
      else delete state.taskDefaults;
    });
    this.publish({ type: "taskDefaults.changed", taskDefaults });
  }

  async setUiLanguage(language: UiLanguage): Promise<void> {
    await this.store.update((state) => {
      state.uiLanguage = language;
    });
    this.publish({ type: "uiLanguage.changed", language });
  }

  publishProject(projectId: string): void {
    const project = this.store.view().projects.find((candidate) => candidate.id === projectId);
    if (project) this.publish({ type: "project.upserted", project: cloneView<Project>(project) });
    this.publish({ type: "resync.required" });
  }

  publishProjectsReordered(projects: Project[]): void {
    this.publish({ type: "projects.reordered", projects });
  }

  removeProject(projectId: string): void {
    this.publish({ type: "project.removed", projectId });
    this.publish({ type: "resync.required" });
  }

  publishQueue(threadId: string, messages: QueuedMessage[]): void {
    const state = this.store.view();
    if (this.isThreadVisible(threadId, state)) {
      this.publish({ type: "queue.changed", threadId, messages });
    }
    this.publishThread(threadId, state);
  }

  publishVoiceTranscription(job: VoiceTranscriptionState): void {
    if (!this.isThreadVisible(job.threadId)) return;
    this.publish({ type: "voiceTranscription.upserted", job: publicVoiceTranscription(job) });
  }

  removeVoiceTranscription(
    threadId: string,
    jobId: string,
    outcome: "draft" | "send" | "cancelled",
  ): void {
    if (!this.isThreadVisible(threadId)) return;
    this.publish({ type: "voiceTranscription.removed", threadId, jobId, outcome });
  }

  upsertThread(thread: Thread, archived = false): ThreadSummary {
    const cached = {
      thread,
      archived,
      currentTurnId: activeTurnId(thread),
      liveOutcome: this.threads.get(thread.id)?.liveOutcome,
      goalStatus: this.threads.get(thread.id)?.goalStatus,
    };
    this.threads.set(thread.id, cached);
    this.queueSessionSnapshot(thread.id);
    return this.publishThread(thread.id)!;
  }

  async refreshThread(threadId: string): Promise<ThreadSummary | undefined> {
    const baselineRevision = this.historyRevision(threadId);
    let response;
    try {
      response = parseThreadRead(
        await this.bridge.request<unknown>(
          "thread/read",
          { threadId, includeTurns: false },
          30_000,
        ),
      );
    } catch (error) {
      if (isMissingThreadError(error)) {
        return this.summary(threadId);
      }
      throw error;
    }
    if (this.historyRevision(threadId) !== baselineRevision) return this.summary(threadId);
    const archived = this.threads.get(threadId)?.archived ?? false;
    return this.upsertThread(response.thread, archived);
  }

  async readTurnItems(threadId: string, turnId: string): Promise<TurnItemsResponse> {
    const startedAt = Date.now();
    let cursor: string | null = null;
    let items: ActivityItem[] = [];
    let pages = 0;
    do {
      const page = parseTurnsList(
        await this.bridge.request<unknown>(
          "thread/turns/list",
          { threadId, cursor, limit: 100, sortDirection: "desc", itemsView: "full" },
          30_000,
        ),
      );
      pages += 1;
      const turn = page.data.find((candidate) => candidate.id === turnId);
      if (turn) {
        const turnStartedAt = turn.startedAt === null ? null : turn.startedAt * 1_000;
        const turnCompletedAt = turn.completedAt === null ? null : turn.completedAt * 1_000;
        items = turn.items
          .filter((item) => !isInternalTeamContinuationItem(item))
          .map((item) =>
            normalizeActivity(
              item,
              item.type === "userMessage" ? turnStartedAt : (turnCompletedAt ?? turnStartedAt),
            ),
          );
        break;
      }
      cursor = page.nextCursor;
    } while (cursor);
    const durationMs = Date.now() - startedAt;
    if (durationMs >= 500) {
      process.stderr.write(
        `CodexNest turn items read slow (${durationMs}ms, ${pages} pages, ${items.length} items)\n`,
      );
    }
    return { threadId, turnId, items };
  }

  async markUnmaterialized(threadId: string): Promise<void> {
    if (!this.threads.has(threadId)) throw new Error("Thread not found");
    this.unmaterializedThreads.add(threadId);
    await this.store.update((state) => {
      const meta = state.threadMeta[threadId] ?? { pinned: false, lastReadUpdatedAt: 0 };
      meta.unmaterialized = true;
      state.threadMeta[threadId] = meta;
    });
  }

  isUnmaterialized(threadId: string): boolean {
    return (
      this.unmaterializedThreads.has(threadId) ||
      this.store.view().threadMeta[threadId]?.unmaterialized === true
    );
  }

  async markMaterialized(threadId: string): Promise<void> {
    this.unmaterializedThreads.delete(threadId);
    await this.store.update((state) => {
      const meta = state.threadMeta[threadId] ?? { pinned: false, lastReadUpdatedAt: 0 };
      meta.unmaterialized = false;
      delete meta.draft;
      state.threadMeta[threadId] = meta;
    });
  }

  async setCurrentTurn(threadId: string, turnId: string): Promise<void> {
    const cached = this.threads.get(threadId);
    if (!cached) throw new Error("Thread not found");
    const knownTurn = cached.thread.turns.find((turn) => turn.id === turnId);
    if (knownTurn && knownTurn.status !== "inProgress") return;
    cached.currentTurnId = turnId;
    cached.liveOutcome = undefined;
    cached.thread.status = { type: "active", activeFlags: [] };
    cached.thread.updatedAt = Math.floor(Date.now() / 1_000);
    if (this.store.view().threadMeta[threadId]?.awaitingPlanResponse) {
      await this.store.update((state) => {
        const meta = state.threadMeta[threadId];
        if (meta) meta.awaitingPlanResponse = false;
      });
    }
    this.queueSessionSnapshot(threadId);
    this.publishThread(threadId);
  }

  async markInterrupted(threadId: string, expectedTurnIds: readonly string[]): Promise<void> {
    const cached = this.threads.get(threadId);
    if (!cached) throw new Error("Thread not found");
    if (cached.currentTurnId && !expectedTurnIds.includes(cached.currentTurnId)) return;
    cached.currentTurnId = null;
    cached.liveOutcome = "interrupted";
    cached.thread.status = { type: "idle" };
    cached.thread.updatedAt = Math.floor(Date.now() / 1_000);
    const updatedAt = cached.thread.updatedAt * 1_000;
    await this.store.update((state) => {
      const meta = state.threadMeta[threadId] ?? { pinned: false, lastReadUpdatedAt: 0 };
      meta.lastOutcome = "interrupted";
      meta.outcomeUpdatedAt = updatedAt;
      state.threadMeta[threadId] = meta;
    });
    await this.saveSessionSnapshot(threadId, true);
    this.publishThread(threadId);
  }

  async setArchived(threadId: string, archived: boolean): Promise<ThreadSummary> {
    const cached = this.threads.get(threadId);
    if (!cached) throw new Error("Thread not found");
    cached.archived = archived;
    await this.saveSessionSnapshot(threadId, true);
    return this.publishThread(threadId)!;
  }

  async recordAttentionResponse(
    request: AttentionRequest,
    response: AttentionResponse,
  ): Promise<void> {
    if (
      request.kind !== "userInput" ||
      response.kind !== "userInput" ||
      !request.threadId ||
      !request.turnId
    ) {
      return;
    }
    const item: TimelineArtifact = {
      type: "userInputResponse",
      id: `${request.itemId ?? request.id}-response`,
      status: "completed",
      entries: request.questions.map((question) => ({
        header: question.header,
        question: question.question,
        answers: response.answers[question.id] ?? [],
      })),
      timestamp: Date.now(),
      afterItemId: request.itemId,
    };
    await this.upsertTimelineArtifact(request.threadId, request.turnId, item);
  }

  async recordOrchestrationNotice(
    threadId: string,
    turnId: string,
    agents: Extract<ActivityItem, { type: "orchestrationNotice" }>["agents"],
    afterItemId: string | null,
  ): Promise<void> {
    if (!agents.length) return;
    const timestamp = Date.now();
    await this.upsertTimelineArtifact(
      threadId,
      turnId,
      {
        type: "orchestrationNotice",
        id: `orchestration-${turnId}-${agents
          .map((agent) => agent.threadId)
          .sort()
          .join("-")}`,
        status: "completed",
        agents,
        timestamp,
        afterItemId,
      },
      agents.filter((agent) => agent.outcome === "completed").map((agent) => agent.threadId),
      timestamp,
    );
  }

  publishThreadState(threadId: string): void {
    this.publishThread(threadId);
  }

  recordUserMessage(
    threadId: string,
    turnId: string,
    messageId: string,
    text: string,
    images: string[],
  ): void {
    const key = activityKey(threadId, turnId, messageId);
    if (this.activity.get(key)?.type === "userMessage") return;
    const item: ActivityItem = {
      type: "userMessage",
      id: messageId,
      status: "completed",
      text: text.trim(),
      images,
      timestamp: Date.now(),
      phase: null,
    };
    this.activity.set(key, item);
    this.bumpHistoryRevision(threadId);
    this.publish({ type: "activity.upserted", threadId, turnId, item });
  }

  private async upsertTimelineArtifact(
    threadId: string,
    turnId: string,
    item: TimelineArtifact,
    deliveredThreadIds: readonly string[] = [],
    deliveredAt = Number.POSITIVE_INFINITY,
  ): Promise<void> {
    const readMarkers = this.readMarkers(deliveredThreadIds, deliveredAt);
    const markedRead: string[] = [];
    await this.store.update((state) => {
      const meta = state.threadMeta[threadId] ?? { pinned: false, lastReadUpdatedAt: 0 };
      meta.timelineArtifacts ??= {};
      const items = meta.timelineArtifacts[turnId] ?? [];
      const index = items.findIndex((candidate) => candidate.id === item.id);
      meta.timelineArtifacts[turnId] =
        index < 0
          ? [...items, item]
          : items.map((candidate, itemIndex) => (itemIndex === index ? item : candidate));
      state.threadMeta[threadId] = meta;
      if (index < 0) markedRead.push(...applyReadMarkers(state, readMarkers));
    });
    this.activity.set(activityKey(threadId, turnId, item.id), item);
    this.bumpHistoryRevision(threadId);
    this.publish({ type: "activity.upserted", threadId, turnId, item });
    if (markedRead.length) {
      const state = this.store.view();
      for (const deliveredThreadId of markedRead) this.publishThread(deliveredThreadId, state);
    }
  }

  private historyRevision(threadId: string): number {
    return this.historyRevisions.get(threadId) ?? 0;
  }

  private bumpHistoryRevision(threadId: string): void {
    this.historyRevisions.set(threadId, this.historyRevision(threadId) + 1);
  }

  private latestActivityId(threadId: string, turnId: string): string | null {
    const prefix = `${threadId}:${turnId}:`;
    let latest: string | null = null;
    for (const [key, item] of this.activity.entries()) {
      if (key.startsWith(prefix) && item.type !== "planChecklist") latest = item.id;
    }
    return latest;
  }

  private liveActivities(threadId: string, turnId: string): ActivityItem[] {
    const prefix = `${threadId}:${turnId}:`;
    const items: ActivityItem[] = [];
    for (const [key, item] of this.activity.entries()) {
      if (key.startsWith(prefix) && !isTimelineArtifact(item)) items.push(item);
    }
    return items;
  }

  private hasLivePlan(threadId: string, turnId: string): boolean {
    const prefix = `${threadId}:${turnId}:`;
    for (const [key, item] of this.activity.entries()) {
      if (key.startsWith(prefix) && item.type === "plan" && item.text.trim()) return true;
    }
    return false;
  }

  private async performSync(): Promise<void> {
    const startedAt = Date.now();
    const revisionBaseline = new Map(this.historyRevisions);
    const changedDuringSync = (threadId: string) =>
      this.historyRevision(threadId) !== (revisionBaseline.get(threadId) ?? 0);
    const shouldRecoverLoaded = this.recoverLoadedThreads;
    let loadedRecoveryFailed = false;
    const [listedActive, archived, models, loadedThreadIds] = await Promise.all([
      this.listAllThreads(false),
      this.listAllThreads(true),
      this.listAllModels(),
      shouldRecoverLoaded
        ? this.listAllLoadedThreadIds().catch((error: unknown) => {
            this.emit("projectionError", error instanceof Error ? error : new Error(String(error)));
            loadedRecoveryFailed = true;
            return [];
          })
        : Promise.resolve([]),
    ]);
    const listedIds = new Set([...listedActive, ...archived].map((thread) => thread.id));
    const loadedIds = new Set(loadedThreadIds);
    const recovered = await this.readThreadsOmittedFromList(loadedThreadIds, listedIds);
    const activeCandidates = [...listedActive, ...recovered.threads];
    const active = await Promise.all(
      activeCandidates.map(async (thread) => {
        const cachedGoalStatus = this.threads.get(thread.id)?.goalStatus;
        const recoverLoadedThread =
          shouldRecoverLoaded && loadedIds.has(thread.id) && thread.status.type === "notLoaded";
        const [resumed, restoredGoalStatus] = await Promise.all([
          this.rejoinActiveThread(thread, recoverLoadedThread),
          (thread.status.type === "active" || recoverLoadedThread) &&
          !isSpawnedSubagent(thread) &&
          cachedGoalStatus === undefined
            ? this.readThreadGoalStatus(thread.id)
            : Promise.resolve(cachedGoalStatus),
        ]);
        return { thread: resumed.thread, restoredGoalStatus, recoveryFailed: resumed.failed };
      }),
    );
    const incoming = new Set<string>();
    for (const { thread, restoredGoalStatus } of active) {
      incoming.add(thread.id);
      if (changedDuringSync(thread.id)) continue;
      const liveCached = this.threads.get(thread.id);
      const liveGoalStatus = liveCached?.goalStatus;
      const resumedTurnId = activeTurnId(thread);
      this.threads.set(thread.id, {
        thread,
        archived: false,
        currentTurnId:
          resumedTurnId ??
          (thread.status.type === "active" ? (liveCached?.currentTurnId ?? null) : null),
        goalStatus: liveGoalStatus === undefined ? restoredGoalStatus : liveGoalStatus,
      });
      this.hydrateLiveTurn(thread);
    }
    for (const thread of archived) {
      incoming.add(thread.id);
      if (changedDuringSync(thread.id)) continue;
      this.threads.set(thread.id, {
        thread,
        archived: true,
        currentTurnId: activeTurnId(thread),
        goalStatus: this.threads.get(thread.id)?.goalStatus,
      });
    }
    const state = this.store.view();
    for (const id of this.threads.keys()) {
      const cached = this.threads.get(id);
      const parentThreadId = cached
        ? (cached.thread.parentThreadId ??
          state.threadMeta[id]?.managedParent?.parentThreadId ??
          null)
        : null;
      if (
        !incoming.has(id) &&
        !changedDuringSync(id) &&
        !this.unmaterializedThreads.has(id) &&
        !this.subscribedThreads.has(id) &&
        !state.threadMeta[id]?.sessionSnapshot &&
        (!cached || !isRecoverableUserSession(cached.thread)) &&
        (!cached || !parentThreadId || !incoming.has(parentThreadId))
      ) {
        this.threads.delete(id);
      }
    }

    await this.store.update((state) => {
      for (const cached of this.threads.values()) {
        const meta = state.threadMeta[cached.thread.id] ?? {
          pinned: false,
          lastReadUpdatedAt: cached.thread.updatedAt * 1_000,
        };
        const snapshot = sessionSnapshot(cached);
        if (snapshot && !sessionSnapshotsEqual(meta.sessionSnapshot, snapshot)) {
          meta.sessionSnapshot = snapshot;
        }
        state.threadMeta[cached.thread.id] = meta;
      }
    });
    await this.reconcileOutcomes();
    this.models = models;
    this.syncedAt = new Date().toISOString();
    if (shouldRecoverLoaded) {
      const recoveryFailed =
        loadedRecoveryFailed || recovered.failed || active.some((item) => item.recoveryFailed);
      if (recoveryFailed) this.scheduleLoadedRecovery();
      else this.finishLoadedRecovery();
    }
    this.publish({ type: "models.changed", models });
    this.publish({ type: "resync.required" });
    this.backfillSubagentTitles();
    this.scheduleMissingManagedThreadRecovery();
    const durationMs = Date.now() - startedAt;
    if (durationMs >= 1_000) {
      process.stderr.write(
        `CodexNest projection sync slow (${durationMs}ms, ${listedActive.length} active, ${archived.length} archived)\n`,
      );
    }
  }

  private finishLoadedRecovery(): void {
    this.recoverLoadedThreads = false;
    this.loadedRecoveryAttempt = 0;
    if (this.loadedRecoveryTimer) clearTimeout(this.loadedRecoveryTimer);
    this.loadedRecoveryTimer = undefined;
  }

  private scheduleLoadedRecovery(): void {
    if (this.loadedRecoveryTimer || this.bridge.state !== "ready") return;
    const delay =
      LOADED_RECOVERY_DELAYS_MS[
        Math.min(this.loadedRecoveryAttempt, LOADED_RECOVERY_DELAYS_MS.length - 1)
      ]!;
    this.loadedRecoveryAttempt += 1;
    this.loadedRecoveryTimer = setTimeout(() => {
      this.loadedRecoveryTimer = undefined;
      void this.sync().catch((error: unknown) => {
        this.emit("projectionError", error instanceof Error ? error : new Error(String(error)));
      });
    }, delay);
    this.loadedRecoveryTimer.unref();
  }

  private scheduleMissingManagedThreadRecovery(): void {
    if (this.managedRecoveryTimer || this.bridge.state !== "ready") return;
    const missing = this.missingManagedThreadIds();
    if (!missing.length) {
      this.managedRecoveryAttempt = 0;
      return;
    }
    const delay = MANAGED_RECOVERY_DELAYS_MS[this.managedRecoveryAttempt];
    if (delay === undefined) return;
    this.managedRecoveryAttempt += 1;
    this.managedRecoveryTimer = setTimeout(() => {
      this.managedRecoveryTimer = undefined;
      void this.recoverMissingManagedThreads(missing).catch((error: unknown) => {
        this.emit("projectionError", error instanceof Error ? error : new Error(String(error)));
        this.scheduleMissingManagedThreadRecovery();
      });
    }, delay);
    this.managedRecoveryTimer.unref();
  }

  private missingManagedThreadIds(): string[] {
    const referenced = managedThreadIds(this.store.view());
    return [...referenced].filter((threadId) => !this.threads.has(threadId));
  }

  private async recoverMissingManagedThreads(threadIds: readonly string[]): Promise<void> {
    if (this.bridge.state !== "ready") return;
    const stillReferenced = managedThreadIds(this.store.view());
    const recovered = await Promise.all(
      threadIds.map(async (threadId): Promise<Thread | null> => {
        if (this.threads.has(threadId) || !stillReferenced.has(threadId)) return null;
        try {
          const response = parseThreadRead(
            await this.bridge.request<unknown>(
              "thread/read",
              { threadId, includeTurns: false },
              30_000,
            ),
          );
          return response.thread;
        } catch {
          return null;
        }
      }),
    );
    let changed = false;
    for (const rawThread of recovered) {
      if (!rawThread || this.threads.has(rawThread.id)) continue;
      const { thread } = await this.rejoinActiveThread(rawThread);
      if (this.threads.has(thread.id)) continue;
      this.threads.set(thread.id, {
        thread,
        archived: false,
        currentTurnId: activeTurnId(thread),
      });
      this.hydrateLiveTurn(thread);
      changed = true;
    }
    if (changed) this.publish({ type: "resync.required" });
    this.scheduleMissingManagedThreadRecovery();
  }

  private backfillSubagentTitles(): void {
    const candidates = [...this.threads.values()]
      .filter(
        (cached) =>
          isSpawnedSubagent(cached.thread) &&
          !cached.thread.name?.trim() &&
          !this.subagentTitleUpdates.has(cached.thread.id),
      )
      .map((cached) => cached.thread.id);
    if (!candidates.length) return;

    void (async () => {
      for (const threadId of candidates) {
        const cached = this.threads.get(threadId);
        if (
          !cached ||
          !isSpawnedSubagent(cached.thread) ||
          cached.thread.name?.trim() ||
          this.subagentTitleUpdates.has(threadId)
        ) {
          continue;
        }
        this.subagentTitleUpdates.add(threadId);
        try {
          const page = parseTurnsList(
            await this.bridge.request<unknown>(
              "thread/turns/list",
              {
                threadId,
                limit: THREAD_TURN_PAGE_SIZE,
                sortDirection: "desc",
                itemsView: "full",
              },
              30_000,
            ),
          );
          const title = subagentTitleFromTurns(page.data);
          const current = this.threads.get(threadId);
          if (!title || !current || current.thread.name?.trim()) continue;
          current.thread.name = title;
          this.publishThread(threadId);
          await this.bridge.request("thread/name/set", { threadId, name: title });
        } catch (error) {
          this.emit("projectionError", error instanceof Error ? error : new Error(String(error)));
        } finally {
          this.subagentTitleUpdates.delete(threadId);
        }
      }
    })();
  }

  private async rejoinActiveThread(
    thread: Thread,
    recoverLoaded = false,
  ): Promise<{ thread: Thread; failed: boolean }> {
    if (
      isSpawnedSubagent(thread) ||
      (thread.status.type !== "active" && !recoverLoaded) ||
      this.subscribedThreads.has(thread.id)
    ) {
      return { thread, failed: false };
    }
    try {
      const resumed = parseThreadResume(
        await this.bridge.request<unknown>("thread/resume", { threadId: thread.id }, 30_000),
      );
      this.subscribedThreads.add(thread.id);
      return {
        thread: {
          ...resumed.thread,
          updatedAt: Math.max(thread.updatedAt, resumed.thread.updatedAt),
        },
        failed: false,
      };
    } catch (error) {
      this.emit("projectionError", error instanceof Error ? error : new Error(String(error)));
      return { thread, failed: !isMissingThreadError(error) };
    }
  }

  private queueSessionSnapshot(threadId: string): void {
    void this.saveSessionSnapshot(threadId, false).catch((error: unknown) => {
      this.emit("projectionError", error instanceof Error ? error : new Error(String(error)));
    });
  }

  private async saveSessionSnapshot(threadId: string, durable: boolean): Promise<void> {
    const cached = this.threads.get(threadId);
    const snapshot = cached ? sessionSnapshot(cached) : null;
    if (!snapshot) return;
    const updatedAt = cached!.thread.updatedAt;
    const update = (state: CodexNestState) => {
      const meta = state.threadMeta[threadId] ?? {
        pinned: false,
        lastReadUpdatedAt: updatedAt * 1_000,
      };
      if (!sessionSnapshotsEqual(meta.sessionSnapshot, snapshot)) meta.sessionSnapshot = snapshot;
      state.threadMeta[threadId] = meta;
    };
    if (durable) await this.store.update(update);
    else await this.store.updateDeferred(update);
  }

  private async readThreadGoalStatus(
    threadId: string,
  ): Promise<ThreadGoal["status"] | null | undefined> {
    try {
      const response = await this.bridge.request<unknown>("thread/goal/get", { threadId }, 30_000);
      return parseThreadGoalStatus(response);
    } catch (error) {
      this.emit("projectionError", error instanceof Error ? error : new Error(String(error)));
      return undefined;
    }
  }

  private hydrateLiveTurn(thread: Thread): void {
    for (const turn of thread.turns) {
      if (turn.status === "inProgress") {
        const key = turnKey(thread.id, turn.id);
        if (!this.progress.has(key)) this.progress.set(key, emptyProgress(turn.startedAt));
      }
      for (const rawItem of turn.items) {
        if (isInternalTeamContinuationItem(rawItem)) continue;
        const startedAt = turn.startedAt === null ? null : turn.startedAt * 1_000;
        const completedAt = turn.completedAt === null ? null : turn.completedAt * 1_000;
        const item = normalizeActivity(
          rawItem,
          rawItem.type === "userMessage" ? startedAt : (completedAt ?? startedAt),
        );
        const key = activityKey(thread.id, turn.id, item.id);
        if (!this.activity.has(key)) this.activity.set(key, item);
      }
    }
  }

  private async listAllThreads(archived: boolean): Promise<Thread[]> {
    const threads: Thread[] = [];
    let cursor: string | null = null;
    do {
      const page = parseThreadList(
        await this.bridge.request<unknown>(
          "thread/list",
          {
            cursor,
            limit: 100,
            sortKey: "updated_at",
            sortDirection: "desc",
            archived,
            sourceKinds: ["cli", "vscode", "appServer", "subAgentThreadSpawn"],
          },
          30_000,
        ),
      );
      threads.push(...page.data.filter((thread) => !thread.ephemeral || isSpawnedSubagent(thread)));
      cursor = page.nextCursor;
    } while (cursor);
    return threads;
  }

  private async listAllLoadedThreadIds(): Promise<string[]> {
    const threadIds: string[] = [];
    let cursor: string | null = null;
    do {
      const page = parseThreadLoadedList(
        await this.bridge.request<unknown>("thread/loaded/list", { cursor, limit: 100 }, 30_000),
      );
      threadIds.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    return threadIds;
  }

  private async readThreadsOmittedFromList(
    loadedThreadIds: string[],
    listedIds: Set<string>,
  ): Promise<{ threads: Thread[]; failed: boolean }> {
    const state = this.store.view();
    const loadedIds = new Set(loadedThreadIds);
    const managedParentIds = new Set<string>();
    const managedChildIds = new Set<string>();
    for (const [threadId, meta] of Object.entries(state.threadMeta)) {
      if (meta.teamOrchestration !== undefined) {
        managedParentIds.add(threadId);
        for (const task of Object.values(meta.teamOrchestration.tasks)) {
          managedChildIds.add(task.childThreadId);
        }
      }
      const parentThreadId = meta.managedParent?.parentThreadId;
      if (parentThreadId && state.threadMeta[parentThreadId] !== undefined) {
        managedParentIds.add(parentThreadId);
        managedChildIds.add(threadId);
      }
    }
    const candidates = new Set<string>();
    for (const threadId of loadedThreadIds) {
      if (listedIds.has(threadId)) continue;
      candidates.add(threadId);
    }
    for (const threadId of managedParentIds) {
      if (!listedIds.has(threadId)) candidates.add(threadId);
    }
    const recovered = await Promise.all(
      [...candidates].map(async (threadId): Promise<{ thread: Thread | null; failed: boolean }> => {
        try {
          const response = parseThreadRead(
            await this.bridge.request<unknown>(
              "thread/read",
              { threadId, includeTurns: false },
              30_000,
            ),
          );
          return {
            thread:
              isSpawnedSubagent(response.thread) ||
              isRecoverableUserSession(response.thread) ||
              managedParentIds.has(threadId) ||
              managedChildIds.has(threadId)
                ? response.thread
                : null,
            failed: false,
          };
        } catch (error) {
          this.emit("projectionError", error instanceof Error ? error : new Error(String(error)));
          return {
            thread: null,
            failed: loadedIds.has(threadId) && !isMissingThreadError(error),
          };
        }
      }),
    );
    return {
      threads: recovered.flatMap((item) => (item.thread ? [item.thread] : [])),
      failed: recovered.some((item) => item.failed),
    };
  }

  private async listAllModels(): Promise<ModelOption[]> {
    const models: Model[] = [];
    let cursor: string | null = null;
    do {
      const page = parseModelList(
        await this.bridge.request<unknown>(
          "model/list",
          { cursor, limit: 100, includeHidden: false },
          30_000,
        ),
      );
      models.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    return models.map(normalizeModel);
  }

  private async reconcileOutcomes(): Promise<void> {
    const state = this.store.view();
    for (const cached of this.threads.values()) {
      if (cached.thread.status.type !== "idle") continue;
      if (isSpawnedSubagent(cached.thread)) continue;
      const updatedAt = cached.thread.updatedAt * 1_000;
      const meta = state.threadMeta[cached.thread.id];
      if (meta?.outcomeUpdatedAt === updatedAt && meta.awaitingPlanResponse !== undefined) {
        continue;
      }
      const planMode = meta?.settings?.collaborationMode === "plan";
      if (meta?.outcomeUpdatedAt === updatedAt && !planMode) {
        await this.store.update((draft) => {
          const item = draft.threadMeta[cached.thread.id];
          if (item) item.awaitingPlanResponse = false;
        });
        continue;
      }
      const page = parseTurnsList(
        await this.bridge.request<unknown>(
          "thread/turns/list",
          {
            threadId: cached.thread.id,
            limit: 1,
            sortDirection: "desc",
            itemsView: planMode ? "full" : "notLoaded",
          },
          30_000,
        ),
      );
      const latestTurn = page.data[0];
      const outcome = normalizeOutcome(latestTurn?.status);
      const awaitingPlanResponse =
        planMode && outcome === "completed" && Boolean(latestTurn && turnContainsPlan(latestTurn));
      await this.store.update((draft) => {
        const item = draft.threadMeta[cached.thread.id] ?? {
          pinned: false,
          lastReadUpdatedAt: updatedAt,
        };
        item.lastOutcome = outcome;
        item.outcomeUpdatedAt = updatedAt;
        item.awaitingPlanResponse = awaitingPlanResponse;
        draft.threadMeta[cached.thread.id] = item;
      });
    }
  }

  private async onNotification(notification: ServerNotification): Promise<void> {
    if (
      notification.method === "thread/started" &&
      notification.params.thread.ephemeral &&
      !isSpawnedSubagent(notification.params.thread)
    ) {
      this.hiddenThreads.add(notification.params.thread.id);
      return;
    }
    const threadId = notificationThreadId(notification);
    if (threadId && this.hiddenThreads.has(threadId)) {
      if (notification.method === "thread/deleted" || notification.method === "thread/closed") {
        this.hiddenThreads.delete(threadId);
      }
      return;
    }
    if (threadId) this.bumpHistoryRevision(threadId);
    switch (notification.method) {
      case "error": {
        const item: ActivityItem = {
          type: "error",
          id: `${notification.params.turnId}-error-${Date.now()}`,
          status: "failed",
          message: notification.params.error.message,
        };
        this.publish({
          type: "activity.upserted",
          threadId: notification.params.threadId,
          turnId: notification.params.turnId,
          item,
        });
        break;
      }
      case "thread/started": {
        this.upsertThread(notification.params.thread);
        const pendingTitle = this.pendingSubagentTitles.get(notification.params.thread.id);
        if (pendingTitle) {
          this.pendingSubagentTitles.delete(notification.params.thread.id);
          this.setSubagentTitle(notification.params.thread.id, pendingTitle);
        }
        break;
      }
      case "thread/status/changed": {
        const cached = this.threads.get(notification.params.threadId);
        if (cached) {
          cached.thread.status = notification.params.status;
          if (notification.params.status.type === "systemError") {
            cached.currentTurnId = null;
            cached.liveOutcome = "failed";
          }
          this.queueSessionSnapshot(notification.params.threadId);
          this.publishThread(notification.params.threadId);
        }
        break;
      }
      case "thread/name/updated": {
        const cached = this.threads.get(notification.params.threadId);
        if (cached) {
          cached.thread.name = notification.params.threadName ?? null;
          this.queueSessionSnapshot(notification.params.threadId);
          this.publishThread(notification.params.threadId);
        }
        break;
      }
      case "thread/goal/updated": {
        const cached = this.threads.get(notification.params.threadId);
        const statusChanged = cached?.goalStatus !== notification.params.goal.status;
        if (cached) cached.goalStatus = notification.params.goal.status;
        this.publish({
          type: "goal.changed",
          threadId: notification.params.threadId,
          goal: notification.params.goal satisfies ThreadGoal,
        });
        if (statusChanged) this.publishThread(notification.params.threadId);
        break;
      }
      case "thread/goal/cleared": {
        const cached = this.threads.get(notification.params.threadId);
        const statusChanged = cached?.goalStatus !== null;
        if (cached) cached.goalStatus = null;
        this.publish({
          type: "goal.changed",
          threadId: notification.params.threadId,
          goal: null,
        });
        if (statusChanged) this.publishThread(notification.params.threadId);
        break;
      }
      case "thread/archived": {
        const cached = this.threads.get(notification.params.threadId);
        if (cached) {
          cached.archived = true;
          await this.saveSessionSnapshot(notification.params.threadId, true);
        }
        this.publishThread(notification.params.threadId);
        break;
      }
      case "thread/unarchived": {
        const cached = this.threads.get(notification.params.threadId);
        if (cached) {
          cached.archived = false;
          await this.saveSessionSnapshot(notification.params.threadId, true);
        }
        this.publishThread(notification.params.threadId);
        break;
      }
      case "thread/deleted": {
        this.threads.delete(notification.params.threadId);
        this.subscribedThreads.delete(notification.params.threadId);
        this.unmaterializedThreads.delete(notification.params.threadId);
        this.pendingSubagentTitles.delete(notification.params.threadId);
        this.subagentTitleUpdates.delete(notification.params.threadId);
        for (const key of this.progress.keys()) {
          if (key.startsWith(`${notification.params.threadId}:`)) this.progress.delete(key);
        }
        await this.store.update((state) => {
          const meta = state.threadMeta[notification.params.threadId];
          if (meta) delete meta.sessionSnapshot;
        });
        this.publish({ type: "thread.removed", threadId: notification.params.threadId });
        break;
      }
      case "thread/closed": {
        this.subscribedThreads.delete(notification.params.threadId);
        const cached = this.threads.get(notification.params.threadId);
        if (cached) {
          cached.currentTurnId = null;
          cached.thread.status = { type: "notLoaded" };
          await this.saveSessionSnapshot(notification.params.threadId, true);
          this.publishThread(notification.params.threadId);
        }
        break;
      }
      case "turn/started": {
        this.subscribedThreads.add(notification.params.threadId);
        this.unmaterializedThreads.delete(notification.params.threadId);
        const progress = emptyProgress(notification.params.turn.startedAt);
        this.progress.set(
          turnKey(notification.params.threadId, notification.params.turn.id),
          progress,
        );
        this.publish({
          type: "turn.progressed",
          threadId: notification.params.threadId,
          turnId: notification.params.turn.id,
          progress,
        });
        if (this.threads.has(notification.params.threadId)) {
          await this.setCurrentTurn(notification.params.threadId, notification.params.turn.id);
        }
        break;
      }
      case "turn/completed": {
        const cached = this.threads.get(notification.params.threadId);
        const outcome = normalizeOutcome(notification.params.turn.status);
        if (cached) {
          const turnIndex = cached.thread.turns.findIndex(
            (turn) => turn.id === notification.params.turn.id,
          );
          if (turnIndex >= 0) {
            cached.thread.turns[turnIndex] = notification.params.turn;
          } else {
            cached.thread.turns.push(notification.params.turn);
          }
        }
        if (cached?.currentTurnId && cached.currentTurnId !== notification.params.turn.id) break;
        if (cached) {
          cached.currentTurnId = null;
          cached.liveOutcome = outcome;
          cached.thread.status = { type: "idle" };
          cached.thread.updatedAt = Math.floor(Date.now() / 1_000);
          const updatedAt = cached.thread.updatedAt * 1_000;
          const hasPlan =
            turnContainsPlan(notification.params.turn) ||
            this.hasLivePlan(notification.params.threadId, notification.params.turn.id);
          await this.store.update((state) => {
            const meta = state.threadMeta[cached.thread.id] ?? {
              pinned: false,
              lastReadUpdatedAt: 0,
            };
            meta.lastOutcome = outcome;
            meta.outcomeUpdatedAt = updatedAt;
            const artifacts = meta.timelineArtifacts?.[notification.params.turn.id];
            meta.awaitingPlanResponse =
              outcome === "completed" &&
              ((meta.settings?.collaborationMode === "plan" && hasPlan) ||
                latestPlanChecklistIsIncomplete(artifacts));
            if (artifacts) {
              meta.timelineArtifacts![notification.params.turn.id] = artifacts.map((item) =>
                item.type === "planChecklist"
                  ? {
                      ...item,
                      status: outcome === "failed" ? "failed" : "completed",
                    }
                  : item,
              );
            }
            const snapshot = sessionSnapshot(cached);
            if (snapshot) meta.sessionSnapshot = snapshot;
            state.threadMeta[cached.thread.id] = meta;
          });
          this.publishThread(notification.params.threadId);
        }
        break;
      }
      case "turn/plan/updated": {
        const key = turnKey(notification.params.threadId, notification.params.turnId);
        const progress = {
          ...(this.progress.get(key) ?? emptyProgress(null)),
          explanation: notification.params.explanation,
          steps: notification.params.plan,
        } satisfies TurnProgress;
        this.progress.set(key, progress);
        await this.upsertTimelineArtifact(
          notification.params.threadId,
          notification.params.turnId,
          {
            type: "planChecklist",
            id: `${notification.params.turnId}-plan-checklist-${randomUUID()}`,
            status: "inProgress",
            explanation: notification.params.explanation,
            steps: notification.params.plan,
            timestamp: Date.now(),
            afterItemId: this.latestActivityId(
              notification.params.threadId,
              notification.params.turnId,
            ),
          },
        );
        this.publish({
          type: "turn.progressed",
          threadId: notification.params.threadId,
          turnId: notification.params.turnId,
          progress,
        });
        break;
      }
      case "turn/diff/updated": {
        const key = turnKey(notification.params.threadId, notification.params.turnId);
        const progress = {
          ...(this.progress.get(key) ?? emptyProgress(null)),
          ...diffStats(notification.params.diff),
        } satisfies TurnProgress;
        this.progress.set(key, progress);
        this.publish({
          type: "turn.progressed",
          threadId: notification.params.threadId,
          turnId: notification.params.turnId,
          progress,
        });
        break;
      }
      case "item/started":
      case "item/completed": {
        const sourceItem = notification.params.item;
        if (isInternalTeamContinuationItem(sourceItem)) break;
        this.captureSubagentTitles(sourceItem);
        if (
          notification.method === "item/completed" &&
          sourceItem.type === "collabAgentToolCall" &&
          sourceItem.tool === "wait" &&
          sourceItem.status === "completed"
        ) {
          const deliveryKey = activityKey(
            notification.params.threadId,
            notification.params.turnId,
            sourceItem.id,
          );
          if (!this.deliveredNativeWaits.has(deliveryKey)) {
            this.deliveredNativeWaits.add(deliveryKey);
            try {
              await this.markDeliveredThreadsRead(
                sourceItem.receiverThreadIds.filter((threadId) => {
                  const agent = sourceItem.agentsStates[threadId];
                  return agent?.status === "completed" && Boolean(agent.message?.trim());
                }),
                notification.params.completedAtMs,
              );
            } catch (error) {
              this.deliveredNativeWaits.delete(deliveryKey);
              throw error;
            }
          }
        }
        let key = activityKey(
          notification.params.threadId,
          notification.params.turnId,
          notification.params.item.type === "userMessage"
            ? (notification.params.item.clientId ?? notification.params.item.id)
            : notification.params.item.id,
        );
        let previous = this.activity.get(key);
        const eventTimestamp =
          notification.method === "item/started"
            ? notification.params.startedAtMs
            : notification.params.completedAtMs;
        const timestamp = previous?.type === "userMessage" ? previous.timestamp : eventTimestamp;
        let item = normalizeActivity(notification.params.item, timestamp);
        if (notification.method === "item/completed" && !previous) {
          const alias = this.streamingActivityAlias(
            notification.params.threadId,
            notification.params.turnId,
            item,
          );
          if (alias) {
            key = alias.key;
            previous = alias.item;
            item = { ...item, id: previous.id } as ActivityItem;
          }
        }
        this.activity.set(key, item);
        this.publish({
          type: "activity.upserted",
          threadId: notification.params.threadId,
          turnId: notification.params.turnId,
          item,
        });
        break;
      }
      case "item/agentMessage/delta":
      case "item/plan/delta":
      case "item/reasoning/summaryTextDelta": {
        this.appendTextDelta(
          notification.params.threadId,
          notification.params.turnId,
          notification.params.itemId,
          notification.params.delta,
          notification.method === "item/plan/delta"
            ? "plan"
            : notification.method.startsWith("item/reasoning")
              ? "reasoning"
              : "agentMessage",
        );
        break;
      }
      case "item/commandExecution/outputDelta": {
        const key = activityKey(
          notification.params.threadId,
          notification.params.turnId,
          notification.params.itemId,
        );
        const previous = this.activity.get(key);
        const item: ActivityItem =
          previous?.type === "command"
            ? { ...previous, output: previous.output + notification.params.delta }
            : {
                type: "command",
                id: notification.params.itemId,
                status: "inProgress",
                kind: "command",
                command: "",
                cwd: null,
                output: notification.params.delta,
                exitCode: null,
              };
        this.activity.set(key, item);
        this.publish(
          previous?.type === "command"
            ? {
                type: "activity.delta",
                threadId: notification.params.threadId,
                turnId: notification.params.turnId,
                itemId: notification.params.itemId,
                activityType: "command",
                delta: notification.params.delta,
              }
            : {
                type: "activity.upserted",
                threadId: notification.params.threadId,
                turnId: notification.params.turnId,
                item,
              },
        );
        break;
      }
      case "serverRequest/resolved":
        this.attention.expireByRpcId(notification.params.requestId);
        break;
      default:
        break;
    }
  }

  private captureSubagentTitles(item: Turn["items"][number]): void {
    if (item.type !== "collabAgentToolCall" || item.tool !== "spawnAgent" || !item.prompt) return;
    const title = subagentTaskTitle(item.prompt);
    if (!title) return;
    for (const threadId of item.receiverThreadIds) {
      if (this.threads.has(threadId)) {
        this.setSubagentTitle(threadId, title);
      } else {
        this.pendingSubagentTitles.set(threadId, title);
      }
    }
  }

  private async markDeliveredThreadsRead(
    threadIds: readonly string[],
    deliveredAt: number,
  ): Promise<void> {
    const readMarkers = this.readMarkers(threadIds, deliveredAt);
    const snapshot = this.store.view();
    if (
      !readMarkers.some(
        ([threadId, updatedAt]) =>
          updatedAt > (snapshot.threadMeta[threadId]?.lastReadUpdatedAt ?? 0),
      )
    ) {
      return;
    }
    const markedRead: string[] = [];
    await this.store.update((state) => {
      markedRead.push(...applyReadMarkers(state, readMarkers));
    });
    if (markedRead.length) {
      const state = this.store.view();
      for (const threadId of markedRead) this.publishThread(threadId, state);
    }
  }

  private readMarkers(
    threadIds: readonly string[],
    deliveredAt: number,
  ): Array<readonly [string, number]> {
    const markers: Array<readonly [string, number]> = [];
    for (const threadId of new Set(threadIds)) {
      const cached = this.threads.get(threadId);
      if (cached) {
        markers.push([threadId, Math.min(cached.thread.updatedAt * 1_000, deliveredAt)]);
      }
    }
    return markers;
  }

  private setSubagentTitle(threadId: string, title: string): void {
    const cached = this.threads.get(threadId);
    if (
      !cached ||
      !isSpawnedSubagent(cached.thread) ||
      cached.thread.name?.trim() ||
      this.subagentTitleUpdates.has(threadId)
    ) {
      return;
    }
    this.subagentTitleUpdates.add(threadId);
    cached.thread.name = title;
    this.publishThread(threadId);
    void this.bridge
      .request("thread/name/set", { threadId, name: title })
      .catch((error: unknown) => {
        this.emit("projectionError", error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => this.subagentTitleUpdates.delete(threadId));
  }

  private appendTextDelta(
    threadId: string,
    turnId: string,
    itemId: string,
    delta: string,
    type: "agentMessage" | "plan" | "reasoning",
  ): void {
    const key = activityKey(threadId, turnId, itemId);
    const previous = this.activity.get(key);
    const item: ActivityItem = {
      type,
      id: itemId,
      status: "inProgress",
      text: previous && "text" in previous ? previous.text + delta : delta,
      images: previous && "images" in previous ? previous.images : [],
      timestamp:
        previous && "timestamp" in previous
          ? previous.timestamp
          : (this.progress.get(turnKey(threadId, turnId))?.startedAt ?? Date.now()),
      phase: previous && "phase" in previous ? previous.phase : null,
    };
    this.activity.set(key, item);
    this.publish(
      previous && "text" in previous && previous.type === type
        ? { type: "activity.delta", threadId, turnId, itemId, activityType: type, delta }
        : { type: "activity.upserted", threadId, turnId, item },
    );
  }

  private streamingActivityAlias(
    threadId: string,
    turnId: string,
    completed: ActivityItem,
  ): { key: string; item: ActivityItem } | undefined {
    const prefix = `${threadId}:${turnId}:`;
    const entries = [...this.activity.entries()];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (!entry) continue;
      const [key, item] = entry;
      if (
        key.startsWith(prefix) &&
        item.status === "inProgress" &&
        sameRenderedActivity(item, completed, true)
      ) {
        return { key, item };
      }
    }
    return undefined;
  }

  private toSummary(
    cached: CachedThread,
    state: CodexNestStateView = this.store.view(),
  ): ThreadSummary {
    const meta = state.threadMeta[cached.thread.id] ?? { pinned: false, lastReadUpdatedAt: 0 };
    const updatedAt = cached.thread.updatedAt * 1_000;
    const threadState = this.threadState(cached, meta.lastOutcome, state);
    const unread = updatedAt > meta.lastReadUpdatedAt && isTerminal(threadState);
    return {
      id: cached.thread.id,
      projectId: projectForCwd(state.projects, cached.thread.cwd)?.id ?? null,
      title: cached.thread.name?.trim() || cached.thread.preview.trim() || "Без названия",
      preview: cached.thread.preview,
      cwd: cached.thread.cwd,
      state: threadState,
      unread,
      unseen: unread && updatedAt > (meta.lastViewedUpdatedAt ?? 0),
      pinned: meta.pinned,
      archived: cached.archived,
      createdAt: cached.thread.createdAt * 1_000,
      updatedAt,
      currentTurnId: cached.currentTurnId,
      queuedMessageCount: state.messageQueues?.[cached.thread.id]?.length ?? 0,
      settings: sessionSettings(meta.settings),
      relation: threadRelation(cached.thread, meta),
    };
  }

  private threadState(
    cached: CachedThread,
    stored: ThreadOutcome | undefined,
    state: CodexNestStateView,
  ): ThreadState {
    if (
      this.attention
        .list()
        .some((item) => item.threadId === cached.thread.id && item.kind !== "unsupported")
    ) {
      return "needsAttention";
    }
    const meta = state.threadMeta[cached.thread.id];
    if (meta?.managedParent) {
      const managedTask =
        state.threadMeta[meta.managedParent.parentThreadId]?.teamOrchestration?.tasks[
          meta.managedParent.taskId
        ];
      if (managedTask?.status === "queued") return "queued";
      if (managedTask?.status === "starting" || managedTask?.status === "running") return "running";
      if (managedTask && ["completed", "failed", "interrupted"].includes(managedTask.status)) {
        return managedTask.status as ThreadOutcome;
      }
    }
    if (cached.thread.status.type === "systemError") return "failed";
    if (cached.currentTurnId) return "running";
    if (isSpawnedSubagent(cached.thread) && cached.thread.status.type === "active")
      return "running";
    if (cached.goalStatus === "active") return "running";
    if (teamOrchestrationIsActive(meta?.teamOrchestration)) return "running";
    if (meta?.awaitingPlanResponse) {
      return "needsAttention";
    }
    return cached.liveOutcome ?? stored ?? "idle";
  }

  private sortedThreads(state: CodexNestStateView): ThreadSummary[] {
    return [...this.threads.values()]
      .map((cached) => this.toSummary(cached, state))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private publishThread(
    threadId: string,
    state: CodexNestStateView = this.store.view(),
  ): ThreadSummary | undefined {
    const cached = this.threads.get(threadId);
    if (!cached) return undefined;
    const summary = this.toSummary(cached, state);
    if (this.isCwdVisible(cached.thread.cwd, state)) {
      this.publish({ type: "thread.upserted", thread: summary });
    }
    return summary;
  }

  private isThreadVisible(
    threadId: string,
    state: CodexNestStateView = this.store.view(),
  ): boolean {
    const cached = this.threads.get(threadId);
    return !cached || this.isCwdVisible(cached.thread.cwd, state);
  }

  private isCwdVisible(cwd: string, state: CodexNestStateView): boolean {
    const project = projectForCwd(state.projects, cwd);
    let dismissedPath: string | undefined;
    for (const path of state.dismissedProjectPaths ?? []) {
      if (pathContains(path, cwd) && (!dismissedPath || path.length > dismissedPath.length)) {
        dismissedPath = path;
      }
    }
    return !dismissedPath || (!!project && project.path.length >= dismissedPath.length);
  }

  private publish(event: ServerEvent): void {
    this.sequence += 1;
    this.emit("event", this.sequence, event);
  }
}

function applyReadMarkers(
  state: CodexNestState,
  markers: Array<readonly [threadId: string, updatedAt: number]>,
): string[] {
  const markedRead: string[] = [];
  for (const [threadId, updatedAt] of markers) {
    const meta = state.threadMeta[threadId] ?? { pinned: false, lastReadUpdatedAt: 0 };
    if (updatedAt <= meta.lastReadUpdatedAt) continue;
    meta.lastReadUpdatedAt = updatedAt;
    state.threadMeta[threadId] = meta;
    markedRead.push(threadId);
  }
  return markedRead;
}

function notificationThreadId(notification: ServerNotification): string | undefined {
  const params: unknown = notification.params;
  if (!params || typeof params !== "object" || !("threadId" in params)) return undefined;
  const threadId = (params as { threadId?: unknown }).threadId;
  return typeof threadId === "string" ? threadId : undefined;
}

function isSpawnedSubagent(thread: Thread): boolean {
  return thread.parentThreadId !== null;
}

function isMissingThreadError(error: unknown): boolean {
  return (
    error instanceof RpcError && /not found|unknown thread|does not exist/i.test(error.message)
  );
}

function sessionSnapshot(cached: CachedThread): SessionSnapshotState | null {
  if (!isRecoverableUserSession(cached.thread)) return null;
  return {
    sessionId: cached.thread.sessionId,
    name: cached.thread.name,
    preview: cached.thread.preview,
    cwd: cached.thread.cwd,
    createdAt: cached.thread.createdAt,
    updatedAt: cached.thread.updatedAt,
    archived: cached.archived,
    currentTurnId: cached.currentTurnId,
  };
}

function sessionSnapshotsEqual(
  left: DeepReadonly<SessionSnapshotState> | undefined,
  right: SessionSnapshotState,
): boolean {
  return (
    left?.sessionId === right.sessionId &&
    left.name === right.name &&
    left.preview === right.preview &&
    left.cwd === right.cwd &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.archived === right.archived &&
    left.currentTurnId === right.currentTurnId
  );
}

function cachedThreadFromSessionSnapshot(
  id: string,
  snapshot: DeepReadonly<SessionSnapshotState>,
): CachedThread {
  return {
    archived: snapshot.archived,
    currentTurnId: snapshot.currentTurnId,
    thread: {
      id,
      extra: null,
      sessionId: snapshot.sessionId,
      forkedFromId: null,
      parentThreadId: null,
      preview: snapshot.preview,
      ephemeral: false,
      historyMode: "legacy",
      modelProvider: "openai",
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      recencyAt: snapshot.updatedAt,
      status: { type: "notLoaded" },
      path: null,
      cwd: snapshot.cwd,
      cliVersion: "",
      source: "appServer",
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: snapshot.name,
      turns: [],
    },
  };
}

function isRecoverableUserSession(thread: Thread): boolean {
  return (
    !thread.ephemeral &&
    !isSpawnedSubagent(thread) &&
    (thread.source === "cli" || thread.source === "vscode" || thread.source === "appServer")
  );
}

function managedThreadIds(state: CodexNestStateView): Set<string> {
  const threadIds = new Set<string>();
  for (const [threadId, meta] of Object.entries(state.threadMeta)) {
    if (meta.teamOrchestration !== undefined) {
      threadIds.add(threadId);
      for (const task of Object.values(meta.teamOrchestration.tasks)) {
        threadIds.add(task.childThreadId);
      }
    }
    if (meta.managedParent && state.threadMeta[meta.managedParent.parentThreadId] !== undefined) {
      threadIds.add(threadId);
      threadIds.add(meta.managedParent.parentThreadId);
    }
  }
  return threadIds;
}

function hasSubagentTranscript(
  thread: Thread,
  meta?: CodexNestStateView["threadMeta"][string],
): boolean {
  return isSpawnedSubagent(thread) || meta?.managedParent !== undefined;
}

function subagentTranscriptTurnViews(
  thread: Thread,
  turns: TurnView[],
  meta?: CodexNestStateView["threadMeta"][string],
): TurnView[] {
  if (!turns.length) return [];
  if (!isSpawnedSubagent(thread) && meta?.managedParent) {
    let keptInput = false;
    return turns.map((turn) => ({
      ...turn,
      items: turn.items.filter((item) => {
        if (item.type !== "userMessage") return true;
        if (keptInput) return false;
        keptInput = true;
        return true;
      }),
    }));
  }

  const expectedTitle = thread.name?.trim() || null;
  let boundary: { turnIndex: number; itemIndex: number } | null = null;

  for (let turnIndex = turns.length - 1; turnIndex >= 0 && !boundary; turnIndex -= 1) {
    const turn = turns[turnIndex]!;
    for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = turn.items[itemIndex]!;
      if (item.type !== "userMessage") continue;
      if (expectedTitle && subagentTaskTitle(item.text) !== expectedTitle) continue;
      boundary = { turnIndex, itemIndex };
      break;
    }
  }

  if (!boundary) return [];

  let keptInput = false;
  return turns.slice(boundary.turnIndex).map((turn, index) => ({
    ...turn,
    items: (index === 0 ? turn.items.slice(boundary.itemIndex) : turn.items).filter((item) => {
      if (item.type !== "userMessage") return true;
      if (keptInput) return false;
      keptInput = true;
      return true;
    }),
  }));
}

function syncPointForPage(cursor: string | null, turns: TurnView[]): ThreadSyncPoint | null {
  const anchor = turns.at(-1);
  if (!cursor || !anchor) return null;
  return {
    cursor,
    anchorTurnId: anchor.id,
    anchorRevision: turnRevision(anchor),
  };
}

function turnRevision(turn: TurnView): string {
  return createHash("sha256").update(JSON.stringify(turn)).digest("base64url");
}

function subagentTitleFromTurns(turns: Turn[]): string | null {
  for (const turn of turns) {
    for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = turn.items[itemIndex]!;
      if (item.type !== "userMessage") continue;
      const title = subagentTaskTitle(userMessageText(item));
      if (title) return title;
    }
  }
  return null;
}

function userMessageText(item: Extract<Turn["items"][number], { type: "userMessage" }>): string {
  return item.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function subagentTaskTitle(prompt: string): string | null {
  const firstLine = prompt
    .split(/\r?\n/u)
    .find((line) => line.trim())
    ?.trim();
  const explicitTitle = firstLine?.match(
    /^(?:#{1,6}\s*)?(?:task|задача(?: субагента)?)\s*:\s*(.+)$/iu,
  )?.[1];
  let normalized = (explicitTitle ?? prompt).replace(/\s+/gu, " ").trim();
  normalized = normalized
    .replace(/^(?:#{1,6}\s*|[-*]\s+|>\s*)/u, "")
    .replace(/^(?:task|задача(?: субагента)?)\s*:\s*/iu, "")
    .trim();
  if (!normalized) return null;

  const characters = [...normalized];
  if (characters.length <= 60) return normalized;
  let title = characters.slice(0, 59).join("");
  const wordBoundary = title.lastIndexOf(" ");
  if (wordBoundary >= 36) title = title.slice(0, wordBoundary);
  title = title.replace(/[\s,.:;!?—-]+$/u, "");
  return title ? `${title}…` : null;
}

function threadRelation(
  thread: Thread,
  meta?: CodexNestStateView["threadMeta"][string],
): ThreadSummary["relation"] {
  if (meta?.managedParent) {
    return {
      kind: "subagent",
      sessionId: thread.sessionId,
      parentThreadId: meta.managedParent.parentThreadId,
      nickname: null,
      role: null,
    };
  }
  return thread.parentThreadId === null
    ? { kind: "session", sessionId: thread.sessionId }
    : {
        kind: "subagent",
        sessionId: thread.sessionId,
        parentThreadId: thread.parentThreadId,
        nickname: thread.agentNickname,
        role: thread.agentRole,
      };
}

function sessionSettings(settings?: SessionSettings): SessionSettings {
  return {
    collaborationMode: settings?.collaborationMode ?? "default",
    ...(settings?.model === undefined ? {} : { model: settings.model }),
    ...(settings?.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: settings.reasoningEffort }),
    ...(settings?.serviceTier === undefined ? {} : { serviceTier: settings.serviceTier }),
    ...(settings?.personality === undefined ? {} : { personality: settings.personality }),
  };
}

function normalizeModel(model: Model): ModelOption {
  return {
    id: model.id,
    displayName: model.displayName,
    description: model.description,
    isDefault: model.isDefault,
    reasoningEfforts: model.supportedReasoningEfforts.map((option) => ({
      value: option.reasoningEffort,
      description: option.description,
      isDefault: option.reasoningEffort === model.defaultReasoningEffort,
    })),
    serviceTiers: model.serviceTiers.map((tier) => ({ id: tier.id, displayName: tier.name })),
    supportsPersonality: model.supportsPersonality,
  };
}

function normalizeTurn(
  turn: Turn,
  liveProgress?: TurnProgress,
  liveActivities: ActivityItem[] = [],
  artifacts: TimelineArtifact[] = [],
  itemsLoaded = true,
): TurnView {
  const startedAt = turn.startedAt === null ? null : turn.startedAt * 1_000;
  const completedAt = turn.completedAt === null ? null : turn.completedAt * 1_000;
  const liveMerge = mergeLiveActivities(
    turn.items
      .filter((item) => !isInternalTeamContinuationItem(item))
      .map((item) =>
        normalizeActivity(
          item,
          item.type === "userMessage" ? startedAt : (completedAt ?? startedAt),
        ),
      ),
    liveActivities,
    turn.status !== "inProgress",
  );
  const items = mergeTimelineArtifacts(liveMerge.items, artifacts, liveMerge.aliases);
  if (turn.error) {
    items.push({
      type: "error",
      id: `${turn.id}-error`,
      status: "failed",
      message: turn.error.message,
    });
  }
  return {
    id: turn.id,
    status: turn.status === "inProgress" ? "inProgress" : normalizeOutcome(turn.status),
    startedAt,
    completedAt,
    durationMs: turn.durationMs,
    progress: liveProgress ?? emptyProgress(turn.startedAt),
    items,
    itemsLoaded,
  };
}

function mergeLiveActivities(
  items: ActivityItem[],
  liveActivities: ActivityItem[],
  turnIsTerminal: boolean,
): { items: ActivityItem[]; aliases: Map<string, string> } {
  const result = [...items];
  const unmatchedCanonicalIds = new Set(items.map((item) => item.id));
  const canonicalMatchByLiveId = new Map<string, string>();
  const aliases = new Map<string, string>();
  for (const item of liveActivities) {
    const exact = unmatchedCanonicalIds.has(item.id)
      ? item.id
      : items.find(
          (candidate) =>
            unmatchedCanonicalIds.has(candidate.id) &&
            sameRenderedActivity(
              candidate,
              item,
              candidate.status === "inProgress" || item.status === "inProgress",
            ),
        )?.id;
    if (!exact) continue;
    canonicalMatchByLiveId.set(item.id, exact);
    unmatchedCanonicalIds.delete(exact);
  }
  for (const [itemIndex, item] of liveActivities.entries()) {
    const canonicalId = canonicalMatchByLiveId.get(item.id);
    const existing = canonicalId
      ? result.findIndex((candidate) => candidate.id === canonicalId)
      : -1;
    if (existing >= 0) {
      const canonical = result[existing]!;
      if (item.id !== canonical.id) aliases.set(item.id, canonical.id);
      result[existing] = {
        ...fresherLiveActivity(canonical, item, turnIsTerminal),
        id: canonical.id,
      } as ActivityItem;
      continue;
    }
    if (
      item.type === "userMessage" &&
      !result.some((candidate) => candidate.type === "userMessage")
    ) {
      result.unshift(item);
      continue;
    }
    const nextCanonicalId = liveActivities
      .slice(itemIndex + 1)
      .map((candidate) => canonicalMatchByLiveId.get(candidate.id))
      .find(
        (candidateId) =>
          candidateId !== undefined &&
          result.some((existingItem) => existingItem.id === candidateId),
      );
    const insertion = nextCanonicalId
      ? result.findIndex((candidate) => candidate.id === nextCanonicalId)
      : result.length;
    result.splice(insertion, 0, item);
  }
  return { items: result, aliases };
}

function fresherLiveActivity(
  current: ActivityItem,
  live: ActivityItem,
  turnIsTerminal: boolean,
): ActivityItem {
  if (current.status === "inProgress" && live.status !== "inProgress") return live;
  if (current.status !== "inProgress" && live.status === "inProgress") {
    return turnIsTerminal ? current : live;
  }
  if (current.type === live.type && "text" in current && "text" in live) {
    if (current.text.startsWith(live.text) && current.text.length > live.text.length)
      return current;
    if (live.text.startsWith(current.text) && live.text.length > current.text.length) return live;
  }
  if (current.type === "command" && live.type === "command") {
    if (current.output.startsWith(live.output) && current.output.length > live.output.length) {
      return current;
    }
    if (live.output.startsWith(current.output) && live.output.length > current.output.length) {
      return live;
    }
  }
  return live;
}

function isInternalTeamContinuationItem(item: Turn["items"][number]): boolean {
  return (
    item.type === "userMessage" &&
    typeof item.clientId === "string" &&
    (item.clientId.startsWith("codexnest-team-claim:") ||
      item.clientId.startsWith("codexnest-team-continuation:"))
  );
}

function normalizeActivity(
  item: Turn["items"][number],
  timestamp: number | null = null,
): ActivityItem {
  switch (item.type) {
    case "userMessage":
      return {
        type: "userMessage",
        id: item.clientId ?? item.id,
        status: "completed",
        text: item.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
        images: item.content.filter((part) => part.type === "image").map((part) => part.url),
        timestamp,
        phase: null,
      };
    case "agentMessage":
      return {
        type: "agentMessage",
        id: item.id,
        status: "completed",
        text: item.text,
        images: [],
        timestamp,
        phase: item.phase,
      };
    case "plan":
      return {
        type: "plan",
        id: item.id,
        status: "completed",
        text: item.text,
        images: [],
        timestamp,
        phase: null,
      };
    case "reasoning":
      return {
        type: "reasoning",
        id: item.id,
        status: "completed",
        text: item.summary.join("\n"),
        images: [],
        timestamp,
        phase: null,
      };
    case "commandExecution":
      return {
        type: "command",
        id: item.id,
        status: normalizeItemStatus(item.status),
        kind: commandKind(item.commandActions),
        command: item.command,
        cwd: item.cwd,
        output: item.aggregatedOutput ?? "",
        exitCode: item.exitCode,
      };
    case "fileChange":
      return {
        type: "fileChange",
        id: item.id,
        status: normalizeItemStatus(item.status),
        path: item.changes[0]?.path ?? null,
        patch: item.changes.map((change) => change.diff).join("\n"),
      };
    case "mcpToolCall":
      return {
        type: "tool",
        id: item.id,
        status: normalizeItemStatus(item.status),
        title: `${item.server}: ${item.tool}`,
        detail: item.error ? "Инструмент завершился с ошибкой" : "MCP-инструмент",
      };
    case "dynamicToolCall":
      if (
        item.namespace === "codexnest" &&
        item.tool === "spawn_task" &&
        isRecord(item.arguments) &&
        typeof item.arguments.title === "string" &&
        item.arguments.title.trim()
      ) {
        return {
          type: "subagentLaunch",
          id: item.id,
          status: normalizeItemStatus(item.status),
          title: item.arguments.title.trim(),
          threadId: managedSpawnThreadId(item.contentItems),
        };
      }
      return {
        type: "tool",
        id: item.id,
        status: normalizeItemStatus(item.status),
        title: [item.namespace, item.tool].filter(Boolean).join(":"),
        detail: "Инструмент",
      };
    default:
      return {
        type: "tool",
        id: "id" in item ? item.id : `activity-${Date.now()}`,
        status: "completed",
        title: item.type,
        detail: "Активность Codex",
      };
  }
}

function managedSpawnThreadId(
  contentItems: Extract<Turn["items"][number], { type: "dynamicToolCall" }>["contentItems"],
): string | null {
  for (const content of contentItems ?? []) {
    if (content.type !== "inputText") continue;
    try {
      const value: unknown = JSON.parse(content.text);
      if (isRecord(value) && typeof value.threadId === "string" && value.threadId) {
        return value.threadId;
      }
    } catch {
      // A malformed tool response should not hide the launch activity.
    }
  }
  return null;
}

function mergeTimelineArtifacts(
  items: ActivityItem[],
  artifacts: TimelineArtifact[],
  aliases: Map<string, string> = new Map(),
): ActivityItem[] {
  const result = [...items];
  for (const artifact of artifacts) {
    const existing = result.findIndex((item) => item.id === artifact.id);
    if (existing >= 0) {
      result[existing] = artifact;
      continue;
    }
    const resolvedAfterItemId = artifact.afterItemId
      ? (aliases.get(artifact.afterItemId) ?? artifact.afterItemId)
      : null;
    const resolvedArtifact =
      resolvedAfterItemId === artifact.afterItemId
        ? artifact
        : { ...artifact, afterItemId: resolvedAfterItemId };
    const anchor = resolvedAfterItemId
      ? result.findIndex((item) => item.id === resolvedAfterItemId)
      : -1;
    let insertion = anchor >= 0 ? anchor + 1 : fallbackArtifactPosition(result, resolvedArtifact);
    while (insertion < result.length) {
      const candidate = result[insertion];
      if (!candidate || !isTimelineArtifact(candidate)) break;
      if (candidate.afterItemId !== resolvedAfterItemId) break;
      insertion += 1;
    }
    result.splice(insertion, 0, resolvedArtifact);
  }
  return result;
}

function sameRenderedActivity(
  first: ActivityItem,
  second: ActivityItem,
  allowPrefix: boolean,
): boolean {
  if (
    first.type !== second.type ||
    !["agentMessage", "reasoning", "plan"].includes(first.type) ||
    !("text" in first) ||
    !("text" in second)
  ) {
    return false;
  }
  const compatiblePhase =
    first.phase === second.phase || first.phase === null || second.phase === null;
  if (!compatiblePhase) return false;
  if (first.text === second.text) return true;
  return (
    allowPrefix &&
    Boolean(first.text && second.text) &&
    (first.text.startsWith(second.text) || second.text.startsWith(first.text))
  );
}

function fallbackArtifactPosition(items: ActivityItem[], artifact: TimelineArtifact): number {
  if (artifact.type === "userInputResponse") {
    const finalResponse = items.findIndex(
      (item) =>
        item.type === "plan" || (item.type === "agentMessage" && item.phase === "final_answer"),
    );
    if (finalResponse >= 0) return finalResponse;
  }
  let insertion = 0;
  while (items[insertion]?.type === "userMessage") insertion += 1;
  return artifact.type === "planChecklist" || artifact.type === "orchestrationNotice"
    ? insertion
    : items.length;
}

function isTimelineArtifact(item: ActivityItem): item is TimelineArtifact {
  return (
    item.type === "userInputResponse" ||
    item.type === "planChecklist" ||
    item.type === "orchestrationNotice"
  );
}

function turnContainsPlan(turn: Turn): boolean {
  return turn.items.some((item) => item.type === "plan" && item.text.trim());
}

function latestPlanChecklistIsIncomplete(items: TimelineArtifact[] | undefined): boolean {
  if (!items) return false;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type === "planChecklist") {
      return item.steps.some((step) => step.status !== "completed");
    }
  }
  return false;
}

function commandKind(actions: Array<{ type: string }>): "read" | "search" | "command" {
  if (actions.length && actions.every((action) => action.type === "read")) return "read";
  if (
    actions.length &&
    actions.every((action) => ["read", "listFiles", "search"].includes(action.type))
  ) {
    return "search";
  }
  return "command";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyProgress(startedAt: number | null): TurnProgress {
  return {
    startedAt: startedAt === null ? null : startedAt * 1_000,
    explanation: null,
    steps: [],
    filesChanged: 0,
    additions: 0,
    deletions: 0,
  };
}

export function diffStats(
  diff: string,
): Pick<TurnProgress, "filesChanged" | "additions" | "deletions"> {
  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (match?.[2]) files.add(match[2]);
    } else if (line.startsWith("+++") && !line.endsWith("/dev/null")) {
      files.add(line.replace(/^\+\+\+\s+(?:b\/)?/, ""));
    }
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { filesChanged: files.size, additions, deletions };
}

function normalizeItemStatus(status: string): "inProgress" | "completed" | "failed" {
  const normalized = status.toLowerCase();
  if (normalized.includes("progress") || normalized.includes("running")) return "inProgress";
  if (normalized.includes("fail") || normalized.includes("declin") || normalized.includes("error"))
    return "failed";
  return "completed";
}

function normalizeOutcome(status: string | undefined): ThreadOutcome {
  if (status === "failed") return "failed";
  if (status === "interrupted") return "interrupted";
  return "completed";
}

function parseThreadGoalStatus(response: unknown): ThreadGoal["status"] | null {
  if (!response || typeof response !== "object" || !("goal" in response)) {
    throw new Error("Invalid thread goal response");
  }
  const goal = (response as { goal?: unknown }).goal;
  if (goal === null) return null;
  if (!goal || typeof goal !== "object" || !("status" in goal)) {
    throw new Error("Invalid thread goal response");
  }
  const status = (goal as { status?: unknown }).status;
  if (
    status !== "active" &&
    status !== "paused" &&
    status !== "blocked" &&
    status !== "usageLimited" &&
    status !== "budgetLimited" &&
    status !== "complete"
  ) {
    throw new Error("Invalid thread goal response");
  }
  return status;
}

function activeTurnId(thread: Thread): string | null {
  for (let index = thread.turns.length - 1; index >= 0; index -= 1) {
    const turn = thread.turns[index];
    if (turn?.status === "inProgress") return turn.id;
  }
  return null;
}

function activityKey(threadId: string, turnId: string, itemId: string): string {
  return `${threadId}:${turnId}:${itemId}`;
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}

function publicVoiceTranscription(job: VoiceTranscriptionState): VoiceTranscriptionJob {
  return {
    id: job.id,
    threadId: job.threadId,
    mode: job.mode,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    audioDurationMs: job.audioDurationMs,
    estimatedTotalSeconds: job.estimatedTotalSeconds,
    error: job.error,
  };
}

function isTerminal(state: ThreadState): state is ThreadOutcome {
  return state === "completed" || state === "failed" || state === "interrupted";
}

function teamOrchestrationIsActive(
  orchestration: CodexNestStateView["threadMeta"][string]["teamOrchestration"],
): boolean {
  if (!orchestration) return false;
  return Object.values(orchestration.tasks).some(
    (task) =>
      task.status === "queued" ||
      task.status === "starting" ||
      task.status === "running" ||
      task.delivery?.status !== "delivered",
  );
}

function cloneView<T>(value: DeepReadonly<T>): T {
  return structuredClone(value) as T;
}
