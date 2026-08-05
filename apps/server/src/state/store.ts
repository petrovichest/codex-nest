import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, normalize, relative } from "node:path";

import type {
  ActivityItem,
  Project,
  QueuedMessage,
  SessionSettings,
  TaskDefaults,
  ThreadDraft,
  ThreadOutcome,
  UiLanguage,
  VoiceTranscriptionMode,
  VoiceTranscriptionStatus,
} from "@codexnest/protocol";

export type TimelineArtifact = Extract<
  ActivityItem,
  { type: "userInputResponse" | "planChecklist" | "orchestrationNotice" }
>;

export type ManagedTeamTaskStatus = "queued" | "starting" | "running" | ThreadOutcome;

export type ManagedTeamTaskAccessMode = "readOnly" | "isolatedWrite" | "sharedWrite";

export interface ManagedTeamTaskAccessState {
  mode: ManagedTeamTaskAccessMode;
  writePaths?: string[];
  network?: boolean;
}

export type ManagedTeamTaskResultOutcome = "success" | "partial" | "blocked" | "failed";

export interface ManagedTeamTaskResultCheck {
  name: string;
  outcome: "passed" | "failed" | "notRun";
  details?: string;
}

export interface ManagedTeamTaskResultArtifact {
  label: string;
  path?: string;
  url?: string;
}

export type ManagedTeamTaskBudgetReason = "timeout" | "tokenBudget";

export type ManagedTeamTaskWorkspaceLifecycle =
  | "creating"
  | "ready"
  | "integrating"
  | "integrated"
  | "discarding"
  | "discarded"
  | "conflicted"
  | "recoveryRequired";

export type ManagedTeamTaskWorkspaceFileState =
  | {
      type: "file";
      mode: number;
      digest: string;
    }
  | {
      type: "symlink";
      target: string;
    };

export interface ManagedTeamTaskWorkspaceState {
  lifecycle: ManagedTeamTaskWorkspaceLifecycle;
  repositoryRoot: string;
  gitCommonDir: string;
  worktreePath: string;
  head: string;
  baseline: Record<string, ManagedTeamTaskWorkspaceFileState>;
  createdAt: number;
  updatedAt: number;
  changedPaths?: string[];
  conflictPaths?: string[];
  error?: string;
}

export interface ManagedTeamTaskResultFields {
  outcome?: ManagedTeamTaskResultOutcome;
  checks?: ManagedTeamTaskResultCheck[];
  risks?: string[];
  artifacts?: ManagedTeamTaskResultArtifact[];
}

export interface ManagedTeamTaskResult extends ManagedTeamTaskResultFields {
  summary: string;
  details?: string;
  source: "submitted" | "final_answer" | "agent_message" | "status";
}

export interface ManagedTeamTaskResultCandidate extends ManagedTeamTaskResultFields {
  summary: string;
  details?: string;
  submittedAt: number;
  callId: string;
}

export interface ManagedTeamTaskState {
  id: string;
  childThreadId: string;
  childThreadSource?: string;
  childTurnId?: string;
  startMessageId?: string;
  title: string;
  prompt: string;
  status: ManagedTeamTaskStatus;
  dependsOn?: string[];
  predecessorTaskId?: string;
  access?: ManagedTeamTaskAccessState;
  resolvedModel?: string;
  resolvedReasoningEffort?: string | null;
  resolvedServiceTier?: string | null;
  // Retained only so completed tasks from releases with hard budgets remain readable.
  timeoutMinutes?: number;
  tokenBudget?: number;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  failureReason?: string;
  budgetReason?: ManagedTeamTaskBudgetReason;
  workspace?: ManagedTeamTaskWorkspaceState;
  createdAt: number;
  startedAt?: number;
  lastActivityAt: number;
  recoveryMisses?: number;
  expectedWakeAt?: number;
  lastWatchdogAt?: number;
  watchdog?: {
    status: "pending" | "claimed";
    triggeredAt: number;
    claimId?: string;
    markerId?: string;
    dispatchStartedAt?: number;
    contextHash?: string;
  };
  terminalTurnId?: string;
  resultCandidate?: ManagedTeamTaskResultCandidate;
  result?: ManagedTeamTaskResult;
  delivery?: {
    status: "claimed" | "delivered";
    claimId: string;
    parentTurnId?: string;
    markerId?: string;
    dispatchStartedAt?: number;
    contextHash?: string;
  };
}

export interface TeamOrchestrationState {
  tasks: Record<string, ManagedTeamTaskState>;
}

export interface TeamToolOperationState {
  threadId: string;
  turnId: string;
  callId: string;
  tool:
    | "spawn_task"
    | "followup_task"
    | "steer_task"
    | "cancel_task"
    | "submit_result"
    | "integrate_task"
    | "discard_task_changes";
  argumentsHash: string;
  status: "prepared" | "applied";
  createdAt: number;
  updatedAt: number;
  taskId?: string;
  childThreadSource?: string;
  response?: {
    contentItems: Array<
      { type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string }
    >;
    success: boolean;
  };
}

export interface ThreadMetaState {
  pinned: boolean;
  lastReadUpdatedAt: number;
  lastViewedUpdatedAt?: number;
  lastOutcome?: ThreadOutcome;
  outcomeUpdatedAt?: number;
  settings?: SessionSettings;
  inheritCodexSettings?: boolean;
  awaitingPlanResponse?: boolean;
  timelineArtifacts?: Record<string, TimelineArtifact[]>;
  teamOrchestration?: TeamOrchestrationState;
  managedTeamToolsAvailable?: true;
  managedParent?: {
    parentThreadId: string;
    taskId: string;
  };
  unmaterialized?: boolean;
  draft?: ThreadDraft;
}

export interface DeviceState {
  fcmToken: string;
  updatedAt: number;
}

export interface TranscriptionTimingSampleState {
  audioDurationMs: number;
  processingMs: number;
}

export interface VoiceTranscriptionState {
  id: string;
  threadId: string;
  mode: VoiceTranscriptionMode;
  status: VoiceTranscriptionStatus;
  createdAt: number;
  startedAt: number | null;
  audioDurationMs: number;
  estimatedTotalSeconds: number | null;
  error: string | null;
  contentType: "audio/webm" | "audio/mp4";
  audioFile?: string;
  audioBytes: number;
  selectionStart: number;
  selectionEnd: number;
  timingProfile?: string;
  transcript?: string;
  attempts?: number;
  nextAttemptAt?: number;
}

export interface VoiceReceiptState {
  threadId: string;
  createdAt: number;
}

export interface MessageReceiptState {
  threadId: string;
  turnId: string | null;
  contentHash: string;
  createdAt: number;
}

export interface CodexNestState {
  schemaVersion: 1;
  auth: { tokenSha256?: string };
  projects: Project[];
  dismissedProjectPaths?: string[];
  threadMeta: Record<string, ThreadMetaState>;
  devices: Record<string, DeviceState>;
  transcriptionTimings?: Record<string, TranscriptionTimingSampleState[]>;
  uiLanguage: UiLanguage;
  defaultReasoningEffort?: string;
  taskDefaults?: TaskDefaults;
  messageQueues?: Record<string, QueuedMessage[]>;
  messageReceipts?: Record<string, MessageReceiptState>;
  teamToolOperations?: Record<string, TeamToolOperationState>;
  voiceTranscriptions?: Record<string, VoiceTranscriptionState>;
  voiceReceipts?: Record<string, VoiceReceiptState>;
}

export function emptyState(): CodexNestState {
  return {
    schemaVersion: 1,
    auth: {},
    projects: [],
    threadMeta: {},
    devices: {},
    uiLanguage: "en",
    messageQueues: {},
    messageReceipts: {},
    teamToolOperations: {},
    voiceTranscriptions: {},
    voiceReceipts: {},
  };
}

export class StateStore extends EventEmitter {
  private state = emptyState();
  private writeQueue: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(public readonly path: string) {
    super();
  }

  async load(): Promise<CodexNestState> {
    try {
      const serialized = await readFile(this.path, "utf8");
      const parsed: unknown = JSON.parse(serialized);
      this.state = validateState(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = emptyState();
      await this.persist(this.state);
    }
    this.loaded = true;
    return this.snapshot();
  }

  snapshot(): CodexNestState {
    if (!this.loaded) throw new Error("StateStore.load() must be called first");
    return structuredClone(this.state);
  }

  update(mutator: (draft: CodexNestState) => void | Promise<void>): Promise<CodexNestState> {
    const task = this.writeQueue.then(async () => {
      if (!this.loaded) throw new Error("StateStore.load() must be called first");
      const draft = structuredClone(this.state);
      const originalVerifier = this.state.auth.tokenSha256;
      await mutator(draft);
      if (draft.auth.tokenSha256 === originalVerifier) {
        try {
          const disk = validateState(JSON.parse(await readFile(this.path, "utf8")) as unknown);
          if (disk.auth.tokenSha256 !== originalVerifier) draft.auth = structuredClone(disk.auth);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      const validated = validateState(draft);
      await this.persist(validated);
      const verifierChanged = validated.auth.tokenSha256 !== this.state.auth.tokenSha256;
      this.state = validated;
      if (verifierChanged) this.emit("authRotated");
    });
    this.writeQueue = task.catch(() => undefined);
    return task.then(() => this.snapshot());
  }

  async flushed(): Promise<void> {
    await this.writeQueue;
  }

  async checkpoint(): Promise<void> {
    const task = this.writeQueue.then(async () => {
      if (!this.loaded) throw new Error("StateStore.load() must be called first");
      await this.persist(this.state);
    });
    this.writeQueue = task.catch(() => undefined);
    await task;
  }

  async refreshAuthVerifier(): Promise<boolean> {
    await this.writeQueue;
    const parsed = validateState(JSON.parse(await readFile(this.path, "utf8")) as unknown);
    if (parsed.auth.tokenSha256 === this.state.auth.tokenSha256) return false;
    this.state.auth = structuredClone(parsed.auth);
    this.emit("authRotated");
    return true;
  }

  private async persist(next: CodexNestState): Promise<void> {
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, this.path);
      const target = await open(this.path, "r+");
      try {
        await target.chmod(0o600);
        await target.sync();
      } finally {
        await target.close();
      }
      const directory = await open(parent, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

function validateState(value: unknown): CodexNestState {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Unsupported or corrupt CodexNest state schema");
  }
  if (!isRecord(value.auth) || !Array.isArray(value.projects)) {
    throw new Error("Corrupt CodexNest state");
  }
  if (
    value.dismissedProjectPaths !== undefined &&
    (!Array.isArray(value.dismissedProjectPaths) ||
      value.dismissedProjectPaths.some(
        (path) => typeof path !== "string" || !path.trim() || !isAbsolute(path),
      ))
  ) {
    throw new Error("Corrupt dismissed project paths in CodexNest state");
  }
  if (!isRecord(value.threadMeta) || !isRecord(value.devices)) {
    throw new Error("Corrupt CodexNest state");
  }
  const transcriptionTimings = normalizeTranscriptionTimings(value.transcriptionTimings);
  if (value.messageQueues !== undefined && !isRecord(value.messageQueues)) {
    throw new Error("Corrupt message queues in CodexNest state");
  }
  if (value.messageReceipts !== undefined && !isRecord(value.messageReceipts)) {
    throw new Error("Corrupt message receipts in CodexNest state");
  }
  if (value.teamToolOperations !== undefined && !isRecord(value.teamToolOperations)) {
    throw new Error("Corrupt Team tool operations in CodexNest state");
  }
  if (value.voiceTranscriptions !== undefined && !isRecord(value.voiceTranscriptions)) {
    throw new Error("Corrupt voice transcriptions in CodexNest state");
  }
  if (value.voiceReceipts !== undefined && !isRecord(value.voiceReceipts)) {
    throw new Error("Corrupt voice receipts in CodexNest state");
  }
  if (
    value.defaultReasoningEffort !== undefined &&
    (typeof value.defaultReasoningEffort !== "string" || !value.defaultReasoningEffort.trim())
  ) {
    throw new Error("Corrupt default reasoning effort in CodexNest state");
  }
  if (value.taskDefaults !== undefined && !isTaskDefaults(value.taskDefaults)) {
    throw new Error("Corrupt task defaults in CodexNest state");
  }
  if (
    value.uiLanguage !== undefined &&
    (typeof value.uiLanguage !== "string" || !["en", "ru"].includes(value.uiLanguage))
  ) {
    throw new Error("Corrupt UI language in CodexNest state");
  }
  for (const project of value.projects) {
    if (!isProject(project)) throw new Error("Corrupt project in CodexNest state");
  }
  for (const meta of Object.values(value.threadMeta)) {
    if (isRecord(meta) && isLegacyTeamOrchestrationState(meta.teamOrchestration)) {
      delete meta.teamOrchestration;
    }
    if (isRecord(meta) && meta.teamToolsVersion === 2) {
      meta.managedTeamToolsAvailable = true;
      delete meta.teamToolsVersion;
    }
    if (isRecord(meta) && meta.teamToolsVersion === 1) {
      const orchestration = meta.teamOrchestration;
      if (
        isRecord(orchestration) &&
        isRecord(orchestration.tasks) &&
        Object.keys(orchestration.tasks).length
      ) {
        throw new Error("Unsupported unfinished legacy Team orchestration in CodexNest state");
      }
      delete meta.teamToolsVersion;
      delete meta.teamOrchestration;
      if (isRecord(meta.settings) && meta.settings.collaborationMode === "team") {
        meta.settings.collaborationMode = "default";
      }
    }
    if (isRecord(meta)) retireActiveManagedTaskBudgets(meta.teamOrchestration);
    if (
      !isRecord(meta) ||
      typeof meta.pinned !== "boolean" ||
      typeof meta.lastReadUpdatedAt !== "number" ||
      (meta.lastViewedUpdatedAt !== undefined && typeof meta.lastViewedUpdatedAt !== "number") ||
      (meta.lastOutcome !== undefined &&
        !["completed", "failed", "interrupted"].includes(String(meta.lastOutcome))) ||
      (meta.outcomeUpdatedAt !== undefined && typeof meta.outcomeUpdatedAt !== "number") ||
      (meta.settings !== undefined && !isSessionSettings(meta.settings)) ||
      (meta.inheritCodexSettings !== undefined && typeof meta.inheritCodexSettings !== "boolean") ||
      (meta.awaitingPlanResponse !== undefined && typeof meta.awaitingPlanResponse !== "boolean") ||
      (meta.timelineArtifacts !== undefined && !isTimelineArtifacts(meta.timelineArtifacts)) ||
      (meta.teamOrchestration !== undefined && !isTeamOrchestrationState(meta.teamOrchestration)) ||
      meta.teamToolsVersion !== undefined ||
      (meta.managedTeamToolsAvailable !== undefined && meta.managedTeamToolsAvailable !== true) ||
      (meta.managedParent !== undefined && !isManagedParent(meta.managedParent)) ||
      (meta.unmaterialized !== undefined && typeof meta.unmaterialized !== "boolean") ||
      (meta.draft !== undefined && !isThreadDraft(meta.draft))
    ) {
      throw new Error("Corrupt thread metadata in CodexNest state");
    }
  }
  for (const device of Object.values(value.devices)) {
    if (
      !isRecord(device) ||
      typeof device.fcmToken !== "string" ||
      typeof device.updatedAt !== "number"
    ) {
      throw new Error("Corrupt device registration in CodexNest state");
    }
  }
  for (const [threadId, messages] of Object.entries(value.messageQueues ?? {})) {
    if (
      !Array.isArray(messages) ||
      messages.some((message) => !isQueuedMessage(message, threadId))
    ) {
      throw new Error("Corrupt queued message in CodexNest state");
    }
  }
  for (const receipt of Object.values(value.messageReceipts ?? {})) {
    if (
      !isRecord(receipt) ||
      typeof receipt.threadId !== "string" ||
      (receipt.turnId !== null && typeof receipt.turnId !== "string") ||
      typeof receipt.contentHash !== "string" ||
      !/^[a-f\d]{64}$/iu.test(receipt.contentHash) ||
      typeof receipt.createdAt !== "number"
    ) {
      throw new Error("Corrupt message receipt");
    }
  }
  for (const operation of Object.values(value.teamToolOperations ?? {})) {
    if (!isTeamToolOperation(operation)) {
      throw new Error("Corrupt Team tool operation");
    }
  }
  for (const [threadId, job] of Object.entries(value.voiceTranscriptions ?? {})) {
    if (!isVoiceTranscription(job, threadId)) {
      throw new Error("Corrupt voice transcription in CodexNest state");
    }
  }
  for (const receipt of Object.values(value.voiceReceipts ?? {})) {
    if (
      !isRecord(receipt) ||
      typeof receipt.threadId !== "string" ||
      typeof receipt.createdAt !== "number"
    ) {
      throw new Error("Corrupt voice receipt");
    }
  }
  const verifier = value.auth.tokenSha256;
  if (
    verifier !== undefined &&
    (typeof verifier !== "string" || !/^[a-f\d]{64}$/i.test(verifier))
  ) {
    throw new Error("Corrupt token verifier in CodexNest state");
  }
  const state = value as unknown as CodexNestState;
  return {
    ...state,
    ...(transcriptionTimings === undefined ? {} : { transcriptionTimings }),
    ...(value.uiLanguage === undefined ? { uiLanguage: "ru" as const } : {}),
  };
}

function retireActiveManagedTaskBudgets(value: unknown): void {
  if (!isRecord(value) || !isRecord(value.tasks)) return;
  for (const task of Object.values(value.tasks)) {
    if (!isRecord(task) || !["queued", "starting", "running"].includes(String(task.status))) {
      continue;
    }
    delete task.timeoutMinutes;
    delete task.tokenBudget;
    if (["timeout", "tokenBudget"].includes(String(task.budgetReason))) {
      delete task.budgetReason;
    }
  }
}

function normalizeTranscriptionTimings(
  value: unknown,
): Record<string, TranscriptionTimingSampleState[]> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Corrupt transcription timings in CodexNest state");

  const normalized: Record<string, TranscriptionTimingSampleState[]> = {};
  for (const [profile, samples] of Object.entries(value)) {
    if (!Array.isArray(samples) || samples.length > 20) {
      throw new Error("Corrupt transcription timings in CodexNest state");
    }
    normalized[profile] = samples.flatMap((sample) => {
      if (typeof sample === "number" && Number.isFinite(sample) && sample > 0) return [];
      if (
        !isRecord(sample) ||
        typeof sample.audioDurationMs !== "number" ||
        !Number.isFinite(sample.audioDurationMs) ||
        sample.audioDurationMs <= 0 ||
        typeof sample.processingMs !== "number" ||
        !Number.isFinite(sample.processingMs) ||
        sample.processingMs <= 0
      ) {
        throw new Error("Corrupt transcription timings in CodexNest state");
      }
      return [
        {
          audioDurationMs: sample.audioDurationMs,
          processingMs: sample.processingMs,
        },
      ];
    });
  }
  return normalized;
}

function isTimelineArtifacts(value: unknown): value is Record<string, TimelineArtifact[]> {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (items) => Array.isArray(items) && items.every(isTimelineArtifact),
  );
}

function isTimelineArtifact(value: unknown): value is TimelineArtifact {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.timestamp !== "number" ||
    (value.afterItemId !== null && typeof value.afterItemId !== "string")
  ) {
    return false;
  }
  if (value.type === "userInputResponse") {
    return (
      value.status === "completed" &&
      Array.isArray(value.entries) &&
      value.entries.every(
        (entry) =>
          isRecord(entry) &&
          typeof entry.header === "string" &&
          typeof entry.question === "string" &&
          Array.isArray(entry.answers) &&
          entry.answers.every((answer) => typeof answer === "string"),
      )
    );
  }
  if (value.type === "planChecklist") {
    return (
      ["inProgress", "completed", "failed"].includes(String(value.status)) &&
      (value.explanation === null || typeof value.explanation === "string") &&
      Array.isArray(value.steps) &&
      value.steps.every(
        (step) =>
          isRecord(step) &&
          typeof step.step === "string" &&
          ["pending", "inProgress", "completed"].includes(String(step.status)),
      )
    );
  }
  if (value.type === "orchestrationNotice") {
    return (
      value.status === "completed" &&
      Array.isArray(value.agents) &&
      value.agents.length > 0 &&
      value.agents.every(
        (agent) =>
          isRecord(agent) &&
          typeof agent.threadId === "string" &&
          typeof agent.title === "string" &&
          (agent.nickname === null || typeof agent.nickname === "string") &&
          ["completed", "failed", "interrupted"].includes(String(agent.outcome)),
      )
    );
  }
  return false;
}

function isTeamOrchestrationState(value: unknown): value is TeamOrchestrationState {
  if (!isRecord(value) || !isRecord(value.tasks)) return false;
  if (
    !Object.entries(value.tasks).every(
      ([taskId, task]) => isManagedTeamTaskState(task) && task.id === taskId,
    )
  ) {
    return false;
  }

  const tasks = value.tasks as Record<string, ManagedTeamTaskState>;
  for (const task of Object.values(tasks)) {
    const references = [
      ...(task.dependsOn ?? []),
      ...(task.predecessorTaskId ? [task.predecessorTaskId] : []),
    ];
    if (references.some((taskId) => taskId === task.id || tasks[taskId] === undefined))
      return false;
    if (task.predecessorTaskId && tasks[task.predecessorTaskId]!.createdAt > task.createdAt) {
      return false;
    }
  }
  return !hasManagedTaskReferenceCycle(tasks);
}

function isManagedTeamTaskState(value: unknown): value is ManagedTeamTaskState {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.childThreadId !== "string" ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    typeof value.prompt !== "string" ||
    !value.prompt.trim() ||
    !["queued", "starting", "running", "completed", "failed", "interrupted"].includes(
      String(value.status),
    ) ||
    typeof value.createdAt !== "number" ||
    typeof value.lastActivityAt !== "number" ||
    (value.startedAt !== undefined && typeof value.startedAt !== "number") ||
    (value.expectedWakeAt !== undefined &&
      (typeof value.expectedWakeAt !== "number" || !Number.isFinite(value.expectedWakeAt))) ||
    (value.recoveryMisses !== undefined &&
      (typeof value.recoveryMisses !== "number" ||
        !Number.isInteger(value.recoveryMisses) ||
        value.recoveryMisses < 0)) ||
    (value.lastWatchdogAt !== undefined && typeof value.lastWatchdogAt !== "number") ||
    (value.watchdog !== undefined && !isManagedWatchdog(value.watchdog)) ||
    (value.childThreadSource !== undefined && typeof value.childThreadSource !== "string") ||
    (value.childTurnId !== undefined && typeof value.childTurnId !== "string") ||
    (value.startMessageId !== undefined && typeof value.startMessageId !== "string") ||
    (value.terminalTurnId !== undefined && typeof value.terminalTurnId !== "string") ||
    (value.dependsOn !== undefined && !isManagedTaskReferences(value.dependsOn)) ||
    (value.predecessorTaskId !== undefined && !isBoundedString(value.predecessorTaskId, 200)) ||
    (value.access !== undefined && !isManagedTaskAccess(value.access)) ||
    (value.resolvedModel !== undefined && !isBoundedString(value.resolvedModel, 200)) ||
    (value.resolvedReasoningEffort !== undefined &&
      value.resolvedReasoningEffort !== null &&
      !isBoundedString(value.resolvedReasoningEffort, 200)) ||
    (value.resolvedServiceTier !== undefined &&
      value.resolvedServiceTier !== null &&
      !isBoundedString(value.resolvedServiceTier, 200)) ||
    (value.timeoutMinutes !== undefined &&
      (typeof value.timeoutMinutes !== "number" ||
        !Number.isSafeInteger(value.timeoutMinutes) ||
        value.timeoutMinutes < 1 ||
        value.timeoutMinutes > 1_440)) ||
    (value.tokenBudget !== undefined &&
      (typeof value.tokenBudget !== "number" ||
        !Number.isSafeInteger(value.tokenBudget) ||
        value.tokenBudget < 1 ||
        value.tokenBudget > 10_000_000)) ||
    (value.tokensUsed !== undefined &&
      (typeof value.tokensUsed !== "number" ||
        !Number.isSafeInteger(value.tokensUsed) ||
        value.tokensUsed < 0)) ||
    (value.timeUsedSeconds !== undefined && !isNonNegativeFiniteNumber(value.timeUsedSeconds)) ||
    (value.failureReason !== undefined && !isBoundedString(value.failureReason, 2_000)) ||
    (value.budgetReason !== undefined &&
      !["timeout", "tokenBudget"].includes(String(value.budgetReason))) ||
    (value.workspace !== undefined && !isManagedTaskWorkspace(value.workspace)) ||
    (value.resultCandidate !== undefined && !isManagedResultCandidate(value.resultCandidate)) ||
    (value.result !== undefined && !isManagedResult(value.result))
  ) {
    return false;
  }
  return value.delivery === undefined || isManagedDelivery(value.delivery);
}

function isManagedDelivery(value: unknown): boolean {
  return (
    isRecord(value) &&
    ["claimed", "delivered"].includes(String(value.status)) &&
    typeof value.claimId === "string" &&
    (value.parentTurnId === undefined || typeof value.parentTurnId === "string") &&
    (value.markerId === undefined || typeof value.markerId === "string") &&
    (value.dispatchStartedAt === undefined || typeof value.dispatchStartedAt === "number") &&
    (value.contextHash === undefined ||
      (typeof value.contextHash === "string" && /^[a-f\d]{64}$/iu.test(value.contextHash)))
  );
}

function isManagedTaskReferences(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 50 &&
    value.every((taskId) => isBoundedString(taskId, 200)) &&
    new Set(value).size === value.length
  );
}

function hasManagedTaskReferenceCycle(tasks: Record<string, ManagedTeamTaskState>): boolean {
  const states = new Map<string, "visiting" | "visited">();
  for (const taskId of Object.keys(tasks)) {
    if (states.has(taskId)) continue;
    const stack: Array<{ taskId: string; references: string[]; index: number }> = [
      { taskId, references: managedTaskReferences(tasks[taskId]!), index: 0 },
    ];
    states.set(taskId, "visiting");
    while (stack.length) {
      const current = stack.at(-1)!;
      const reference = current.references[current.index++];
      if (reference === undefined) {
        states.set(current.taskId, "visited");
        stack.pop();
        continue;
      }
      if (states.get(reference) === "visiting") return true;
      if (states.get(reference) === "visited") continue;
      states.set(reference, "visiting");
      stack.push({
        taskId: reference,
        references: managedTaskReferences(tasks[reference]!),
        index: 0,
      });
    }
  }
  return false;
}

function managedTaskReferences(task: ManagedTeamTaskState): string[] {
  return [...(task.dependsOn ?? []), ...(task.predecessorTaskId ? [task.predecessorTaskId] : [])];
}

function isManagedTaskAccess(value: unknown): value is ManagedTeamTaskAccessState {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["mode", "writePaths", "network"]) ||
    !["readOnly", "isolatedWrite", "sharedWrite"].includes(String(value.mode)) ||
    (value.network !== undefined && typeof value.network !== "boolean")
  ) {
    return false;
  }
  const writePaths = value.writePaths;
  if (
    writePaths !== undefined &&
    (!isSafeRelativePathList(writePaths, 100) || !writePaths.every(isSafeManagedWritePath))
  )
    return false;
  if (value.mode === "readOnly") return writePaths === undefined || writePaths.length === 0;
  return Array.isArray(writePaths) && writePaths.length > 0;
}

function isManagedTaskWorkspace(value: unknown): value is ManagedTeamTaskWorkspaceState {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "lifecycle",
      "repositoryRoot",
      "gitCommonDir",
      "worktreePath",
      "head",
      "baseline",
      "createdAt",
      "updatedAt",
      "changedPaths",
      "conflictPaths",
      "error",
    ]) ||
    ![
      "creating",
      "ready",
      "integrating",
      "integrated",
      "discarding",
      "discarded",
      "conflicted",
      "recoveryRequired",
    ].includes(String(value.lifecycle)) ||
    !isSafeAbsolutePath(value.repositoryRoot) ||
    !isSafeAbsolutePath(value.gitCommonDir) ||
    !isSafeAbsolutePath(value.worktreePath) ||
    !isPathInside(value.gitCommonDir, value.worktreePath) ||
    typeof value.head !== "string" ||
    !/^[a-f\d]{40}(?:[a-f\d]{24})?$/iu.test(value.head) ||
    !isWorkspaceBaseline(value.baseline) ||
    !isNonNegativeFiniteNumber(value.createdAt) ||
    !isNonNegativeFiniteNumber(value.updatedAt) ||
    value.updatedAt < value.createdAt ||
    (value.changedPaths !== undefined && !isSafeRelativePathList(value.changedPaths, 10_000)) ||
    (value.conflictPaths !== undefined && !isSafeRelativePathList(value.conflictPaths, 10_000)) ||
    (value.error !== undefined && !isBoundedString(value.error, 4_000))
  ) {
    return false;
  }
  return true;
}

function isWorkspaceBaseline(
  value: unknown,
): value is Record<string, ManagedTeamTaskWorkspaceFileState> {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 50_000 &&
    entries.reduce((length, [path]) => length + path.length, 0) <= 5_000_000 &&
    entries.every(([path, entry]) => isSafeRelativePath(path) && isWorkspaceFileState(entry))
  );
}

function isWorkspaceFileState(value: unknown): value is ManagedTeamTaskWorkspaceFileState {
  if (!isRecord(value)) return false;
  if (value.type === "file") {
    return (
      hasOnlyKeys(value, ["type", "mode", "digest"]) &&
      Number.isInteger(value.mode) &&
      Number(value.mode) >= 0 &&
      Number(value.mode) <= 0o777 &&
      typeof value.digest === "string" &&
      /^[a-f\d]{64}$/iu.test(value.digest)
    );
  }
  return (
    value.type === "symlink" &&
    hasOnlyKeys(value, ["type", "target"]) &&
    isBoundedString(value.target, 4_096) &&
    !value.target.includes("\0")
  );
}

function isSafeRelativePathList(value: unknown, maximum: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximum &&
    value.every(isSafeRelativePath) &&
    new Set(value).size === value.length
  );
}

function isSafeRelativePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 4_096 ||
    value.includes("\0") ||
    value.includes("\\") ||
    isAbsolute(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment) => Boolean(segment) && segment !== "." && segment !== "..");
}

function isSafeManagedWritePath(value: string): boolean {
  return value.split("/").every((segment) => segment.toLowerCase() !== ".git");
}

function isSafeAbsolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 1 &&
    value.length <= 4_096 &&
    !value.includes("\0") &&
    isAbsolute(value) &&
    normalize(value) === value &&
    dirname(value) !== value
  );
}

function isPathInside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return isSafeRelativePath(child);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= maximum;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isTeamToolOperation(value: unknown): value is TeamToolOperationState {
  if (
    !isRecord(value) ||
    typeof value.threadId !== "string" ||
    typeof value.turnId !== "string" ||
    typeof value.callId !== "string" ||
    ![
      "spawn_task",
      "followup_task",
      "steer_task",
      "cancel_task",
      "submit_result",
      "integrate_task",
      "discard_task_changes",
    ].includes(String(value.tool)) ||
    typeof value.argumentsHash !== "string" ||
    !/^[a-f\d]{64}$/iu.test(value.argumentsHash) ||
    !["prepared", "applied"].includes(String(value.status)) ||
    typeof value.createdAt !== "number" ||
    typeof value.updatedAt !== "number" ||
    (value.taskId !== undefined && typeof value.taskId !== "string") ||
    (value.childThreadSource !== undefined && typeof value.childThreadSource !== "string")
  ) {
    return false;
  }
  if (value.response === undefined) return value.status === "prepared";
  return (
    value.status === "applied" &&
    isRecord(value.response) &&
    typeof value.response.success === "boolean" &&
    Array.isArray(value.response.contentItems) &&
    value.response.contentItems.every(
      (item) =>
        isRecord(item) &&
        ((item.type === "inputText" && typeof item.text === "string") ||
          (item.type === "inputImage" && typeof item.imageUrl === "string")),
    )
  );
}

function isLegacyTeamOrchestrationState(value: unknown): boolean {
  return isRecord(value) && isRecord(value.children) && value.tasks === undefined;
}

function isManagedParent(value: unknown): boolean {
  return (
    isRecord(value) && typeof value.parentThreadId === "string" && typeof value.taskId === "string"
  );
}

function isManagedResultCandidate(value: unknown): value is ManagedTeamTaskResultCandidate {
  return (
    isRecord(value) &&
    typeof value.summary === "string" &&
    Boolean(value.summary.trim()) &&
    (value.details === undefined || typeof value.details === "string") &&
    typeof value.submittedAt === "number" &&
    typeof value.callId === "string" &&
    isManagedResultFields(value)
  );
}

function isManagedWatchdog(value: unknown): boolean {
  return (
    isRecord(value) &&
    ["pending", "claimed"].includes(String(value.status)) &&
    typeof value.triggeredAt === "number" &&
    (value.claimId === undefined || typeof value.claimId === "string") &&
    (value.status !== "claimed" || typeof value.claimId === "string") &&
    (value.markerId === undefined || typeof value.markerId === "string") &&
    (value.dispatchStartedAt === undefined || typeof value.dispatchStartedAt === "number") &&
    (value.contextHash === undefined ||
      (typeof value.contextHash === "string" && /^[a-f\d]{64}$/iu.test(value.contextHash)))
  );
}

function isManagedResult(value: unknown): value is ManagedTeamTaskResult {
  return (
    isRecord(value) &&
    typeof value.summary === "string" &&
    Boolean(value.summary.trim()) &&
    (value.details === undefined || typeof value.details === "string") &&
    ["submitted", "final_answer", "agent_message", "status"].includes(String(value.source)) &&
    isManagedResultFields(value)
  );
}

function isManagedResultFields(value: Record<string, unknown>): boolean {
  const outcome = value.outcome;
  if (
    outcome !== undefined &&
    !["success", "partial", "blocked", "failed"].includes(String(outcome))
  ) {
    return false;
  }
  if (
    value.checks !== undefined &&
    (!Array.isArray(value.checks) ||
      value.checks.length > 100 ||
      !value.checks.every(isManagedResultCheck))
  ) {
    return false;
  }
  if (
    value.risks !== undefined &&
    (!Array.isArray(value.risks) ||
      value.risks.length > 100 ||
      !value.risks.every((risk) => isBoundedString(risk, 4_000)))
  ) {
    return false;
  }
  if (
    value.artifacts !== undefined &&
    (!Array.isArray(value.artifacts) ||
      value.artifacts.length > 100 ||
      !value.artifacts.every(isManagedResultArtifact))
  ) {
    return false;
  }
  return (
    outcome !== undefined ||
    (value.checks === undefined && value.risks === undefined && value.artifacts === undefined)
  );
}

function isManagedResultCheck(value: unknown): value is ManagedTeamTaskResultCheck {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["name", "outcome", "details"]) &&
    isBoundedString(value.name, 500) &&
    ["passed", "failed", "notRun"].includes(String(value.outcome)) &&
    (value.details === undefined ||
      (typeof value.details === "string" && value.details.length <= 10_000))
  );
}

function isManagedResultArtifact(value: unknown): value is ManagedTeamTaskResultArtifact {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["label", "path", "url"]) &&
    isBoundedString(value.label, 500) &&
    (value.path === undefined || isSafeRelativePath(value.path)) &&
    (value.url === undefined || isSafeArtifactUrl(value.url)) &&
    (value.path !== undefined || value.url !== undefined)
  );
}

function isSafeArtifactUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isQueuedMessage(value: unknown, threadId: string): value is QueuedMessage {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.threadId === threadId &&
    typeof value.text === "string" &&
    (value.images === undefined ||
      (Array.isArray(value.images) && value.images.every(isInlineImage))) &&
    (value.goal === undefined || typeof value.goal === "boolean") &&
    (Boolean(value.text.trim()) || (Array.isArray(value.images) && value.images.length > 0)) &&
    typeof value.createdAt === "number" &&
    ["queued", "dispatching"].includes(String(value.status))
  );
}

function isVoiceTranscription(value: unknown, threadId: string): value is VoiceTranscriptionState {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    value.threadId !== threadId ||
    !["draft", "send", "queue", "steer"].includes(String(value.mode)) ||
    !["queued", "transcribing", "applying", "failed"].includes(String(value.status)) ||
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt) ||
    (value.startedAt !== null &&
      (typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt))) ||
    typeof value.audioDurationMs !== "number" ||
    !Number.isFinite(value.audioDurationMs) ||
    value.audioDurationMs <= 0 ||
    (value.estimatedTotalSeconds !== null &&
      (typeof value.estimatedTotalSeconds !== "number" ||
        !Number.isFinite(value.estimatedTotalSeconds) ||
        value.estimatedTotalSeconds <= 0)) ||
    (value.error !== null && typeof value.error !== "string") ||
    !["audio/webm", "audio/mp4"].includes(String(value.contentType)) ||
    typeof value.audioBytes !== "number" ||
    !Number.isSafeInteger(value.audioBytes) ||
    value.audioBytes <= 0 ||
    typeof value.selectionStart !== "number" ||
    !Number.isSafeInteger(value.selectionStart) ||
    value.selectionStart < 0 ||
    typeof value.selectionEnd !== "number" ||
    !Number.isSafeInteger(value.selectionEnd) ||
    value.selectionEnd < value.selectionStart ||
    (value.timingProfile !== undefined &&
      (typeof value.timingProfile !== "string" || !value.timingProfile.trim())) ||
    (value.transcript !== undefined &&
      (typeof value.transcript !== "string" || !value.transcript.trim())) ||
    (value.attempts !== undefined &&
      (typeof value.attempts !== "number" ||
        !Number.isSafeInteger(value.attempts) ||
        value.attempts < 0)) ||
    (value.nextAttemptAt !== undefined &&
      (typeof value.nextAttemptAt !== "number" || !Number.isFinite(value.nextAttemptAt)))
  ) {
    return false;
  }
  if (
    value.audioFile !== undefined &&
    (typeof value.audioFile !== "string" ||
      !/^[a-zA-Z0-9._-]+$/.test(value.audioFile) ||
      value.audioFile.includes(".."))
  ) {
    return false;
  }
  return value.status === "failed" || Boolean(value.audioFile) || Boolean(value.transcript);
}

function isTaskDefaults(value: unknown): value is TaskDefaults {
  if (!isRecord(value)) return false;
  return ["serviceTier", "personality"].every(
    (key) => value[key] === undefined || (typeof value[key] === "string" && value[key].trim()),
  );
}

function isInlineImage(value: unknown): value is string {
  return typeof value === "string" && /^data:image\/[a-z0-9.+-]+;base64,/i.test(value);
}

function isThreadDraft(value: unknown): value is ThreadDraft {
  if (
    !isRecord(value) ||
    typeof value.input !== "string" ||
    typeof value.goalMode !== "boolean" ||
    typeof value.updatedAt !== "number" ||
    !Number.isFinite(value.updatedAt) ||
    !Array.isArray(value.images) ||
    !Array.isArray(value.annotations)
  ) {
    return false;
  }
  return (
    value.images.every(
      (image) =>
        isRecord(image) &&
        typeof image.id === "string" &&
        Boolean(image.id) &&
        typeof image.name === "string" &&
        Boolean(image.name) &&
        isInlineImage(image.url),
    ) && value.annotations.every(isThreadDraftAnnotation)
  );
}

function isThreadDraftAnnotation(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    Boolean(value.id) &&
    typeof value.messageId === "string" &&
    Boolean(value.messageId) &&
    ["agentMessage", "plan"].includes(String(value.source)) &&
    typeof value.quote === "string" &&
    Boolean(value.quote.trim()) &&
    typeof value.startOffset === "number" &&
    Number.isInteger(value.startOffset) &&
    value.startOffset >= 0 &&
    typeof value.endOffset === "number" &&
    Number.isInteger(value.endOffset) &&
    value.endOffset > value.startOffset &&
    typeof value.comment === "string" &&
    Boolean(value.comment.trim()) &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt)
  );
}

function isSessionSettings(value: unknown): value is SessionSettings {
  if (!isRecord(value) || !["default", "plan", "team"].includes(String(value.collaborationMode))) {
    return false;
  }
  for (const key of ["model", "reasoningEffort", "serviceTier", "personality"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") return false;
  }
  if (
    value.sandboxMode !== undefined &&
    !["read-only", "workspace-write", "danger-full-access"].includes(String(value.sandboxMode))
  ) {
    return false;
  }
  if (
    value.approvalsReviewer !== undefined &&
    !["user", "auto_review"].includes(String(value.approvalsReviewer))
  ) {
    return false;
  }
  return (
    value.approvalPolicy === undefined ||
    ["untrusted", "on-request", "granular", "never"].includes(String(value.approvalPolicy))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isProject(value: unknown): value is Project {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.displayName === "string" &&
    typeof value.path === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}
