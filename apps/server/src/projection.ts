import { EventEmitter } from "node:events";

import { DEFAULT_SESSION_SETTINGS } from "@codexnest/protocol";
import type {
  ActivityItem,
  AppSnapshot,
  ModelOption,
  Project,
  QueuedMessage,
  SessionSettings,
  ServerEvent,
  ThreadDetail,
  ThreadOutcome,
  ThreadState,
  ThreadSummary,
  TurnProgress,
  TurnView,
} from "@codexnest/protocol";

import type { AttentionManager } from "./attention";
import type { CodexBridge } from "./codex/bridge";
import type { ServerNotification } from "./codex/generated/index";
import type { Model, Thread, Turn } from "./codex/generated/v2/index";
import {
  parseModelList,
  parseThreadList,
  parseThreadRead,
  parseThreadResume,
  parseTurnsList,
} from "./codex/guards";
import { projectForCwd } from "./projects";
import type { StateStore } from "./state/store";

interface CachedThread {
  thread: Thread;
  archived: boolean;
  currentTurnId: string | null;
  liveOutcome?: ThreadOutcome;
}

export class AppProjection extends EventEmitter {
  private readonly threads = new Map<string, CachedThread>();
  private readonly unmaterializedThreads = new Set<string>();
  private readonly activity = new Map<string, ActivityItem>();
  private readonly progress = new Map<string, TurnProgress>();
  private readonly subscribedThreads = new Set<string>();
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
      if (state !== "ready") this.subscribedThreads.clear();
      this.publish({ type: "connection.changed", connection: this.connection });
    });
    bridge.on("notification", (notification: ServerNotification) => {
      void this.onNotification(notification).catch((error: unknown) => {
        this.emit("projectionError", error instanceof Error ? error : new Error(String(error)));
      });
    });
    attention.on("upserted", (request) => {
      this.publish({ type: "attention.upserted", attention: request });
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
      message:
        this.bridge.state === "incompatible"
          ? "Версия Codex CLI не совпадает с protocol contract"
          : this.bridge.state === "ready"
            ? null
            : "Codex app-server недоступен",
      syncedAt: this.syncedAt,
    };
  }

  snapshot(): AppSnapshot {
    return {
      sequence: this.sequence,
      connection: this.connection,
      projects: this.store.snapshot().projects,
      threads: this.sortedThreads(),
      attention: this.attention.list(),
      models: this.models,
      defaultReasoningEffort: this.store.snapshot().defaultReasoningEffort,
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
    const settings = { ...DEFAULT_SESSION_SETTINGS };
    const reasoningEffort = this.store.snapshot().defaultReasoningEffort;
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

  async sync(): Promise<void> {
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.performSync().finally(() => {
      this.syncPromise = undefined;
    });
    return this.syncPromise;
  }

  async readThread(id: string): Promise<ThreadDetail> {
    const local = this.threads.get(id);
    if (local && this.unmaterializedThreads.has(id)) {
      return {
        summary: this.toSummary(local),
        turns: [],
        queuedMessages: this.store.snapshot().messageQueues?.[id] ?? [],
      };
    }
    const result = parseThreadRead(
      await this.bridge.request<unknown>(
        "thread/read",
        { threadId: id, includeTurns: true },
        30_000,
      ),
    );
    const cached = this.threads.get(id) ?? {
      thread: result.thread,
      archived: false,
      currentTurnId: null,
    };
    cached.thread = result.thread;
    this.threads.set(id, cached);
    return {
      summary: this.toSummary(cached),
      turns: result.thread.turns.map((turn) =>
        normalizeTurn(turn, this.progress.get(turnKey(id, turn.id))),
      ),
      queuedMessages: this.store.snapshot().messageQueues?.[id] ?? [],
    };
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

  publishProject(projectId: string): void {
    const project = this.store.snapshot().projects.find((candidate) => candidate.id === projectId);
    if (project) this.publish({ type: "project.upserted", project });
    for (const thread of this.threads.values()) this.publishThread(thread.thread.id);
  }

  publishProjectsReordered(projects: Project[]): void {
    this.publish({ type: "projects.reordered", projects });
  }

  removeProject(projectId: string): void {
    this.publish({ type: "project.removed", projectId });
    for (const thread of this.threads.values()) this.publishThread(thread.thread.id);
  }

  publishQueue(threadId: string, messages: QueuedMessage[]): void {
    this.publish({ type: "queue.changed", threadId, messages });
    this.publishThread(threadId);
  }

  upsertThread(thread: Thread, archived = false): ThreadSummary {
    const previous = this.threads.get(thread.id);
    const cached = {
      thread,
      archived,
      currentTurnId: previous?.currentTurnId ?? activeTurnId(thread),
      liveOutcome: previous?.liveOutcome,
    };
    this.threads.set(thread.id, cached);
    this.publishThread(thread.id);
    return this.toSummary(cached);
  }

  markUnmaterialized(threadId: string): void {
    if (!this.threads.has(threadId)) throw new Error("Thread not found");
    this.unmaterializedThreads.add(threadId);
  }

  isUnmaterialized(threadId: string): boolean {
    return this.unmaterializedThreads.has(threadId);
  }

  markMaterialized(threadId: string): void {
    this.unmaterializedThreads.delete(threadId);
  }

  setCurrentTurn(threadId: string, turnId: string): void {
    const cached = this.threads.get(threadId);
    if (!cached) throw new Error("Thread not found");
    cached.currentTurnId = turnId;
    cached.liveOutcome = undefined;
    cached.thread.status = { type: "active", activeFlags: [] };
    cached.thread.updatedAt = Math.floor(Date.now() / 1_000);
    this.publishThread(threadId);
  }

  private async performSync(): Promise<void> {
    const [listedActive, archived, models] = await Promise.all([
      this.listAllThreads(false),
      this.listAllThreads(true),
      this.listAllModels(),
    ]);
    const active = await Promise.all(listedActive.map((thread) => this.rejoinActiveThread(thread)));
    const incoming = new Set<string>();
    for (const thread of active) {
      incoming.add(thread.id);
      this.threads.set(thread.id, {
        thread,
        archived: false,
        currentTurnId: reconciledTurnId(thread, this.threads.get(thread.id)?.currentTurnId),
      });
      this.hydrateLiveTurn(thread);
    }
    for (const thread of archived) {
      incoming.add(thread.id);
      this.threads.set(thread.id, {
        thread,
        archived: true,
        currentTurnId: reconciledTurnId(thread, this.threads.get(thread.id)?.currentTurnId),
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

  private hydrateLiveTurn(thread: Thread): void {
    for (const turn of thread.turns) {
      if (turn.status === "inProgress") {
        const key = turnKey(thread.id, turn.id);
        if (!this.progress.has(key)) this.progress.set(key, emptyProgress(turn.startedAt));
      }
      for (const rawItem of turn.items) {
        const item = normalizeActivity(rawItem);
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
      if (meta?.outcomeUpdatedAt === updatedAt) continue;
      const page = parseTurnsList(
        await this.bridge.request<unknown>(
          "thread/turns/list",
          {
            threadId: cached.thread.id,
            limit: 1,
            sortDirection: "desc",
            itemsView: "notLoaded",
          },
          30_000,
        ),
      );
      const outcome = normalizeOutcome(page.data[0]?.status);
      await this.store.update((draft) => {
        const item = draft.threadMeta[cached.thread.id] ?? {
          pinned: false,
          lastReadUpdatedAt: updatedAt,
        };
        item.lastOutcome = outcome;
        item.outcomeUpdatedAt = updatedAt;
        draft.threadMeta[cached.thread.id] = item;
      });
    }
  }

  private async onNotification(notification: ServerNotification): Promise<void> {
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
          this.setCurrentTurn(notification.params.threadId, notification.params.turn.id);
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
          await this.store.update((state) => {
            const meta = state.threadMeta[cached.thread.id] ?? {
              pinned: false,
              lastReadUpdatedAt: 0,
            };
            meta.lastOutcome = outcome;
            meta.outcomeUpdatedAt = updatedAt;
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
        const item = normalizeActivity(notification.params.item);
        this.activity.set(
          activityKey(notification.params.threadId, notification.params.turnId, item.id),
          item,
        );
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
    };
    this.activity.set(key, item);
    this.publish({ type: "activity.upserted", threadId, turnId, item });
  }

  private toSummary(cached: CachedThread): ThreadSummary {
    const state = this.store.snapshot();
    const meta = state.threadMeta[cached.thread.id] ?? { pinned: false, lastReadUpdatedAt: 0 };
    const updatedAt = cached.thread.updatedAt * 1_000;
    return {
      id: cached.thread.id,
      projectId: projectForCwd(state.projects, cached.thread.cwd)?.id ?? null,
      title: cached.thread.name?.trim() || cached.thread.preview.trim() || "Без названия",
      preview: cached.thread.preview,
      cwd: cached.thread.cwd,
      state: this.threadState(cached, meta.lastOutcome),
      unread:
        updatedAt > meta.lastReadUpdatedAt &&
        isTerminal(this.threadState(cached, meta.lastOutcome)),
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
    if (cached.thread.status.type === "active" || cached.currentTurnId) return "running";
    if (cached.thread.status.type === "systemError") return "failed";
    return cached.liveOutcome ?? stored ?? "idle";
  }

  private sortedThreads(): ThreadSummary[] {
    return [...this.threads.values()]
      .map((cached) => this.toSummary(cached))
      .sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
  }

  private publishThread(threadId: string): void {
    const summary = this.summary(threadId);
    if (summary) this.publish({ type: "thread.upserted", thread: summary });
  }

  private publish(event: ServerEvent): void {
    this.sequence += 1;
    this.emit("event", this.sequence, event);
  }
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

function normalizeTurn(turn: Turn, liveProgress?: TurnProgress): TurnView {
  const items = turn.items.map(normalizeActivity);
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
    progress: liveProgress ?? emptyProgress(turn.startedAt),
    items,
  };
}

function normalizeActivity(item: Turn["items"][number]): ActivityItem {
  switch (item.type) {
    case "userMessage":
      return {
        type: "userMessage",
        id: item.id,
        status: "completed",
        text: item.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
      };
    case "agentMessage":
      return { type: "agentMessage", id: item.id, status: "completed", text: item.text };
    case "plan":
      return { type: "plan", id: item.id, status: "completed", text: item.text };
    case "reasoning":
      return { type: "reasoning", id: item.id, status: "completed", text: item.summary.join("\n") };
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

function activeTurnId(thread: Thread): string | null {
  for (let index = thread.turns.length - 1; index >= 0; index -= 1) {
    const turn = thread.turns[index];
    if (turn?.status === "inProgress") return turn.id;
  }
  return null;
}

function reconciledTurnId(thread: Thread, previous?: string | null): string | null {
  return activeTurnId(thread) ?? (thread.status.type === "active" ? (previous ?? null) : null);
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

function rank(thread: ThreadSummary): number {
  if (thread.state === "needsAttention") return 0;
  if (thread.state === "running") return 1;
  if (thread.unread && isTerminal(thread.state)) return 2;
  if (thread.pinned) return 3;
  return 4;
}
