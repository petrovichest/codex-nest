import { randomUUID } from "node:crypto";
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
  ThreadDetail,
  ThreadDraft,
  UpdateThreadDraftRequest,
  ThreadGoal,
  ThreadOutcome,
  ThreadState,
  ThreadSummary,
  TurnProgress,
  TurnView,
  UiLanguage,
} from "@codexnest/protocol";

import type { AttentionManager } from "./attention";
import type { CodexBridge } from "./codex/bridge";
import type { ServerNotification } from "./codex/generated/index";
import type { Model, Thread, Turn } from "./codex/generated/v2/index";
import { parseModelList, parseThreadList, parseThreadResume, parseTurnsList } from "./codex/guards";
import { pathContains, projectForCwd } from "./projects";
import type { CodexNestState, StateStore, TimelineArtifact } from "./state/store";

interface CachedThread {
  thread: Thread;
  archived: boolean;
  currentTurnId: string | null;
  liveOutcome?: ThreadOutcome;
  goalStatus?: ThreadGoal["status"] | null;
}

const THREAD_TURN_PAGE_SIZE = 20;

export class AppProjection extends EventEmitter {
  private readonly threads = new Map<string, CachedThread>();
  private readonly unmaterializedThreads = new Set<string>();
  private readonly activity = new Map<string, ActivityItem>();
  private readonly progress = new Map<string, TurnProgress>();
  private readonly subscribedThreads = new Set<string>();
  private readonly hiddenThreads = new Set<string>();
  private models: ModelOption[] = [];
  private sequence = 0;
  private syncedAt: string | null = null;
  private syncPromise?: Promise<void>;

  constructor(
    private readonly bridge: CodexBridge,
    private readonly store: StateStore,
    private readonly attention: AttentionManager,
    private readonly pushConfigured: boolean,
  ) {
    super();
    bridge.on("state", (state) => {
      if (state !== "ready") {
        this.subscribedThreads.clear();
        this.hiddenThreads.clear();
        for (const cached of this.threads.values()) cached.goalStatus = undefined;
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
      if (!request.threadId || this.isThreadVisible(request.threadId)) {
        this.publish({ type: "attention.upserted", attention: request });
      }
      if (request.threadId) this.publishThread(request.threadId);
    });
    attention.on("removed", (attentionId: string) => {
      this.publish({ type: "attention.removed", attentionId });
      for (const threadId of this.threads.keys()) this.publishThread(threadId);
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
    const state = this.store.snapshot();
    const threads = this.sortedThreads().filter((thread) => this.isCwdVisible(thread.cwd, state));
    const visibleThreadIds = new Set(threads.map((thread) => thread.id));
    return {
      sequence: this.sequence,
      uiLanguage: state.uiLanguage,
      connection: this.connection,
      projects: state.projects,
      threads,
      attention: this.attention
        .list()
        .filter((request) => !request.threadId || visibleThreadIds.has(request.threadId)),
      models: this.models,
      defaultReasoningEffort: this.store.snapshot().defaultReasoningEffort,
      taskDefaults: this.store.snapshot().taskDefaults ?? {},
      pushConfigured: this.pushConfigured,
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
    const state = this.store.snapshot();
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
    this.syncPromise = this.performSync().finally(() => {
      this.syncPromise = undefined;
    });
    return this.syncPromise;
  }

  async readThread(id: string, cursor: string | null = null): Promise<ThreadDetail> {
    const local = this.threads.get(id);
    if (local && this.isUnmaterialized(id)) {
      const state = this.store.snapshot();
      return {
        summary: this.toSummary(local),
        turns: [],
        queuedMessages: state.messageQueues?.[id] ?? [],
        olderTurnsCursor: null,
        draft: state.threadMeta[id]?.draft ?? null,
      };
    }
    const page = parseTurnsList(
      await this.bridge.request<unknown>(
        "thread/turns/list",
        {
          threadId: id,
          cursor,
          limit: THREAD_TURN_PAGE_SIZE,
          sortDirection: "desc",
          itemsView: "full",
        },
        30_000,
      ),
    );
    const cached = this.threads.get(id);
    if (!cached) throw new Error("Thread not found");
    const state = this.store.snapshot();
    const artifacts = state.threadMeta[id]?.timelineArtifacts ?? {};
    return {
      summary: this.toSummary(cached),
      turns: page.data
        .slice()
        .reverse()
        .map((turn) =>
          normalizeTurn(
            turn,
            this.progress.get(turnKey(id, turn.id)),
            this.liveActivities(id, turn.id),
            artifacts[turn.id] ?? [],
          ),
        ),
      queuedMessages: state.messageQueues?.[id] ?? [],
      olderTurnsCursor: page.nextCursor,
      draft: state.threadMeta[id]?.draft ?? null,
    };
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
    const state = this.store.snapshot();
    return [...this.threads.values()]
      .filter((cached) => {
        const summary = this.toSummary(cached);
        const unmaterialized = state.threadMeta[cached.thread.id]?.unmaterialized;
        return (
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
        const aKnown = state.threadMeta[a.thread.id]?.unmaterialized === true ? 1 : 0;
        const bKnown = state.threadMeta[b.thread.id]?.unmaterialized === true ? 1 : 0;
        return bKnown - aKnown || b.thread.updatedAt - a.thread.updatedAt;
      })
      .map((cached) => ({
        thread: this.toSummary(cached),
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
    const project = this.store.snapshot().projects.find((candidate) => candidate.id === projectId);
    if (project) this.publish({ type: "project.upserted", project });
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
    if (this.isThreadVisible(threadId)) {
      this.publish({ type: "queue.changed", threadId, messages });
    }
    this.publishThread(threadId);
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
    this.publishThread(thread.id);
    return this.toSummary(cached);
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
      this.store.snapshot().threadMeta[threadId]?.unmaterialized === true
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
    cached.currentTurnId = turnId;
    cached.liveOutcome = undefined;
    cached.thread.status = { type: "active", activeFlags: [] };
    cached.thread.updatedAt = Math.floor(Date.now() / 1_000);
    if (this.store.snapshot().threadMeta[threadId]?.awaitingPlanResponse) {
      await this.store.update((state) => {
        const meta = state.threadMeta[threadId];
        if (meta) meta.awaitingPlanResponse = false;
      });
    }
    this.publishThread(threadId);
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
    this.publish({ type: "activity.upserted", threadId, turnId, item });
  }

  private async upsertTimelineArtifact(
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
          : items.map((candidate, itemIndex) => (itemIndex === index ? item : candidate));
      state.threadMeta[threadId] = meta;
    });
    this.activity.set(activityKey(threadId, turnId, item.id), item);
    this.publish({ type: "activity.upserted", threadId, turnId, item });
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
    const [listedActive, archived, models] = await Promise.all([
      this.listAllThreads(false),
      this.listAllThreads(true),
      this.listAllModels(),
    ]);
    const active = await Promise.all(
      listedActive.map(async (thread) => {
        const cachedGoalStatus = this.threads.get(thread.id)?.goalStatus;
        const [resumedThread, restoredGoalStatus] = await Promise.all([
          this.rejoinActiveThread(thread),
          thread.status.type === "active" && cachedGoalStatus === undefined
            ? this.readThreadGoalStatus(thread.id)
            : Promise.resolve(cachedGoalStatus),
        ]);
        return { thread: resumedThread, restoredGoalStatus };
      }),
    );
    const incoming = new Set<string>();
    for (const { thread, restoredGoalStatus } of active) {
      incoming.add(thread.id);
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
      this.threads.set(thread.id, {
        thread,
        archived: true,
        currentTurnId: activeTurnId(thread),
        goalStatus: this.threads.get(thread.id)?.goalStatus,
      });
    }
    for (const id of this.threads.keys()) {
      if (!incoming.has(id) && !this.unmaterializedThreads.has(id)) this.threads.delete(id);
    }

    await this.store.update((state) => {
      for (const cached of this.threads.values()) {
        state.threadMeta[cached.thread.id] ??= {
          pinned: false,
          lastReadUpdatedAt: cached.thread.updatedAt * 1_000,
        };
      }
    });
    await this.reconcileOutcomes();
    this.models = models;
    this.syncedAt = new Date().toISOString();
    this.publish({ type: "models.changed", models });
    this.publish({ type: "resync.required" });
  }

  private async rejoinActiveThread(thread: Thread): Promise<Thread> {
    if (thread.status.type !== "active" || this.subscribedThreads.has(thread.id)) return thread;
    try {
      const resumed = parseThreadResume(
        await this.bridge.request<unknown>("thread/resume", { threadId: thread.id }, 30_000),
      );
      this.subscribedThreads.add(thread.id);
      return resumed.thread;
    } catch (error) {
      this.emit("projectionError", error instanceof Error ? error : new Error(String(error)));
      return thread;
    }
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
          { cursor, limit: 100, sortKey: "updated_at", sortDirection: "desc", archived },
          30_000,
        ),
      );
      threads.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    return threads;
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
    const state = this.store.snapshot();
    for (const cached of this.threads.values()) {
      if (cached.thread.status.type !== "idle") continue;
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
    if (notification.method === "thread/started" && notification.params.thread.ephemeral) {
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
      case "thread/started":
        this.upsertThread(notification.params.thread);
        break;
      case "thread/status/changed": {
        const cached = this.threads.get(notification.params.threadId);
        if (cached) {
          cached.thread.status = notification.params.status;
          if (notification.params.status.type === "systemError") {
            cached.currentTurnId = null;
            cached.liveOutcome = "failed";
          }
          this.publishThread(notification.params.threadId);
        }
        break;
      }
      case "thread/name/updated": {
        const cached = this.threads.get(notification.params.threadId);
        if (cached) {
          cached.thread.name = notification.params.threadName ?? null;
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
        if (cached) cached.archived = true;
        this.publishThread(notification.params.threadId);
        break;
      }
      case "thread/unarchived": {
        const cached = this.threads.get(notification.params.threadId);
        if (cached) cached.archived = false;
        this.publishThread(notification.params.threadId);
        break;
      }
      case "thread/deleted":
      case "thread/closed":
        this.threads.delete(notification.params.threadId);
        this.subscribedThreads.delete(notification.params.threadId);
        this.unmaterializedThreads.delete(notification.params.threadId);
        for (const key of this.progress.keys()) {
          if (key.startsWith(`${notification.params.threadId}:`)) this.progress.delete(key);
        }
        this.publish({ type: "thread.removed", threadId: notification.params.threadId });
        break;
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
        this.publish({
          type: "activity.upserted",
          threadId: notification.params.threadId,
          turnId: notification.params.turnId,
          item,
        });
        break;
      }
      case "serverRequest/resolved":
        this.attention.expireByRpcId(notification.params.requestId);
        break;
      default:
        break;
    }
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
    this.publish({ type: "activity.upserted", threadId, turnId, item });
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

  private toSummary(cached: CachedThread): ThreadSummary {
    const state = this.store.snapshot();
    const meta = state.threadMeta[cached.thread.id] ?? { pinned: false, lastReadUpdatedAt: 0 };
    const updatedAt = cached.thread.updatedAt * 1_000;
    const threadState = this.threadState(cached, meta.lastOutcome);
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
    };
  }

  private threadState(cached: CachedThread, stored?: ThreadOutcome): ThreadState {
    if (
      this.attention
        .list()
        .some((item) => item.threadId === cached.thread.id && item.kind !== "unsupported")
    ) {
      return "needsAttention";
    }
    if (cached.thread.status.type === "systemError") return "failed";
    if (cached.currentTurnId) return "running";
    if (cached.goalStatus === "active") return "running";
    if (this.store.snapshot().threadMeta[cached.thread.id]?.awaitingPlanResponse) {
      return "needsAttention";
    }
    return cached.liveOutcome ?? stored ?? "idle";
  }

  private sortedThreads(): ThreadSummary[] {
    return [...this.threads.values()]
      .map((cached) => this.toSummary(cached))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private publishThread(threadId: string): void {
    if (!this.isThreadVisible(threadId)) return;
    const summary = this.summary(threadId);
    if (summary) this.publish({ type: "thread.upserted", thread: summary });
  }

  private isThreadVisible(threadId: string): boolean {
    const cached = this.threads.get(threadId);
    return !cached || this.isCwdVisible(cached.thread.cwd, this.store.snapshot());
  }

  private isCwdVisible(cwd: string, state: CodexNestState): boolean {
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

function notificationThreadId(notification: ServerNotification): string | undefined {
  const params: unknown = notification.params;
  if (!params || typeof params !== "object" || !("threadId" in params)) return undefined;
  const threadId = (params as { threadId?: unknown }).threadId;
  return typeof threadId === "string" ? threadId : undefined;
}

function sessionSettings(settings?: SessionSettings): SessionSettings {
  return {
    ...DEFAULT_SESSION_SETTINGS,
    ...(settings?.model === undefined ? {} : { model: settings.model }),
    ...(settings?.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: settings.reasoningEffort }),
    ...(settings?.serviceTier === undefined ? {} : { serviceTier: settings.serviceTier }),
    ...(settings?.personality === undefined ? {} : { personality: settings.personality }),
    ...(settings?.collaborationMode === undefined
      ? {}
      : { collaborationMode: settings.collaborationMode }),
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
): TurnView {
  const startedAt = turn.startedAt === null ? null : turn.startedAt * 1_000;
  const completedAt = turn.completedAt === null ? null : turn.completedAt * 1_000;
  const liveMerge = mergeLiveActivities(
    turn.items.map((item) =>
      normalizeActivity(item, item.type === "userMessage" ? startedAt : (completedAt ?? startedAt)),
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
  };
}

function mergeLiveActivities(
  items: ActivityItem[],
  liveActivities: ActivityItem[],
  turnIsTerminal: boolean,
): { items: ActivityItem[]; aliases: Map<string, string> } {
  const result = [...items];
  const canonicalIds = new Set(items.map((item) => item.id));
  const matchedCanonicalIds = new Set<string>();
  const aliases = new Map<string, string>();
  for (const [itemIndex, item] of liveActivities.entries()) {
    const existing = result.findIndex((candidate) => candidate.id === item.id);
    if (existing >= 0) {
      result[existing] = fresherLiveActivity(result[existing]!, item, turnIsTerminal);
      if (canonicalIds.has(item.id)) matchedCanonicalIds.add(item.id);
      continue;
    }
    const semanticMatch = result.findIndex(
      (candidate) =>
        canonicalIds.has(candidate.id) &&
        !matchedCanonicalIds.has(candidate.id) &&
        sameRenderedActivity(
          candidate,
          item,
          candidate.status === "inProgress" || item.status === "inProgress",
        ),
    );
    if (semanticMatch >= 0) {
      const canonical = result[semanticMatch]!;
      aliases.set(item.id, canonical.id);
      matchedCanonicalIds.add(canonical.id);
      result[semanticMatch] = {
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
    const nextLiveId = liveActivities
      .slice(itemIndex + 1)
      .find((candidate) => result.some((existingItem) => existingItem.id === candidate.id))?.id;
    const insertion = nextLiveId
      ? result.findIndex((candidate) => candidate.id === nextLiveId)
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
  return artifact.type === "planChecklist" ? insertion : items.length;
}

function isTimelineArtifact(item: ActivityItem): item is TimelineArtifact {
  return item.type === "userInputResponse" || item.type === "planChecklist";
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

function isTerminal(state: ThreadState): state is ThreadOutcome {
  return state === "completed" || state === "failed" || state === "interrupted";
}
