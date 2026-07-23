import { EventEmitter } from "node:events";

import type { FastifyBaseLogger } from "fastify";

import type {
  ModelOption,
  ServerEvent,
  SessionSettings,
  ThreadDetail,
  ThreadDraft,
  ThreadGoal,
  ThreadSummary,
  TurnStartResult,
  UpdateThreadDraftRequest,
  UpdateThreadGoalRequest,
  AttentionRequest,
  AttentionResponse,
  ConnectionView,
} from "@codexnest/protocol";

import type { CodexBridge } from "../codex/bridge";
import type { ThreadResumeResponse } from "../codex/generated/v2/index";
import { parseThreadRead, parseThreadStart, parseTurnStart, parseTurnSteer } from "../codex/guards";
import type { CodexManager } from "../codex-management";
import { safeError } from "../logging";
import { MessageQueueNotFoundError } from "../message-queue";
import type { AppProjection } from "../projection";
import { ProjectNotFoundError, ProjectValidationError } from "../projects";
import type { StateStore } from "../state/store";
import type { ThreadTitleGenerator } from "../thread-title";
import { deleteThreadMeta } from "./thread-meta";
import type { AgentBackend, TurnInput } from "./backend";

export interface CodexBackendDeps {
  projection: AppProjection;
  bridge: CodexBridge;
  store: StateStore;
  codexManager?: CodexManager;
  threadTitles?: Pick<ThreadTitleGenerator, "generate">;
  log?: Pick<FastifyBaseLogger, "warn">;
}

export class CodexBackend extends EventEmitter implements AgentBackend {
  readonly agent = "codex" as const;

  private readonly projection: AppProjection;
  private readonly bridge: CodexBridge;
  private readonly store: StateStore;
  private readonly codexManager?: CodexManager;
  private readonly threadTitles?: Pick<ThreadTitleGenerator, "generate">;
  private log?: Pick<FastifyBaseLogger, "warn">;
  private readonly projectThreadCreations = new Map<string, Promise<ThreadSummary>>();

  constructor(deps: CodexBackendDeps) {
    super();
    this.projection = deps.projection;
    this.bridge = deps.bridge;
    this.store = deps.store;
    this.codexManager = deps.codexManager;
    this.threadTitles = deps.threadTitles;
    this.log = deps.log;
    // Forward projection events, dropping the local sequence — the hub assigns the global one.
    this.projection.on("event", (_sequence: number, event: ServerEvent) =>
      this.emit("event", event),
    );
  }

  /** Wires the Fastify logger once the app exists, so background failures log via pino. */
  setLogger(logger: Pick<FastifyBaseLogger, "warn">): void {
    this.log = logger;
  }

  get connection(): ConnectionView {
    return this.projection.connection;
  }

  get models(): ModelOption[] {
    return this.projection.availableModels;
  }

  get newSessionSettings(): SessionSettings {
    return this.projection.newSessionSettings;
  }

  async start(): Promise<void> {
    await this.bridge.start();
  }

  stop(): void {
    this.bridge.stop();
  }

  sync(): Promise<void> {
    return this.projection.sync();
  }

  owns(threadId: string): boolean {
    return this.projection.summary(threadId) !== undefined;
  }

  threads(): ThreadSummary[] {
    return this.projection.snapshot().threads;
  }

  summary(threadId: string): ThreadSummary | undefined {
    return this.projection.summary(threadId);
  }

  readThread(threadId: string, cursor?: string | null): Promise<ThreadDetail> {
    return this.projection.readThread(threadId, cursor ?? null);
  }

  async createThread(
    _projectId: string,
    cwd: string,
    settings: SessionSettings,
  ): Promise<ThreadSummary> {
    const started = parseThreadStart(
      await this.bridge.request<unknown>("thread/start", {
        cwd,
        ...threadSettings(settings),
      }),
    );
    this.projection.upsertThread(started.thread);
    await this.projection.markUnmaterialized(started.thread.id);
    return this.projection.setSettings(started.thread.id, settings);
  }

  startTurn(
    threadId: string,
    input: TurnInput,
    options?: { goal?: boolean },
  ): Promise<TurnStartResult> {
    const release = this.codexManager?.beginTurn();
    return this.startTurnUnlocked(
      threadId,
      input.text,
      input.images,
      input.clientMessageId,
      options?.goal ?? false,
    ).finally(() => release?.());
  }

  async steerTurn(threadId: string, turnId: string, input: TurnInput): Promise<string> {
    this.codexManager?.assertTurnsAllowed();
    const result = parseTurnSteer(
      await this.bridge.request<unknown>("turn/steer", {
        threadId,
        expectedTurnId: turnId,
        clientUserMessageId: input.clientMessageId,
        input: messageInput(input.text, input.images),
      }),
    );
    if (this.projection.summary(threadId)) {
      await this.projection.setCurrentTurn(threadId, result.turnId);
    }
    if (input.clientMessageId) {
      this.projection.recordUserMessage(
        threadId,
        result.turnId,
        input.clientMessageId,
        input.text,
        input.images,
      );
    }
    return result.turnId;
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.bridge.request("turn/interrupt", { threadId, turnId });
  }

  async renameThread(threadId: string, name: string): Promise<void> {
    await this.bridge.request("thread/name/set", { threadId, name });
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.bridge.request("thread/delete", { threadId });
    await deleteThreadMeta(this.store, threadId);
  }

  async setArchived(threadId: string, archived: boolean): Promise<void> {
    await this.bridge.request(archived ? "thread/archive" : "thread/unarchive", { threadId });
  }

  setSettings(threadId: string, settings: SessionSettings): Promise<ThreadSummary> {
    return this.projection.setSettings(threadId, settings);
  }

  setDraft(threadId: string, value: UpdateThreadDraftRequest): Promise<ThreadDraft | null> {
    return this.projection.setDraft(threadId, value);
  }

  markRead(threadId: string, observedUpdatedAt: number): Promise<void> {
    return this.projection.markRead(threadId, observedUpdatedAt);
  }

  markViewed(threadId: string, observedUpdatedAt: number): Promise<void> {
    return this.projection.markViewed(threadId, observedUpdatedAt);
  }

  setPinned(threadId: string, pinned: boolean): Promise<void> {
    return this.projection.setPinned(threadId, pinned);
  }

  recordAttentionResponse(request: AttentionRequest, response: AttentionResponse): Promise<void> {
    return this.projection.recordAttentionResponse(request, response);
  }

  turnsPaused(): boolean {
    return this.codexManager?.maintenanceActive ?? false;
  }

  currentTurnId(threadId: string): string | null {
    return this.projection.summary(threadId)?.currentTurnId ?? null;
  }

  async wasDelivered(threadId: string, messageId: string): Promise<boolean> {
    const result = parseThreadRead(
      await this.bridge.request<unknown>("thread/read", { threadId, includeTurns: true }, 30_000),
    );
    return result.thread.turns.some((turn) =>
      turn.items.some((item) => item.type === "userMessage" && item.clientId === messageId),
    );
  }

  /** Sets the codex-global default reasoning effort applied to new sessions. */
  setDefaultReasoningEffort(reasoningEffort?: string): Promise<void> {
    return this.projection.setDefaultReasoningEffort(reasoningEffort);
  }

  // --- Codex-specific operations (not part of the AgentBackend interface) ---

  getOrCreateProjectThread(projectId: string): Promise<ThreadSummary> {
    const current = this.projectThreadCreations.get(projectId);
    if (current) return current;
    const request = (async () => {
      const existing = await this.findReusableProjectThread(projectId);
      if (existing) return existing;
      this.codexManager?.assertTurnsAllowed();
      const project = this.store
        .snapshot()
        .projects.find((candidate) => candidate.id === projectId);
      if (!project) throw new ProjectNotFoundError("Project not found");
      const settings = this.projection.newSessionSettings;
      const started = parseThreadStart(
        await this.bridge.request<unknown>("thread/start", {
          cwd: project.path,
          ...threadSettings(settings),
        }),
      );
      this.projection.upsertThread(started.thread);
      await this.projection.markUnmaterialized(started.thread.id);
      return this.projection.setSettings(started.thread.id, settings);
    })().finally(() => {
      if (this.projectThreadCreations.get(projectId) === request) {
        this.projectThreadCreations.delete(projectId);
      }
    });
    this.projectThreadCreations.set(projectId, request);
    return request;
  }

  async readGoal(threadId: string): Promise<ThreadGoal | null> {
    const response = await this.bridge.request<unknown>("thread/goal/get", { threadId });
    if (!isRecord(response) || !(response.goal === null || isThreadGoal(response.goal))) {
      throw new ProjectValidationError("Invalid thread goal response");
    }
    return response.goal;
  }

  async setGoal(threadId: string, patch: UpdateThreadGoalRequest): Promise<ThreadGoal> {
    const response = await this.bridge.request<unknown>("thread/goal/set", {
      threadId,
      ...patch,
    });
    if (!isRecord(response) || !isThreadGoal(response.goal)) {
      throw new ProjectValidationError("Invalid thread goal response");
    }
    return response.goal;
  }

  async clearGoal(threadId: string): Promise<void> {
    await this.bridge.request("thread/goal/clear", { threadId });
  }

  private async findReusableProjectThread(projectId: string): Promise<ThreadSummary | null> {
    for (const candidate of this.projection.emptyThreadCandidates(projectId)) {
      if (candidate.knownUnmaterialized) return candidate.thread;
      const detail = await this.projection.readThread(candidate.thread.id);
      if (detail.turns.length === 0 && detail.queuedMessages.length === 0) {
        await this.projection.markUnmaterialized(candidate.thread.id);
        return this.projection.summary(candidate.thread.id) ?? candidate.thread;
      }
      await this.projection.markMaterialized(candidate.thread.id);
    }
    return null;
  }

  private async startTurnUnlocked(
    threadId: string,
    input: string,
    images: string[],
    clientMessageId: string | null,
    goal = false,
  ): Promise<TurnStartResult> {
    const { projection, bridge } = this;
    let summary = projection.summary(threadId);
    if (!summary) throw new MessageQueueNotFoundError("Thread not found");
    const shouldGenerateTitle =
      projection.isUnmaterialized(threadId) && !projection.hasExplicitName(threadId);
    if (goal) {
      if (summary.settings.collaborationMode === "plan") {
        summary = await projection.setSettings(threadId, {
          ...summary.settings,
          collaborationMode: "default",
        });
      }
      await this.setGoal(threadId, { objective: input.trim(), status: "paused" });
    }
    let turn;
    try {
      if (!projection.isUnmaterialized(threadId)) {
        await bridge.request<ThreadResumeResponse>(
          "thread/resume",
          {
            threadId,
            cwd: summary.cwd,
            excludeTurns: true,
            ...threadSettings(summary.settings),
          },
          30_000,
        );
      }
      turn = parseTurnStart(
        await bridge.request<unknown>("turn/start", {
          threadId,
          clientUserMessageId: clientMessageId,
          input: messageInput(input, images),
          ...turnSettings(summary.settings, projection.availableModels),
        }),
      );
    } catch (error) {
      if (goal) await this.clearGoal(threadId).catch(() => undefined);
      throw error;
    }
    await projection.markMaterialized(threadId);
    await projection.setCurrentTurn(threadId, turn.turn.id);
    if (clientMessageId) {
      projection.recordUserMessage(threadId, turn.turn.id, clientMessageId, input, images);
    }
    if (shouldGenerateTitle) this.scheduleThreadTitle(threadId, input, summary);
    if (!goal) return { turnId: turn.turn.id };
    try {
      await this.setGoal(threadId, { status: "active" });
      return { turnId: turn.turn.id };
    } catch {
      return {
        turnId: turn.turn.id,
        goalWarning: "Первый ход начат, но цель осталась на паузе. Продолжите её вручную.",
      };
    }
  }

  private scheduleThreadTitle(threadId: string, input: string, summary: ThreadSummary): void {
    const { threadTitles, projection, bridge } = this;
    if (!threadTitles || !input.trim() || projection.hasExplicitName(threadId)) return;
    const model = effectiveModel(summary.settings, projection.availableModels);
    void threadTitles
      .generate(input, {
        cwd: summary.cwd,
        model: model?.id,
        effort: model?.reasoningEfforts[0]?.value,
      })
      .then(async (name) => {
        if (projection.hasExplicitName(threadId)) return;
        await bridge.request("thread/name/set", { threadId, name });
      })
      .catch((error: unknown) => {
        this.log?.warn({ err: safeError(error), threadId }, "Failed to generate thread title");
      });
  }
}

export function threadSettings(settings?: SessionSettings): Record<string, unknown> {
  if (!settings) return {};
  return compact({
    model: settings.model,
    serviceTier: settings.serviceTier,
    personality: settings.personality,
  });
}

export function turnSettings(
  settings: SessionSettings,
  models: ModelOption[],
): Record<string, unknown> {
  const model = effectiveModel(settings, models);
  if (!model) throw new ProjectValidationError("No model is available for collaboration mode");
  const reasoningEffort =
    settings.reasoningEffort ??
    model.reasoningEfforts.find((option) => option.isDefault)?.value ??
    null;
  return compact({
    model: settings.model,
    serviceTier: settings.serviceTier,
    effort: settings.reasoningEffort,
    personality: settings.personality,
    collaborationMode: {
      mode: settings.collaborationMode,
      settings: {
        model: model.id,
        reasoning_effort: reasoningEffort,
        developer_instructions: null,
      },
    },
  });
}

export function messageInput(
  text: string,
  images: string[],
): Array<{ type: "text"; text: string; text_elements: [] } | { type: "image"; url: string }> {
  const result: Array<
    { type: "text"; text: string; text_elements: [] } | { type: "image"; url: string }
  > = [];
  if (text.trim()) result.push({ type: "text", text: text.trim(), text_elements: [] });
  result.push(...images.map((url) => ({ type: "image" as const, url })));
  return result;
}

export function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}

export function effectiveModel(
  settings: SessionSettings,
  models: ModelOption[],
): ModelOption | undefined {
  if (settings.model) return models.find((model) => model.id === settings.model);
  return models.find((model) => model.isDefault) ?? models[0];
}

function isThreadGoal(value: unknown): value is ThreadGoal {
  return (
    isRecord(value) &&
    typeof value.threadId === "string" &&
    typeof value.objective === "string" &&
    ["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"].includes(
      String(value.status),
    ) &&
    (value.tokenBudget === null || typeof value.tokenBudget === "number") &&
    typeof value.tokensUsed === "number" &&
    typeof value.timeUsedSeconds === "number" &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
