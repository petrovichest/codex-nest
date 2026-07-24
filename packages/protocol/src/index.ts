export const API_PREFIX = "/api/v1";
export const EVENTS_PATH = `${API_PREFIX}/events`;

export type AppServerState = "starting" | "ready" | "unavailable" | "stopped";

export type HealthResponse = {
  status: "ok" | "degraded";
  serverVersion: string;
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

export type GitChangesSummary = {
  state: "clean" | "dirty" | "notRepository";
  filesChanged: number;
  additions: number;
  deletions: number;
};

export type CodexRateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
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
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean | null;
  operation: AppUpdateOperation;
  result: AppUpdateResult;
  message: string | null;
  checkedAt: string | null;
  updatedAt: string | null;
};

export type UpdateCodexProxyRequest = {
  proxy: string;
};

export type ApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "validation_failed"
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

export type ThreadState = "needsAttention" | "running" | ThreadOutcome | "idle" | "unavailable";

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
};

export type QueuedMessage = {
  id: string;
  threadId: string;
  text: string;
  images?: string[];
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

export type ThreadDetail = {
  summary: ThreadSummary;
  turns: TurnView[];
  queuedMessages: QueuedMessage[];
  olderTurnsCursor: string | null;
  draft?: ThreadDraft | null;
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

export type CollaborationMode = "default" | "plan";

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
  collaborationMode: "default",
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

export type AppSnapshot = {
  sequence: number;
  uiLanguage: UiLanguage;
  connection: ConnectionView;
  projects: Project[];
  threads: ThreadSummary[];
  attention: AttentionRequest[];
  models: ModelOption[];
  defaultReasoningEffort?: string;
  taskDefaults?: TaskDefaults;
  pushConfigured: boolean;
};

export type ServerEvent =
  | { type: "connection.changed"; connection: ConnectionView }
  | { type: "project.upserted"; project: Project }
  | { type: "projects.reordered"; projects: Project[] }
  | { type: "project.removed"; projectId: string }
  | { type: "thread.upserted"; thread: ThreadSummary }
  | { type: "thread.removed"; threadId: string }
  | { type: "activity.upserted"; threadId: string; turnId: string; item: ActivityItem }
  | { type: "turn.progressed"; threadId: string; turnId: string; progress: TurnProgress }
  | { type: "queue.changed"; threadId: string; messages: QueuedMessage[] }
  | { type: "attention.upserted"; attention: AttentionRequest }
  | { type: "attention.removed"; attentionId: string }
  | { type: "models.changed"; models: ModelOption[] }
  | { type: "defaultReasoningEffort.changed"; reasoningEffort: string | null }
  | { type: "taskDefaults.changed"; taskDefaults: TaskDefaults }
  | { type: "uiLanguage.changed"; language: UiLanguage }
  | { type: "goal.changed"; threadId: string; goal: ThreadGoal | null }
  | { type: "resync.required" };

export type ClientFrame = { type: "authenticate"; token: string } | { type: "ping" };

export type ServerFrame =
  | { type: "snapshot"; snapshot: AppSnapshot }
  | { type: "event"; sequence: number; event: ServerEvent }
  | { type: "pong" }
  | { type: "error"; error: ApiError["error"] };

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
};

export type CreateProjectThreadResponse = {
  thread: ThreadSummary;
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
};

export type QueueMessageRequest = {
  input: string;
  images?: string[];
  clientMessageId?: string;
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
  turnId: string;
};

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

export function isClientFrame(value: unknown): value is ClientFrame {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "authenticate")
    return typeof value.token === "string" && value.token.length > 0;
  return value.type === "ping";
}

export function isServerFrame(value: unknown): value is ServerFrame {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "snapshot") return isRecord(value.snapshot);
  if (value.type === "event") {
    return typeof value.sequence === "number" && isRecord(value.event);
  }
  if (value.type === "error") return isRecord(value.error);
  return value.type === "pong";
}

export function bearerHeader(token: string): string {
  return `Bearer ${token}`;
}
