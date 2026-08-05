export const API_PREFIX = "/api/v1";
export const EVENTS_PATH = `${API_PREFIX}/events`;

export type AppServerState = "starting" | "ready" | "unavailable" | "stopped";
export type RecoveryState =
  "starting" | "syncing" | "recovering" | "ready" | "draining" | "unavailable" | "failed";

export type HealthResponse = {
  status: "ok" | "degraded";
  serverVersion: string;
  recoveryState: RecoveryState;
  restartProtocolVersion: number;
  transport: "stdio" | "daemon";
  appServer: {
    state: AppServerState;
    installedVersion: string | null;
    message: string | null;
  };
};

export type SummaryResponse = {
  threadCount: number;
  projectCount: number;
  pendingAttentionCount: number;
  syncedAt: string | null;
};

export type TranscriptionProvider = "local" | "openai";

export type UiLanguage = "en" | "ru";

export type TranscriptionTimingEstimate = {
  sampleCount: number;
  estimatedFixedProcessingMs: number | null;
  estimatedProcessingMsPerAudioSecond: number | null;
};

export type UiLanguageSettings = {
  language: UiLanguage;
};

export type UpdateUiLanguageRequest = UiLanguageSettings;

export type TranscriptionConfigResponse = {
  providers: TranscriptionProvider[];
  provider: TranscriptionProvider | null;
  localUrl: string | null;
  openAiApiKeyConfigured: boolean;
  openAiModel: string;
  language: string | null;
  refineLocal: boolean;
  refinementModel: string;
  maxRecordingSeconds: number;
  maxUploadBytes: number;
  timingEstimate: TranscriptionTimingEstimate;
};

export type UpdateTranscriptionSettingsRequest = {
  provider: TranscriptionProvider | null;
  localUrl: string | null;
  openAiApiKey?: string | null;
  openAiModel: string;
  language: string | null;
  refineLocal: boolean;
  refinementModel: string;
};

export type TranscriptionResponse = {
  text: string;
  timingEstimate: TranscriptionTimingEstimate;
};

export type VoiceInputMode = "draft" | "send";

export type VoiceTranscriptionMode = VoiceInputMode | "queue" | "steer";

export type VoiceTranscriptionStatus = "queued" | "transcribing" | "applying" | "failed";

export type VoiceTranscriptionJob = {
  id: string;
  threadId: string;
  mode: VoiceTranscriptionMode;
  status: VoiceTranscriptionStatus;
  createdAt: number;
  startedAt: number | null;
  audioDurationMs: number;
  estimatedTotalSeconds: number | null;
  error: string | null;
};

export type GitChangesSummary = {
  state: "clean" | "dirty" | "notRepository";
  filesChanged: number;
  additions: number;
  deletions: number;
};

export type CodexRateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

export type CodexRateLimitsResponse = {
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
};

export type CodexManagementOperation =
  "idle" | "checking" | "applying_proxy" | "updating" | "restarting";

export type CodexProxyStatus = {
  configured: boolean;
  protocol: "http" | "https" | null;
  host: string | null;
  port: number | null;
  username: string | null;
  hasPassword: boolean;
  error: string | null;
};

export type CodexManagementStatus = {
  supported: boolean;
  unavailableReason: string | null;
  operation: CodexManagementOperation;
  activeTurnCount: number;
  daemonStatus: string;
  cliVersion: string | null;
  appServerVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean | null;
  networkStatus: "unknown" | "ok" | "error";
  networkMessage: string | null;
  proxy: CodexProxyStatus;
};

export type AppUpdateOperation =
  "idle" | "checking" | "preparing" | "building" | "switching" | "restarting";

export type AppUpdateResult = "none" | "updated" | "rolled_back" | "failed";

export type AppUpdateStatus = {
  supported: boolean;
  canUpdateWithActiveTurns: boolean;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean | null;
  operation: AppUpdateOperation;
  result: AppUpdateResult;
  message: string | null;
  checkedAt: string | null;
  updatedAt: string | null;
};

export type ForceRestartAccepted = {
  accepted: true;
};

export type UpdateCodexProxyRequest = {
  proxy: string;
};

export type ApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "validation_failed"
  | "client_update_required"
  | "payload_too_large"
  | "transcription_unavailable"
  | "transcription_failed"
  | "not_found"
  | "conflict"
  | "app_server_unavailable"
  | "internal_error";

export type ApiError = {
  error: {
    code: ApiErrorCode;
    message: string;
  };
};

export type Project = {
  id: string;
  displayName: string;
  path: string;
  createdAt: string;
  updatedAt: string;
};

export type DirectoryEntry = {
  name: string;
  path: string;
};

export type DirectoryListing = {
  rootPath: string;
  path: string;
  parentPath: string | null;
  directories: DirectoryEntry[];
};

export type ThreadOutcome = "completed" | "failed" | "interrupted";

export type ThreadState =
  "needsAttention" | "queued" | "running" | ThreadOutcome | "idle" | "unavailable";

export type ThreadRelation =
  | {
      kind: "session";
      sessionId: string;
    }
  | {
      kind: "subagent";
      sessionId: string;
      parentThreadId: string;
      nickname: string | null;
      role: string | null;
    };

export type ThreadSummary = {
  id: string;
  projectId: string | null;
  title: string;
  preview: string;
  cwd: string;
  state: ThreadState;
  unread: boolean;
  unseen: boolean;
  pinned: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  currentTurnId: string | null;
  queuedMessageCount: number;
  settings: SessionSettings;
  relation: ThreadRelation;
};

export type QueuedMessage = {
  id: string;
  threadId: string;
  text: string;
  images?: string[];
  goal?: boolean;
  createdAt: number;
  status: "queued" | "dispatching";
};

export type TurnPlanStep = {
  step: string;
  status: "pending" | "inProgress" | "completed";
};

export type TurnProgress = {
  startedAt: number | null;
  explanation: string | null;
  steps: TurnPlanStep[];
  filesChanged: number;
  additions: number;
  deletions: number;
};

export type OrchestrationResultCheck = {
  name: string;
  outcome: "passed" | "failed" | "notRun";
  details?: string;
};

export type OrchestrationResult = {
  outcome: "success" | "partial" | "blocked" | "failed";
  summary: string;
  checks?: OrchestrationResultCheck[];
};

export type OrchestrationWorkspaceIntegrationStatus =
  | "creating"
  | "ready"
  | "integrating"
  | "integrated"
  | "discarding"
  | "discarded"
  | "conflicted"
  | "recoveryRequired";

export type OrchestrationNoticeAgent = {
  threadId: string;
  title: string;
  nickname: string | null;
  outcome: ThreadOutcome;
  taskId?: string;
  result?: OrchestrationResult;
  budgetReason?: "timeout" | "tokenBudget";
  failureReason?: string;
  changedPaths?: string[];
  changedPathCount?: number;
  workspaceIntegrationStatus?: OrchestrationWorkspaceIntegrationStatus;
};

export type ActivityItem =
  | {
      type: "userMessage" | "agentMessage" | "reasoning" | "plan";
      id: string;
      status: "inProgress" | "completed" | "failed";
      text: string;
      images: string[];
      timestamp: number | null;
      phase: "commentary" | "final_answer" | null;
    }
  | {
      type: "command";
      id: string;
      status: "inProgress" | "completed" | "failed";
      kind: "read" | "search" | "command";
      command: string;
      cwd: string | null;
      output: string;
      exitCode: number | null;
    }
  | {
      type: "fileChange";
      id: string;
      status: "inProgress" | "completed" | "failed";
      path: string | null;
      patch: string;
    }
  | {
      type: "tool";
      id: string;
      status: "inProgress" | "completed" | "failed";
      title: string;
      detail: string;
    }
  | {
      type: "userInputResponse";
      id: string;
      status: "completed";
      entries: Array<{
        header: string;
        question: string;
        answers: string[];
      }>;
      timestamp: number;
      afterItemId: string | null;
    }
  | {
      type: "planChecklist";
      id: string;
      status: "inProgress" | "completed" | "failed";
      explanation: string | null;
      steps: TurnPlanStep[];
      timestamp: number;
      afterItemId: string | null;
    }
  | {
      type: "orchestrationNotice";
      id: string;
      status: "completed";
      agents: OrchestrationNoticeAgent[];
      timestamp: number;
      afterItemId: string | null;
    }
  | {
      type: "subagentLaunch";
      id: string;
      status: "inProgress" | "completed" | "failed";
      title: string;
      threadId: string | null;
    }
  | {
      type: "error" | "unsupported";
      id: string;
      status: "failed";
      message: string;
    };

export type TurnView = {
  id: string;
  status: "inProgress" | ThreadOutcome;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  progress: TurnProgress;
  items: ActivityItem[];
  /** False when only summary and live items are present. Missing means legacy full data. */
  itemsLoaded?: boolean;
};

export type TurnItemsResponse = {
  threadId: string;
  turnId: string;
  items: ActivityItem[];
};

export type ThreadDraftImage = {
  id: string;
  name: string;
  url: string;
};

export type ThreadDraftAnnotation = {
  id: string;
  messageId: string;
  source: "agentMessage" | "plan";
  quote: string;
  startOffset: number;
  endOffset: number;
  comment: string;
  createdAt: number;
};

export type UpdateThreadDraftRequest = {
  input: string;
  images: ThreadDraftImage[];
  goalMode: boolean;
  annotations: ThreadDraftAnnotation[];
};

export type ThreadDraft = UpdateThreadDraftRequest & {
  updatedAt: number;
};

export type ThreadSyncPoint = {
  cursor: string;
  anchorTurnId: string;
  anchorRevision: string;
};

export type ThreadDetail = {
  summary: ThreadSummary;
  turns: TurnView[];
  queuedMessages: QueuedMessage[];
  olderTurnsCursor: string | null;
  draft?: ThreadDraft | null;
  syncPoint?: ThreadSyncPoint | null;
};

export type ThreadChanges = {
  summary: ThreadSummary;
  turns: TurnView[];
  queuedMessages: QueuedMessage[];
  draft?: ThreadDraft | null;
  continuationCursor: string | null;
  syncPoint: ThreadSyncPoint | null;
  resetLatest: boolean;
  olderTurnsCursor: string | null;
};

export type ModelOption = {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  reasoningEfforts: Array<{
    value: string;
    description: string | null;
    isDefault: boolean;
  }>;
  serviceTiers: Array<{
    id: string;
    displayName: string;
  }>;
  supportsPersonality: boolean;
};

export type CollaborationMode = "default" | "plan" | "team";

export type PermissionPreset = "ask" | "auto" | "full-access";

export type GlobalPermissionSettings = {
  preset: PermissionPreset | null;
  version: string | null;
  overridden: boolean;
  message: string | null;
};

export type UpdateGlobalPermissionSettingsRequest = {
  preset: PermissionPreset;
  expectedVersion?: string | null;
};

export type SessionSettings = {
  collaborationMode: CollaborationMode;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  personality?: string;
};

export type TaskDefaults = {
  serviceTier?: string;
  personality?: string;
};

export type UpdateTaskDefaultsRequest = {
  serviceTier?: string | null;
  personality?: string | null;
};

export type ThreadGoalStatus =
  "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";

export type ThreadGoal = {
  threadId: string;
  objective: string;
  status: ThreadGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
};

export type UpdateThreadGoalRequest = {
  objective?: string;
  status?: ThreadGoalStatus;
};

export const DEFAULT_SESSION_SETTINGS: SessionSettings = {
  collaborationMode: "plan",
};

export type AttentionBase = {
  id: string;
  threadId: string | null;
  turnId: string | null;
  itemId: string | null;
  createdAt: number;
};

export type AttentionRequest =
  | (AttentionBase & {
      kind: "commandApproval";
      command: string | null;
      cwd: string | null;
      reason: string | null;
      networkHost: string | null;
      canAcceptForSession: boolean;
      proposedPolicyChanges: Array<{
        id: string;
        type: "exec" | "network";
        label: string;
      }>;
    })
  | (AttentionBase & {
      kind: "fileChangeApproval";
      reason: string | null;
      grantRoot: string | null;
      canAcceptForSession: boolean;
    })
  | (AttentionBase & {
      kind: "permissionApproval";
      cwd: string;
      reason: string | null;
      permissions: PermissionGrant;
    })
  | (AttentionBase & {
      kind: "userInput";
      questions: UserInputQuestion[];
      autoResolutionMs: number | null;
    })
  | (AttentionBase & {
      kind: "elicitation";
      mode: "form" | "url";
      message: string;
      url: string | null;
      schema: ElicitationSchema | null;
    })
  | (AttentionBase & {
      kind: "unsupported";
      method: string;
      message: string;
    });

export type PermissionGrant = {
  network?: {
    enabled?: boolean;
    domains?: string[];
  };
  fileSystem?: {
    read?: string[];
    write?: string[];
  };
};

export type UserInputQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
};

export type ElicitationPrimitive =
  | {
      type: "string";
      title?: string;
      description?: string;
      minLength?: number;
      maxLength?: number;
      format?: string;
      default?: string;
      enum?: string[];
    }
  | {
      type: "number" | "integer";
      title?: string;
      description?: string;
      minimum?: number;
      maximum?: number;
      default?: number;
    }
  | {
      type: "boolean";
      title?: string;
      description?: string;
      default?: boolean;
    }
  | {
      type: "array";
      title?: string;
      description?: string;
      items: { type: "string"; enum?: string[] };
      minItems?: number;
      maxItems?: number;
    };

export type ElicitationSchema = {
  properties: Record<string, ElicitationPrimitive>;
  required: string[];
};

export type AttentionResponse =
  | {
      kind: "approval";
      decision: "accept" | "acceptForSession" | "decline" | "cancel";
    }
  | {
      kind: "approvalAmendment";
      amendmentId: string;
    }
  | {
      kind: "permission";
      permissions: PermissionGrant;
      scope: "turn" | "session";
    }
  | {
      kind: "userInput";
      answers: Record<string, string[]>;
    }
  | {
      kind: "elicitation";
      action: "accept" | "decline" | "cancel";
      content: Record<string, unknown> | null;
    };

export type ConnectionView = {
  state: AppServerState;
  message: string | null;
  syncedAt: string | null;
};

export const SYNC_PROTOCOL_VERSION = 2 as const;

export type ProjectionStatus = "reconciling" | "ready";

export type ProjectionCursor = {
  epoch: string;
  revision: number;
};

export type AppSnapshot = {
  protocolVersion: typeof SYNC_PROTOCOL_VERSION;
  epoch: string;
  revision: number;
  projectionStatus: ProjectionStatus;
  uiLanguage: UiLanguage;
  connection: ConnectionView;
  projects: Project[];
  threads: ThreadSummary[];
  attention: AttentionRequest[];
  models: ModelOption[];
  defaultReasoningEffort?: string;
  taskDefaults?: TaskDefaults;
  pushConfigured: boolean;
  voiceTranscriptions?: VoiceTranscriptionJob[];
};

export type ServerEvent =
  | { type: "projection.replaced"; snapshot: AppSnapshot }
  | { type: "connection.changed"; connection: ConnectionView }
  | { type: "project.upserted"; project: Project }
  | { type: "projects.reordered"; projects: Project[] }
  | { type: "project.removed"; projectId: string }
  | { type: "thread.upserted"; thread: ThreadSummary }
  | { type: "thread.removed"; threadId: string }
  | { type: "activity.upserted"; threadId: string; turnId: string; item: ActivityItem }
  | { type: "turn.progressed"; threadId: string; turnId: string; progress: TurnProgress }
  | { type: "queue.changed"; threadId: string; messages: QueuedMessage[] }
  | { type: "draft.changed"; threadId: string; draft: ThreadDraft | null }
  | { type: "attention.upserted"; attention: AttentionRequest }
  | { type: "attention.removed"; attentionId: string }
  | { type: "models.changed"; models: ModelOption[] }
  | { type: "defaultReasoningEffort.changed"; reasoningEffort: string | null }
  | { type: "taskDefaults.changed"; taskDefaults: TaskDefaults }
  | { type: "uiLanguage.changed"; language: UiLanguage }
  | { type: "goal.changed"; threadId: string; goal: ThreadGoal | null }
  | { type: "voiceTranscription.upserted"; job: VoiceTranscriptionJob }
  | {
      type: "voiceTranscription.removed";
      threadId: string;
      jobId: string;
      outcome: "draft" | "send" | "cancelled";
    };

export type ClientFrame =
  | {
      type: "authenticate";
      protocolVersion: typeof SYNC_PROTOCOL_VERSION;
      token: string;
      cursor: ProjectionCursor | null;
      threadId: string | null;
    }
  | { type: "ping" };

export type ServerFrame =
  | {
      type: "snapshot";
      protocolVersion: typeof SYNC_PROTOCOL_VERSION;
      snapshot: AppSnapshot;
    }
  | {
      type: "replay";
      protocolVersion: typeof SYNC_PROTOCOL_VERSION;
      epoch: string;
      fromRevision: number;
      toRevision: number;
      patches: Array<{ revision: number; event: ServerEvent }>;
    }
  | {
      type: "patch";
      protocolVersion: typeof SYNC_PROTOCOL_VERSION;
      epoch: string;
      revision: number;
      event: ServerEvent;
    }
  | {
      /** Immediate authoritative replacement; it is not part of the revision stream. */
      type: "resync";
      protocolVersion: typeof SYNC_PROTOCOL_VERSION;
      snapshot: AppSnapshot;
    }
  | {
      /** Immediate thread projection; it is not part of the revision stream. */
      type: "thread.open";
      protocolVersion: typeof SYNC_PROTOCOL_VERSION;
      threadId: string;
      detail: ThreadDetail | null;
    }
  | { type: "pong" }
  | { type: "error"; error: ApiError["error"] };

export type CommandMetadata = {
  commandId?: string;
  expectedThreadId?: string;
  expectedTurnId?: string | null;
  expectedRevision?: number;
};

/** Descriptive alias for command metadata carried by HTTP request DTOs. */
export type CommandRequestMetadata = CommandMetadata;

export type CommandReceiptStatus = "pending" | "succeeded" | "noop" | "conflict" | "failed";

export type CommandReceiptMetadata<TPayload = unknown> = {
  commandId: string;
  kind: string;
  threadId: string | null;
  turnId: string | null;
  expectedThreadId: string | null;
  expectedRevision: number | null;
  payload: TPayload;
};

export type CommandReceipt<
  TPayload = unknown,
  TResult = unknown,
> = CommandReceiptMetadata<TPayload> & {
  status: CommandReceiptStatus;
  result: TResult | null;
  createdAt: number;
  updatedAt: number;
};

export type CreateProjectRequest = {
  path: string;
};

export type UpdateProjectRequest = {
  displayName?: string;
  path?: string;
};

export type MoveProjectRequest =
  { direction: "up" | "down"; targetIndex?: never } | { direction?: never; targetIndex: number };

export type CreateDirectoryRequest = {
  parentPath: string;
  name: string;
};

export type CreateThreadRequest = {
  projectId: string;
  input: string;
  images?: string[];
  goal?: boolean;
  settings?: UpdateThreadSettingsRequest;
  clientMessageId?: string;
} & Pick<CommandRequestMetadata, "commandId">;

export type ForkThreadRequest = {
  lastTurnId: string;
  agentMessageId: string;
} & Omit<CommandRequestMetadata, "expectedTurnId">;

export type ForkThreadResponse = {
  thread: ThreadSummary;
};

export type CreateProjectThreadResponse = {
  thread: ThreadSummary;
};

export type RefreshThreadResponse = {
  snapshot: AppSnapshot;
  detail: ThreadDetail;
};

export type TurnStartResult = {
  turnId: string;
  goalWarning?: string;
};

export type StartTurnRequest = {
  input: string;
  images?: string[];
  goal?: boolean;
  clientMessageId?: string;
} & CommandRequestMetadata;

export type QueueMessageRequest = {
  input: string;
  images?: string[];
  goal?: boolean;
  clientMessageId?: string;
} & CommandRequestMetadata;

export type UpdateQueuedMessageRequest = {
  input: string;
};

export type UpdateThreadSettingsRequest = {
  collaborationMode?: CollaborationMode;
  model?: string | null;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
  personality?: string | null;
};

export type SteerTurnRequest = {
  turnId: string;
  input: string;
  images?: string[];
};

export type InterruptTurnRequest = {
  turnId?: string;
} & Omit<CommandRequestMetadata, "expectedTurnId">;

export type UpdateThreadRequest = {
  name?: string;
  pinned?: boolean;
};

export type MarkReadRequest = {
  observedUpdatedAt: number;
};

export type DeviceRegistrationRequest = {
  fcmToken: string;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOptionalString(value: Record<string, unknown>, key: string): boolean {
  return !Object.prototype.hasOwnProperty.call(value, key) || typeof value[key] === "string";
}

function isOptionalBoolean(value: Record<string, unknown>, key: string): boolean {
  return !Object.prototype.hasOwnProperty.call(value, key) || typeof value[key] === "boolean";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableNonEmptyString(value: unknown): value is string | null {
  return value === null || isNonEmptyString(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    isFiniteNumber(value)
  ) {
    return true;
  }
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, ancestors))
    : Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

export function isProjectionCursor(value: unknown): value is ProjectionCursor {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["epoch", "revision"]) &&
    isNonEmptyString(value.epoch) &&
    isNonNegativeInteger(value.revision)
  );
}

function isConnectionView(value: unknown): value is ConnectionView {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["state", "message", "syncedAt"]) &&
    isOneOf(value.state, ["starting", "ready", "unavailable", "stopped"] as const) &&
    isNullableString(value.message) &&
    isNullableString(value.syncedAt)
  );
}

function isProject(value: unknown): value is Project {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["id", "displayName", "path", "createdAt", "updatedAt"]) &&
    isNonEmptyString(value.id) &&
    typeof value.displayName === "string" &&
    isNonEmptyString(value.path) &&
    isNonEmptyString(value.createdAt) &&
    isNonEmptyString(value.updatedAt)
  );
}

function isSessionSettings(value: unknown): value is SessionSettings {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      ["collaborationMode"],
      ["model", "reasoningEffort", "serviceTier", "personality"],
    ) &&
    isOneOf(value.collaborationMode, ["default", "plan", "team"] as const) &&
    isOptionalString(value, "model") &&
    isOptionalString(value, "reasoningEffort") &&
    isOptionalString(value, "serviceTier") &&
    isOptionalString(value, "personality")
  );
}

function isThreadRelation(value: unknown): value is ThreadRelation {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "session") {
    return hasExactKeys(value, ["kind", "sessionId"]) && isNonEmptyString(value.sessionId);
  }
  return (
    value.kind === "subagent" &&
    hasExactKeys(value, ["kind", "sessionId", "parentThreadId", "nickname", "role"]) &&
    isNonEmptyString(value.sessionId) &&
    isNonEmptyString(value.parentThreadId) &&
    isNullableString(value.nickname) &&
    isNullableString(value.role)
  );
}

function isThreadSummary(value: unknown): value is ThreadSummary {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "id",
      "projectId",
      "title",
      "preview",
      "cwd",
      "state",
      "unread",
      "unseen",
      "pinned",
      "archived",
      "createdAt",
      "updatedAt",
      "currentTurnId",
      "queuedMessageCount",
      "settings",
      "relation",
    ]) &&
    isNonEmptyString(value.id) &&
    isNullableNonEmptyString(value.projectId) &&
    typeof value.title === "string" &&
    typeof value.preview === "string" &&
    isNonEmptyString(value.cwd) &&
    isOneOf(value.state, [
      "needsAttention",
      "queued",
      "running",
      "completed",
      "failed",
      "interrupted",
      "idle",
      "unavailable",
    ] as const) &&
    typeof value.unread === "boolean" &&
    typeof value.unseen === "boolean" &&
    typeof value.pinned === "boolean" &&
    typeof value.archived === "boolean" &&
    isNonNegativeInteger(value.createdAt) &&
    isNonNegativeInteger(value.updatedAt) &&
    isNullableNonEmptyString(value.currentTurnId) &&
    isNonNegativeInteger(value.queuedMessageCount) &&
    isSessionSettings(value.settings) &&
    isThreadRelation(value.relation)
  );
}

function isQueuedMessage(value: unknown): value is QueuedMessage {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["id", "threadId", "text", "createdAt", "status"], ["images", "goal"]) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.threadId) &&
    typeof value.text === "string" &&
    (!Object.prototype.hasOwnProperty.call(value, "images") || isStringArray(value.images)) &&
    isOptionalBoolean(value, "goal") &&
    isNonNegativeInteger(value.createdAt) &&
    isOneOf(value.status, ["queued", "dispatching"] as const)
  );
}

function isTurnPlanStep(value: unknown): value is TurnPlanStep {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["step", "status"]) &&
    typeof value.step === "string" &&
    isOneOf(value.status, ["pending", "inProgress", "completed"] as const)
  );
}

function isTurnProgress(value: unknown): value is TurnProgress {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "startedAt",
      "explanation",
      "steps",
      "filesChanged",
      "additions",
      "deletions",
    ]) &&
    (value.startedAt === null || isNonNegativeInteger(value.startedAt)) &&
    isNullableString(value.explanation) &&
    Array.isArray(value.steps) &&
    value.steps.every(isTurnPlanStep) &&
    isNonNegativeInteger(value.filesChanged) &&
    isNonNegativeInteger(value.additions) &&
    isNonNegativeInteger(value.deletions)
  );
}

function isOrchestrationResultCheck(value: unknown): value is OrchestrationResultCheck {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["name", "outcome"], ["details"]) &&
    isNonEmptyString(value.name) &&
    isOneOf(value.outcome, ["passed", "failed", "notRun"] as const) &&
    isOptionalString(value, "details")
  );
}

function isOrchestrationResult(value: unknown): value is OrchestrationResult {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["outcome", "summary"], ["checks"]) &&
    isOneOf(value.outcome, ["success", "partial", "blocked", "failed"] as const) &&
    isNonEmptyString(value.summary) &&
    (!Object.prototype.hasOwnProperty.call(value, "checks") ||
      (Array.isArray(value.checks) && value.checks.every(isOrchestrationResultCheck)))
  );
}

function isOrchestrationNoticeAgent(value: unknown): value is OrchestrationNoticeAgent {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      ["threadId", "title", "nickname", "outcome"],
      [
        "taskId",
        "result",
        "budgetReason",
        "failureReason",
        "changedPaths",
        "changedPathCount",
        "workspaceIntegrationStatus",
      ],
    ) &&
    isNonEmptyString(value.threadId) &&
    typeof value.title === "string" &&
    isNullableString(value.nickname) &&
    isOneOf(value.outcome, ["completed", "failed", "interrupted"] as const) &&
    isOptionalString(value, "taskId") &&
    (!Object.prototype.hasOwnProperty.call(value, "result") ||
      isOrchestrationResult(value.result)) &&
    (!Object.prototype.hasOwnProperty.call(value, "budgetReason") ||
      isOneOf(value.budgetReason, ["timeout", "tokenBudget"] as const)) &&
    isOptionalString(value, "failureReason") &&
    (!Object.prototype.hasOwnProperty.call(value, "changedPaths") ||
      isStringArray(value.changedPaths)) &&
    (!Object.prototype.hasOwnProperty.call(value, "changedPathCount") ||
      isNonNegativeInteger(value.changedPathCount)) &&
    (!Object.prototype.hasOwnProperty.call(value, "workspaceIntegrationStatus") ||
      isOneOf(value.workspaceIntegrationStatus, [
        "creating",
        "ready",
        "integrating",
        "integrated",
        "discarding",
        "discarded",
        "conflicted",
        "recoveryRequired",
      ] as const))
  );
}

function isActivityStatus(value: unknown): boolean {
  return isOneOf(value, ["inProgress", "completed", "failed"] as const);
}

function isActivityItem(value: unknown): value is ActivityItem {
  if (!isRecord(value) || !isNonEmptyString(value.type)) return false;
  switch (value.type) {
    case "userMessage":
    case "agentMessage":
    case "reasoning":
    case "plan":
      return (
        hasExactKeys(value, ["type", "id", "status", "text", "images", "timestamp", "phase"]) &&
        isNonEmptyString(value.id) &&
        isActivityStatus(value.status) &&
        typeof value.text === "string" &&
        isStringArray(value.images) &&
        (value.timestamp === null || isNonNegativeInteger(value.timestamp)) &&
        (value.phase === null || isOneOf(value.phase, ["commentary", "final_answer"] as const))
      );
    case "command":
      return (
        hasExactKeys(value, [
          "type",
          "id",
          "status",
          "kind",
          "command",
          "cwd",
          "output",
          "exitCode",
        ]) &&
        isNonEmptyString(value.id) &&
        isActivityStatus(value.status) &&
        isOneOf(value.kind, ["read", "search", "command"] as const) &&
        typeof value.command === "string" &&
        isNullableString(value.cwd) &&
        typeof value.output === "string" &&
        (value.exitCode === null ||
          (isFiniteNumber(value.exitCode) && Number.isSafeInteger(value.exitCode)))
      );
    case "fileChange":
      return (
        hasExactKeys(value, ["type", "id", "status", "path", "patch"]) &&
        isNonEmptyString(value.id) &&
        isActivityStatus(value.status) &&
        isNullableString(value.path) &&
        typeof value.patch === "string"
      );
    case "tool":
      return (
        hasExactKeys(value, ["type", "id", "status", "title", "detail"]) &&
        isNonEmptyString(value.id) &&
        isActivityStatus(value.status) &&
        typeof value.title === "string" &&
        typeof value.detail === "string"
      );
    case "userInputResponse":
      return (
        hasExactKeys(value, ["type", "id", "status", "entries", "timestamp", "afterItemId"]) &&
        isNonEmptyString(value.id) &&
        value.status === "completed" &&
        Array.isArray(value.entries) &&
        value.entries.every(
          (entry) =>
            isRecord(entry) &&
            hasExactKeys(entry, ["header", "question", "answers"]) &&
            typeof entry.header === "string" &&
            typeof entry.question === "string" &&
            isStringArray(entry.answers),
        ) &&
        isNonNegativeInteger(value.timestamp) &&
        isNullableNonEmptyString(value.afterItemId)
      );
    case "planChecklist":
      return (
        hasExactKeys(value, [
          "type",
          "id",
          "status",
          "explanation",
          "steps",
          "timestamp",
          "afterItemId",
        ]) &&
        isNonEmptyString(value.id) &&
        isActivityStatus(value.status) &&
        isNullableString(value.explanation) &&
        Array.isArray(value.steps) &&
        value.steps.every(isTurnPlanStep) &&
        isNonNegativeInteger(value.timestamp) &&
        isNullableNonEmptyString(value.afterItemId)
      );
    case "orchestrationNotice":
      return (
        hasExactKeys(value, ["type", "id", "status", "agents", "timestamp", "afterItemId"]) &&
        isNonEmptyString(value.id) &&
        value.status === "completed" &&
        Array.isArray(value.agents) &&
        value.agents.every(isOrchestrationNoticeAgent) &&
        isNonNegativeInteger(value.timestamp) &&
        isNullableNonEmptyString(value.afterItemId)
      );
    case "subagentLaunch":
      return (
        hasExactKeys(value, ["type", "id", "status", "title", "threadId"]) &&
        isNonEmptyString(value.id) &&
        isActivityStatus(value.status) &&
        typeof value.title === "string" &&
        isNullableNonEmptyString(value.threadId)
      );
    case "error":
    case "unsupported":
      return (
        hasExactKeys(value, ["type", "id", "status", "message"]) &&
        isNonEmptyString(value.id) &&
        value.status === "failed" &&
        typeof value.message === "string"
      );
    default:
      return false;
  }
}

function isTurnView(value: unknown): value is TurnView {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      ["id", "status", "startedAt", "completedAt", "durationMs", "progress", "items"],
      ["itemsLoaded"],
    ) &&
    isNonEmptyString(value.id) &&
    isOneOf(value.status, ["inProgress", "completed", "failed", "interrupted"] as const) &&
    (value.startedAt === null || isNonNegativeInteger(value.startedAt)) &&
    (value.completedAt === null || isNonNegativeInteger(value.completedAt)) &&
    (value.durationMs === null || isNonNegativeInteger(value.durationMs)) &&
    isTurnProgress(value.progress) &&
    Array.isArray(value.items) &&
    value.items.every(isActivityItem) &&
    isOptionalBoolean(value, "itemsLoaded")
  );
}

function isThreadDraftImage(value: unknown): value is ThreadDraftImage {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["id", "name", "url"]) &&
    isNonEmptyString(value.id) &&
    typeof value.name === "string" &&
    isNonEmptyString(value.url)
  );
}

function isThreadDraftAnnotation(value: unknown): value is ThreadDraftAnnotation {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "id",
      "messageId",
      "source",
      "quote",
      "startOffset",
      "endOffset",
      "comment",
      "createdAt",
    ]) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.messageId) &&
    isOneOf(value.source, ["agentMessage", "plan"] as const) &&
    typeof value.quote === "string" &&
    isNonNegativeInteger(value.startOffset) &&
    isNonNegativeInteger(value.endOffset) &&
    value.endOffset >= value.startOffset &&
    typeof value.comment === "string" &&
    isNonNegativeInteger(value.createdAt)
  );
}

function isThreadDraft(value: unknown): value is ThreadDraft {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["input", "images", "goalMode", "annotations", "updatedAt"]) &&
    typeof value.input === "string" &&
    Array.isArray(value.images) &&
    value.images.every(isThreadDraftImage) &&
    typeof value.goalMode === "boolean" &&
    Array.isArray(value.annotations) &&
    value.annotations.every(isThreadDraftAnnotation) &&
    isNonNegativeInteger(value.updatedAt)
  );
}

function isThreadSyncPoint(value: unknown): value is ThreadSyncPoint {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["cursor", "anchorTurnId", "anchorRevision"]) &&
    isNonEmptyString(value.cursor) &&
    isNonEmptyString(value.anchorTurnId) &&
    isNonEmptyString(value.anchorRevision)
  );
}

export function isThreadDetail(value: unknown): value is ThreadDetail {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      ["summary", "turns", "queuedMessages", "olderTurnsCursor"],
      ["draft", "syncPoint"],
    ) &&
    isThreadSummary(value.summary) &&
    Array.isArray(value.turns) &&
    value.turns.every(isTurnView) &&
    Array.isArray(value.queuedMessages) &&
    value.queuedMessages.every(isQueuedMessage) &&
    isNullableString(value.olderTurnsCursor) &&
    (!Object.prototype.hasOwnProperty.call(value, "draft") ||
      value.draft === null ||
      isThreadDraft(value.draft)) &&
    (!Object.prototype.hasOwnProperty.call(value, "syncPoint") ||
      value.syncPoint === null ||
      isThreadSyncPoint(value.syncPoint))
  );
}

function isPermissionGrant(value: unknown): value is PermissionGrant {
  if (!isRecord(value) || !hasExactKeys(value, [], ["network", "fileSystem"])) return false;
  if (Object.prototype.hasOwnProperty.call(value, "network")) {
    if (
      !isRecord(value.network) ||
      !hasExactKeys(value.network, [], ["enabled", "domains"]) ||
      !isOptionalBoolean(value.network, "enabled") ||
      (Object.prototype.hasOwnProperty.call(value.network, "domains") &&
        !isStringArray(value.network.domains))
    ) {
      return false;
    }
  }
  if (Object.prototype.hasOwnProperty.call(value, "fileSystem")) {
    if (
      !isRecord(value.fileSystem) ||
      !hasExactKeys(value.fileSystem, [], ["read", "write"]) ||
      (Object.prototype.hasOwnProperty.call(value.fileSystem, "read") &&
        !isStringArray(value.fileSystem.read)) ||
      (Object.prototype.hasOwnProperty.call(value.fileSystem, "write") &&
        !isStringArray(value.fileSystem.write))
    ) {
      return false;
    }
  }
  return true;
}

function isUserInputQuestion(value: unknown): value is UserInputQuestion {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["id", "header", "question", "isOther", "isSecret", "options"]) &&
    isNonEmptyString(value.id) &&
    typeof value.header === "string" &&
    typeof value.question === "string" &&
    typeof value.isOther === "boolean" &&
    typeof value.isSecret === "boolean" &&
    (value.options === null ||
      (Array.isArray(value.options) &&
        value.options.every(
          (option) =>
            isRecord(option) &&
            hasExactKeys(option, ["label", "description"]) &&
            typeof option.label === "string" &&
            typeof option.description === "string",
        )))
  );
}

function isElicitationPrimitive(value: unknown): value is ElicitationPrimitive {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "string") {
    return (
      hasExactKeys(
        value,
        ["type"],
        ["title", "description", "minLength", "maxLength", "format", "default", "enum"],
      ) &&
      isOptionalString(value, "title") &&
      isOptionalString(value, "description") &&
      (!Object.prototype.hasOwnProperty.call(value, "minLength") ||
        isNonNegativeInteger(value.minLength)) &&
      (!Object.prototype.hasOwnProperty.call(value, "maxLength") ||
        isNonNegativeInteger(value.maxLength)) &&
      isOptionalString(value, "format") &&
      isOptionalString(value, "default") &&
      (!Object.prototype.hasOwnProperty.call(value, "enum") || isStringArray(value.enum))
    );
  }
  if (value.type === "number" || value.type === "integer") {
    return (
      hasExactKeys(value, ["type"], ["title", "description", "minimum", "maximum", "default"]) &&
      isOptionalString(value, "title") &&
      isOptionalString(value, "description") &&
      (!Object.prototype.hasOwnProperty.call(value, "minimum") || isFiniteNumber(value.minimum)) &&
      (!Object.prototype.hasOwnProperty.call(value, "maximum") || isFiniteNumber(value.maximum)) &&
      (!Object.prototype.hasOwnProperty.call(value, "default") || isFiniteNumber(value.default)) &&
      (value.type !== "integer" ||
        !Object.prototype.hasOwnProperty.call(value, "default") ||
        Number.isSafeInteger(value.default))
    );
  }
  if (value.type === "boolean") {
    return (
      hasExactKeys(value, ["type"], ["title", "description", "default"]) &&
      isOptionalString(value, "title") &&
      isOptionalString(value, "description") &&
      isOptionalBoolean(value, "default")
    );
  }
  return (
    value.type === "array" &&
    hasExactKeys(value, ["type", "items"], ["title", "description", "minItems", "maxItems"]) &&
    isOptionalString(value, "title") &&
    isOptionalString(value, "description") &&
    isRecord(value.items) &&
    hasExactKeys(value.items, ["type"], ["enum"]) &&
    value.items.type === "string" &&
    (!Object.prototype.hasOwnProperty.call(value.items, "enum") ||
      isStringArray(value.items.enum)) &&
    (!Object.prototype.hasOwnProperty.call(value, "minItems") ||
      isNonNegativeInteger(value.minItems)) &&
    (!Object.prototype.hasOwnProperty.call(value, "maxItems") ||
      isNonNegativeInteger(value.maxItems))
  );
}

function isElicitationSchema(value: unknown): value is ElicitationSchema {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["properties", "required"]) &&
    isRecord(value.properties) &&
    Object.values(value.properties).every(isElicitationPrimitive) &&
    isStringArray(value.required) &&
    value.required.every((name) => Object.prototype.hasOwnProperty.call(value.properties, name))
  );
}

function isAttentionBase(value: Record<string, unknown>): boolean {
  return (
    isNonEmptyString(value.id) &&
    isNullableNonEmptyString(value.threadId) &&
    isNullableNonEmptyString(value.turnId) &&
    isNullableNonEmptyString(value.itemId) &&
    isNonNegativeInteger(value.createdAt)
  );
}

function isAttentionRequest(value: unknown): value is AttentionRequest {
  if (!isRecord(value) || !isNonEmptyString(value.kind) || !isAttentionBase(value)) return false;
  const base = ["id", "threadId", "turnId", "itemId", "createdAt", "kind"];
  switch (value.kind) {
    case "commandApproval":
      return (
        hasExactKeys(value, [
          ...base,
          "command",
          "cwd",
          "reason",
          "networkHost",
          "canAcceptForSession",
          "proposedPolicyChanges",
        ]) &&
        isNullableString(value.command) &&
        isNullableString(value.cwd) &&
        isNullableString(value.reason) &&
        isNullableString(value.networkHost) &&
        typeof value.canAcceptForSession === "boolean" &&
        Array.isArray(value.proposedPolicyChanges) &&
        value.proposedPolicyChanges.every(
          (change) =>
            isRecord(change) &&
            hasExactKeys(change, ["id", "type", "label"]) &&
            isNonEmptyString(change.id) &&
            isOneOf(change.type, ["exec", "network"] as const) &&
            typeof change.label === "string",
        )
      );
    case "fileChangeApproval":
      return (
        hasExactKeys(value, [...base, "reason", "grantRoot", "canAcceptForSession"]) &&
        isNullableString(value.reason) &&
        isNullableString(value.grantRoot) &&
        typeof value.canAcceptForSession === "boolean"
      );
    case "permissionApproval":
      return (
        hasExactKeys(value, [...base, "cwd", "reason", "permissions"]) &&
        isNonEmptyString(value.cwd) &&
        isNullableString(value.reason) &&
        isPermissionGrant(value.permissions)
      );
    case "userInput":
      return (
        hasExactKeys(value, [...base, "questions", "autoResolutionMs"]) &&
        Array.isArray(value.questions) &&
        value.questions.every(isUserInputQuestion) &&
        (value.autoResolutionMs === null || isNonNegativeInteger(value.autoResolutionMs))
      );
    case "elicitation":
      return (
        hasExactKeys(value, [...base, "mode", "message", "url", "schema"]) &&
        isOneOf(value.mode, ["form", "url"] as const) &&
        typeof value.message === "string" &&
        isNullableString(value.url) &&
        (value.schema === null || isElicitationSchema(value.schema))
      );
    case "unsupported":
      return (
        hasExactKeys(value, [...base, "method", "message"]) &&
        isNonEmptyString(value.method) &&
        typeof value.message === "string"
      );
    default:
      return false;
  }
}

function isModelOption(value: unknown): value is ModelOption {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "id",
      "displayName",
      "description",
      "isDefault",
      "reasoningEfforts",
      "serviceTiers",
      "supportsPersonality",
    ]) &&
    isNonEmptyString(value.id) &&
    typeof value.displayName === "string" &&
    typeof value.description === "string" &&
    typeof value.isDefault === "boolean" &&
    Array.isArray(value.reasoningEfforts) &&
    value.reasoningEfforts.every(
      (effort) =>
        isRecord(effort) &&
        hasExactKeys(effort, ["value", "description", "isDefault"]) &&
        isNonEmptyString(effort.value) &&
        isNullableString(effort.description) &&
        typeof effort.isDefault === "boolean",
    ) &&
    Array.isArray(value.serviceTiers) &&
    value.serviceTiers.every(
      (tier) =>
        isRecord(tier) &&
        hasExactKeys(tier, ["id", "displayName"]) &&
        isNonEmptyString(tier.id) &&
        typeof tier.displayName === "string",
    ) &&
    typeof value.supportsPersonality === "boolean"
  );
}

function isTaskDefaults(value: unknown): value is TaskDefaults {
  return (
    isRecord(value) &&
    hasExactKeys(value, [], ["serviceTier", "personality"]) &&
    isOptionalString(value, "serviceTier") &&
    isOptionalString(value, "personality")
  );
}

function isVoiceTranscriptionJob(value: unknown): value is VoiceTranscriptionJob {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "id",
      "threadId",
      "mode",
      "status",
      "createdAt",
      "startedAt",
      "audioDurationMs",
      "estimatedTotalSeconds",
      "error",
    ]) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.threadId) &&
    isOneOf(value.mode, ["draft", "send", "queue", "steer"] as const) &&
    isOneOf(value.status, ["queued", "transcribing", "applying", "failed"] as const) &&
    isNonNegativeInteger(value.createdAt) &&
    (value.startedAt === null || isNonNegativeInteger(value.startedAt)) &&
    isNonNegativeInteger(value.audioDurationMs) &&
    (value.estimatedTotalSeconds === null ||
      (isFiniteNumber(value.estimatedTotalSeconds) && value.estimatedTotalSeconds >= 0)) &&
    isNullableString(value.error)
  );
}

function isThreadGoal(value: unknown): value is ThreadGoal {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "threadId",
      "objective",
      "status",
      "tokenBudget",
      "tokensUsed",
      "timeUsedSeconds",
      "createdAt",
      "updatedAt",
    ]) &&
    isNonEmptyString(value.threadId) &&
    typeof value.objective === "string" &&
    isOneOf(value.status, [
      "active",
      "paused",
      "blocked",
      "usageLimited",
      "budgetLimited",
      "complete",
    ] as const) &&
    (value.tokenBudget === null || isNonNegativeInteger(value.tokenBudget)) &&
    isNonNegativeInteger(value.tokensUsed) &&
    isFiniteNumber(value.timeUsedSeconds) &&
    value.timeUsedSeconds >= 0 &&
    isNonNegativeInteger(value.createdAt) &&
    isNonNegativeInteger(value.updatedAt)
  );
}

export function isAppSnapshot(value: unknown): value is AppSnapshot {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      [
        "protocolVersion",
        "epoch",
        "revision",
        "projectionStatus",
        "uiLanguage",
        "connection",
        "projects",
        "threads",
        "attention",
        "models",
        "pushConfigured",
      ],
      ["defaultReasoningEffort", "taskDefaults", "voiceTranscriptions"],
    ) &&
    value.protocolVersion === SYNC_PROTOCOL_VERSION &&
    isNonEmptyString(value.epoch) &&
    isNonNegativeInteger(value.revision) &&
    isOneOf(value.projectionStatus, ["reconciling", "ready"] as const) &&
    isOneOf(value.uiLanguage, ["en", "ru"] as const) &&
    isConnectionView(value.connection) &&
    Array.isArray(value.projects) &&
    value.projects.every(isProject) &&
    Array.isArray(value.threads) &&
    value.threads.every(isThreadSummary) &&
    Array.isArray(value.attention) &&
    value.attention.every(isAttentionRequest) &&
    Array.isArray(value.models) &&
    value.models.every(isModelOption) &&
    isOptionalString(value, "defaultReasoningEffort") &&
    (!Object.prototype.hasOwnProperty.call(value, "taskDefaults") ||
      isTaskDefaults(value.taskDefaults)) &&
    typeof value.pushConfigured === "boolean" &&
    (!Object.prototype.hasOwnProperty.call(value, "voiceTranscriptions") ||
      (Array.isArray(value.voiceTranscriptions) &&
        value.voiceTranscriptions.every(isVoiceTranscriptionJob)))
  );
}

export function isServerEvent(value: unknown): value is ServerEvent {
  if (!isRecord(value) || !isNonEmptyString(value.type)) return false;
  switch (value.type) {
    case "projection.replaced":
      return hasExactKeys(value, ["type", "snapshot"]) && isAppSnapshot(value.snapshot);
    case "connection.changed":
      return hasExactKeys(value, ["type", "connection"]) && isConnectionView(value.connection);
    case "project.upserted":
      return hasExactKeys(value, ["type", "project"]) && isProject(value.project);
    case "projects.reordered":
      return (
        hasExactKeys(value, ["type", "projects"]) &&
        Array.isArray(value.projects) &&
        value.projects.every(isProject)
      );
    case "project.removed":
      return hasExactKeys(value, ["type", "projectId"]) && isNonEmptyString(value.projectId);
    case "thread.upserted":
      return hasExactKeys(value, ["type", "thread"]) && isThreadSummary(value.thread);
    case "thread.removed":
      return hasExactKeys(value, ["type", "threadId"]) && isNonEmptyString(value.threadId);
    case "activity.upserted":
      return (
        hasExactKeys(value, ["type", "threadId", "turnId", "item"]) &&
        isNonEmptyString(value.threadId) &&
        isNonEmptyString(value.turnId) &&
        isActivityItem(value.item)
      );
    case "turn.progressed":
      return (
        hasExactKeys(value, ["type", "threadId", "turnId", "progress"]) &&
        isNonEmptyString(value.threadId) &&
        isNonEmptyString(value.turnId) &&
        isTurnProgress(value.progress)
      );
    case "queue.changed":
      return (
        hasExactKeys(value, ["type", "threadId", "messages"]) &&
        isNonEmptyString(value.threadId) &&
        Array.isArray(value.messages) &&
        value.messages.every(isQueuedMessage)
      );
    case "draft.changed":
      return (
        hasExactKeys(value, ["type", "threadId", "draft"]) &&
        isNonEmptyString(value.threadId) &&
        (value.draft === null || isThreadDraft(value.draft))
      );
    case "attention.upserted":
      return hasExactKeys(value, ["type", "attention"]) && isAttentionRequest(value.attention);
    case "attention.removed":
      return hasExactKeys(value, ["type", "attentionId"]) && isNonEmptyString(value.attentionId);
    case "models.changed":
      return (
        hasExactKeys(value, ["type", "models"]) &&
        Array.isArray(value.models) &&
        value.models.every(isModelOption)
      );
    case "defaultReasoningEffort.changed":
      return (
        hasExactKeys(value, ["type", "reasoningEffort"]) && isNullableString(value.reasoningEffort)
      );
    case "taskDefaults.changed":
      return hasExactKeys(value, ["type", "taskDefaults"]) && isTaskDefaults(value.taskDefaults);
    case "uiLanguage.changed":
      return (
        hasExactKeys(value, ["type", "language"]) && isOneOf(value.language, ["en", "ru"] as const)
      );
    case "goal.changed":
      return (
        hasExactKeys(value, ["type", "threadId", "goal"]) &&
        isNonEmptyString(value.threadId) &&
        (value.goal === null ||
          (isThreadGoal(value.goal) && value.goal.threadId === value.threadId))
      );
    case "voiceTranscription.upserted":
      return hasExactKeys(value, ["type", "job"]) && isVoiceTranscriptionJob(value.job);
    case "voiceTranscription.removed":
      return (
        hasExactKeys(value, ["type", "threadId", "jobId", "outcome"]) &&
        isNonEmptyString(value.threadId) &&
        isNonEmptyString(value.jobId) &&
        isOneOf(value.outcome, ["draft", "send", "cancelled"] as const)
      );
    default:
      return false;
  }
}

function isApiError(value: unknown): value is ApiError["error"] {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["code", "message"]) &&
    isOneOf(value.code, [
      "unauthorized",
      "forbidden",
      "validation_failed",
      "client_update_required",
      "payload_too_large",
      "transcription_unavailable",
      "transcription_failed",
      "not_found",
      "conflict",
      "app_server_unavailable",
      "internal_error",
    ] as const) &&
    typeof value.message === "string"
  );
}

export function isCommandMetadata(value: unknown): value is CommandMetadata {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      [],
      ["commandId", "expectedThreadId", "expectedTurnId", "expectedRevision"],
    ) &&
    (!Object.prototype.hasOwnProperty.call(value, "commandId") ||
      isNonEmptyString(value.commandId)) &&
    (!Object.prototype.hasOwnProperty.call(value, "expectedThreadId") ||
      isNonEmptyString(value.expectedThreadId)) &&
    (!Object.prototype.hasOwnProperty.call(value, "expectedTurnId") ||
      isNullableNonEmptyString(value.expectedTurnId)) &&
    (!Object.prototype.hasOwnProperty.call(value, "expectedRevision") ||
      isNonNegativeInteger(value.expectedRevision))
  );
}

export function isCommandReceiptMetadata(value: unknown): value is CommandReceiptMetadata {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "commandId",
      "kind",
      "threadId",
      "turnId",
      "expectedThreadId",
      "expectedRevision",
      "payload",
    ]) &&
    isNonEmptyString(value.commandId) &&
    isNonEmptyString(value.kind) &&
    isNullableNonEmptyString(value.threadId) &&
    isNullableNonEmptyString(value.turnId) &&
    isNullableNonEmptyString(value.expectedThreadId) &&
    (value.expectedRevision === null || isNonNegativeInteger(value.expectedRevision)) &&
    isJsonValue(value.payload)
  );
}

export function isCommandReceipt(value: unknown): value is CommandReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "commandId",
      "kind",
      "status",
      "threadId",
      "turnId",
      "expectedThreadId",
      "expectedRevision",
      "payload",
      "result",
      "createdAt",
      "updatedAt",
    ]) ||
    !isCommandReceiptMetadata({
      commandId: value.commandId,
      kind: value.kind,
      threadId: value.threadId,
      turnId: value.turnId,
      expectedThreadId: value.expectedThreadId,
      expectedRevision: value.expectedRevision,
      payload: value.payload,
    }) ||
    !isOneOf(value.status, ["pending", "succeeded", "noop", "conflict", "failed"] as const) ||
    !isJsonValue(value.result) ||
    !isNonNegativeInteger(value.createdAt) ||
    !isNonNegativeInteger(value.updatedAt) ||
    value.updatedAt < value.createdAt
  ) {
    return false;
  }
  return value.status !== "pending" || value.result === null;
}

export function isClientFrame(value: unknown): value is ClientFrame {
  if (!isRecord(value) || !isNonEmptyString(value.type)) return false;
  if (value.type === "authenticate") {
    return (
      hasExactKeys(value, ["type", "protocolVersion", "token", "cursor", "threadId"]) &&
      value.protocolVersion === SYNC_PROTOCOL_VERSION &&
      isNonEmptyString(value.token) &&
      isNullableNonEmptyString(value.threadId) &&
      (value.cursor === null || isProjectionCursor(value.cursor))
    );
  }
  return value.type === "ping" && hasExactKeys(value, ["type"]);
}

export function isServerFrame(value: unknown): value is ServerFrame {
  if (!isRecord(value) || !isNonEmptyString(value.type)) return false;
  if (value.type === "snapshot") {
    return (
      hasExactKeys(value, ["type", "protocolVersion", "snapshot"]) &&
      value.protocolVersion === SYNC_PROTOCOL_VERSION &&
      isAppSnapshot(value.snapshot)
    );
  }
  if (value.type === "replay") {
    if (
      !hasExactKeys(value, [
        "type",
        "protocolVersion",
        "epoch",
        "fromRevision",
        "toRevision",
        "patches",
      ]) ||
      value.protocolVersion !== SYNC_PROTOCOL_VERSION ||
      !isNonEmptyString(value.epoch) ||
      !isNonNegativeInteger(value.fromRevision) ||
      !isNonNegativeInteger(value.toRevision) ||
      value.toRevision < value.fromRevision ||
      !Array.isArray(value.patches) ||
      value.patches.length !== value.toRevision - value.fromRevision
    ) {
      return false;
    }
    const fromRevision = value.fromRevision;
    const epoch = value.epoch;
    return value.patches.every(
      (patch, index) =>
        isRecord(patch) &&
        hasExactKeys(patch, ["revision", "event"]) &&
        patch.revision === fromRevision + index + 1 &&
        isServerEvent(patch.event) &&
        projectionEventCursorMatches(patch.event, epoch, patch.revision),
    );
  }
  if (value.type === "patch") {
    return (
      hasExactKeys(value, ["type", "protocolVersion", "epoch", "revision", "event"]) &&
      value.protocolVersion === SYNC_PROTOCOL_VERSION &&
      isNonEmptyString(value.epoch) &&
      isNonNegativeInteger(value.revision) &&
      isServerEvent(value.event) &&
      projectionEventCursorMatches(value.event, value.epoch, value.revision)
    );
  }
  if (value.type === "resync") {
    return (
      hasExactKeys(value, ["type", "protocolVersion", "snapshot"]) &&
      value.protocolVersion === SYNC_PROTOCOL_VERSION &&
      isAppSnapshot(value.snapshot)
    );
  }
  if (value.type === "thread.open") {
    return (
      hasExactKeys(value, ["type", "protocolVersion", "threadId", "detail"]) &&
      value.protocolVersion === SYNC_PROTOCOL_VERSION &&
      isNonEmptyString(value.threadId) &&
      (value.detail === null ||
        (isThreadDetail(value.detail) && value.detail.summary.id === value.threadId))
    );
  }
  if (value.type === "error") {
    return hasExactKeys(value, ["type", "error"]) && isApiError(value.error);
  }
  return value.type === "pong" && hasExactKeys(value, ["type"]);
}

function projectionEventCursorMatches(
  event: ServerEvent,
  epoch: string,
  revision: number,
): boolean {
  return (
    event.type !== "projection.replaced" ||
    (event.snapshot.epoch === epoch && event.snapshot.revision === revision)
  );
}

export function bearerHeader(token: string): string {
  return `Bearer ${token}`;
}
