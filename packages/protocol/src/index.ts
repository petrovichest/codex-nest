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

export type SkillScope = "user" | "repo" | "system" | "admin";

export type SkillCatalogItem = {
  name: string;
  displayName: string;
  description: string;
  shortDescription: string | null;
  path: string;
  scope: SkillScope;
  enabled: boolean;
};

export type SkillCatalogError = {
  path: string;
  message: string;
};

export type SkillsCatalogResponse = {
  cwd: string;
  skills: SkillCatalogItem[];
  errors: SkillCatalogError[];
};

export type UpdateSkillConfigRequest = {
  cwd: string;
  path: string;
  enabled: boolean;
};

export type UpdateSkillConfigResponse = {
  path: string;
  enabled: boolean;
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

export type BrowserThreadStatus = "disabled" | "disconnected" | "connected";

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
  browserStatus: BrowserThreadStatus;
  settings: SessionSettings;
  relation: ThreadRelation;
};

export function isActiveFeedEligible(thread: ThreadSummary): boolean {
  return (
    !thread.archived &&
    (thread.queuedMessageCount > 0 ||
      thread.state === "running" ||
      thread.state === "queued" ||
      thread.state === "needsAttention" ||
      ((thread.state === "completed" ||
        thread.state === "failed" ||
        thread.state === "interrupted") &&
        thread.unread))
  );
}

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

export type SessionArtifact = {
  id: string;
  label: string;
  path: string;
  relativePath: string;
  fileName: string;
  turnId: string;
  createdAt: number;
};

export type ThreadArtifactsResponse = {
  capability: "explicit" | "unavailable";
  artifacts: SessionArtifact[];
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
  model?: string;
  titleModel?: string;
  serviceTier?: string;
  personality?: string;
};

export type UpdateTaskDefaultsRequest = {
  model?: string | null;
  titleModel?: string | null;
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
  voiceTranscriptions?: VoiceTranscriptionJob[];
};

export type ServerEvent =
  | { type: "connection.changed"; connection: ConnectionView }
  | { type: "project.upserted"; project: Project }
  | { type: "projects.reordered"; projects: Project[] }
  | { type: "project.removed"; projectId: string }
  | { type: "thread.upserted"; thread: ThreadSummary }
  | { type: "thread.removed"; threadId: string }
  | { type: "activity.upserted"; threadId: string; turnId: string; item: ActivityItem }
  | {
      type: "activity.delta";
      threadId: string;
      turnId: string;
      itemId: string;
      activityType: "agentMessage" | "plan" | "reasoning" | "command";
      delta: string;
    }
  | { type: "turn.progressed"; threadId: string; turnId: string; progress: TurnProgress }
  | { type: "queue.changed"; threadId: string; messages: QueuedMessage[] }
  | { type: "attention.upserted"; attention: AttentionRequest }
  | { type: "attention.removed"; attentionId: string }
  | { type: "models.changed"; models: ModelOption[] }
  | { type: "skills.changed" }
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
    }
  | { type: "resync.required" };

export type ClientFrame = { type: "authenticate"; token: string } | { type: "ping" };

export type ServerFrame =
  | { type: "snapshot"; snapshot: AppSnapshot }
  | { type: "event"; sequence: number; event: ServerEvent }
  | { type: "pong" }
  | { type: "error"; error: ApiError["error"] };

export const BROWSER_EXTENSION_PROTOCOL = "codexnest.browser" as const;
export const BROWSER_EXTENSION_PROTOCOL_VERSION = 1 as const;
export const BROWSER_EXTENSION_WEBSOCKET_PATH = "/api/v1/browser-extension/events" as const;
export const BROWSER_EXTENSION_ID = "icdkmpldakkmodggmjaohfiflnakmpoj" as const;
export const BROWSER_EXTENSION_ORIGIN = `chrome-extension://${BROWSER_EXTENSION_ID}` as const;
export const BROWSER_MAX_PROJECT_FILE_BYTES = 100 * 1024 * 1024;
export const BROWSER_MAX_WEBSOCKET_MESSAGE_BYTES = 64 * 1024;
export const BROWSER_TOOL_RESULT_CHUNK_BYTES = 48 * 1024;
export const BROWSER_MAX_TOOL_RESULT_BYTES = 8 * 1024 * 1024;
export const BROWSER_MAX_TOOL_RESULT_CHUNKS = 512;

export const BROWSER_TOOL_NAMES = [
  "tabs_context",
  "tabs_create",
  "tabs_close",
  "navigate",
  "computer",
  "read_page",
  "get_page_text",
  "find",
  "form_input",
  "javascript_tool",
  "read_console_messages",
  "read_network_requests",
  "resize_window",
  "upload_file",
] as const;

export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number];

export type BrowserExtensionProjectSummary = {
  id: string;
  displayName: string;
  path: string;
};

export type BrowserExtensionThreadSummary = {
  id: string;
  projectId: string;
  title: string;
  state: ThreadState;
};

export type BrowserTabSummary = {
  id: number;
  windowId: number;
  groupId: number;
  active: boolean;
  title: string;
  url: string;
};

export type BrowserExtensionBindingSummary = {
  threadId: string;
  projectId: string;
  title: string;
  groupId: number;
  tabIds: number[];
  createdAt: number;
  updatedAt: number;
};

export type BrowserSessionTarget =
  { kind: "new"; projectId: string } | { kind: "existing"; threadId: string };

export type BrowserProjectFileTransferDescriptor = {
  kind: "project_file";
  transferId: string;
  name: string;
  mediaType: string;
  size: number;
};

export type BrowserExtensionClientFrame =
  | {
      type: "client.hello";
      protocol: typeof BROWSER_EXTENSION_PROTOCOL;
      version: number;
      token: string;
      instanceId: string;
      extensionVersion: string;
      browser: { name: "chrome"; version: string };
      capabilities: {
        tools: readonly BrowserToolName[];
        maxProjectFileBytes: number;
        screenshots: readonly string[];
      };
      bindings: BrowserExtensionBindingSummary[];
    }
  | {
      type: "session.request";
      requestId: string;
      target: BrowserSessionTarget;
      tab: BrowserTabSummary;
    }
  | {
      type: "binding.updated" | "binding.detached";
      binding: BrowserExtensionBindingSummary;
    }
  | {
      type: "tool.result";
      requestId: string;
      result: unknown;
    }
  | {
      type: "tool.result.chunk";
      requestId: string;
      chunkIndex: number;
      chunkCount: number;
      data: string;
    }
  | {
      type: "tool.error";
      requestId: string;
      error: { code: string; message: string; data?: unknown };
    }
  | { type: "file.request"; transferId: string }
  | { type: "client.ping" | "client.pong"; at: number };

export type BrowserExtensionServerFrame =
  | {
      type: "server.hello";
      protocol: typeof BROWSER_EXTENSION_PROTOCOL;
      version: typeof BROWSER_EXTENSION_PROTOCOL_VERSION;
      locale: UiLanguage;
      projects: BrowserExtensionProjectSummary[];
      threads: BrowserExtensionThreadSummary[];
    }
  | {
      type: "session.result";
      requestId: string;
      action: "created" | "attached";
      thread: BrowserExtensionThreadSummary;
    }
  | {
      type: "session.error";
      requestId: string;
      error: { code: string; message: string };
    }
  | { type: "binding.detach"; threadId: string }
  | {
      type: "tool.call";
      requestId: string;
      threadId: string;
      tool: BrowserToolName;
      arguments: unknown;
    }
  | {
      type: "file.transfer";
      transferId: string;
      chunkIndex: number;
      chunkCount: number;
      data: string;
    }
  | { type: "file.error"; transferId: string; error: string }
  | {
      type: "catalog.updated";
      projects: BrowserExtensionProjectSummary[];
      threads: BrowserExtensionThreadSummary[];
    }
  | { type: "server.ping" | "server.pong"; at: number }
  | { type: "protocol.error"; code: string; message: string };

export type CreateProjectRequest = {
  path: string;
};

export type MoveProjectRequest =
  { direction: "up" | "down"; targetIndex?: never } | { direction?: never; targetIndex: number };

export type CreateDirectoryRequest = {
  parentPath: string;
  name: string;
};

export type ForkThreadRequest = {
  lastTurnId: string;
  agentMessageId: string;
};

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
};

export type QueueMessageRequest = {
  input: string;
  images?: string[];
  goal?: boolean;
  clientMessageId?: string;
};

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

export type InterruptTurnRequest = {
  turnId?: string;
};

export type UpdateThreadRequest = {
  name?: string;
  pinned?: boolean;
};

export type MarkReadRequest = {
  observedUpdatedAt: number;
};

export type MarkViewedRequest = {
  observedUpdatedAt: number;
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

export function isBrowserToolName(value: unknown): value is BrowserToolName {
  return typeof value === "string" && (BROWSER_TOOL_NAMES as readonly string[]).includes(value);
}

export function isBrowserExtensionClientFrame(
  value: unknown,
): value is BrowserExtensionClientFrame {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "client.hello") {
    return (
      value.protocol === BROWSER_EXTENSION_PROTOCOL &&
      typeof value.version === "number" &&
      Number.isInteger(value.version) &&
      typeof value.token === "string" &&
      value.token.length > 0 &&
      isBrowserInstanceId(value.instanceId) &&
      nonEmptyString(value.extensionVersion) &&
      isRecord(value.browser) &&
      value.browser.name === "chrome" &&
      typeof value.browser.version === "string" &&
      isRecord(value.capabilities) &&
      Array.isArray(value.capabilities.tools) &&
      value.capabilities.tools.every(isBrowserToolName) &&
      typeof value.capabilities.maxProjectFileBytes === "number" &&
      Number.isFinite(value.capabilities.maxProjectFileBytes) &&
      Array.isArray(value.capabilities.screenshots) &&
      value.capabilities.screenshots.every((item) => typeof item === "string") &&
      Array.isArray(value.bindings) &&
      value.bindings.every(isBrowserExtensionBinding)
    );
  }
  if (value.type === "session.request") {
    return (
      nonEmptyString(value.requestId) &&
      isBrowserSessionTarget(value.target) &&
      isBrowserTabSummary(value.tab)
    );
  }
  if (value.type === "binding.updated" || value.type === "binding.detached") {
    return isBrowserExtensionBinding(value.binding);
  }
  if (value.type === "tool.result") {
    return nonEmptyString(value.requestId);
  }
  if (value.type === "tool.result.chunk") {
    return (
      nonEmptyString(value.requestId) &&
      Number.isInteger(value.chunkIndex) &&
      Number(value.chunkIndex) >= 0 &&
      Number.isInteger(value.chunkCount) &&
      Number(value.chunkCount) >= 1 &&
      Number(value.chunkIndex) < Number(value.chunkCount) &&
      Number(value.chunkCount) <= BROWSER_MAX_TOOL_RESULT_CHUNKS &&
      typeof value.data === "string" &&
      value.data.length <= BROWSER_TOOL_RESULT_CHUNK_BYTES
    );
  }
  if (value.type === "tool.error") {
    return (
      nonEmptyString(value.requestId) &&
      isRecord(value.error) &&
      nonEmptyString(value.error.code) &&
      nonEmptyString(value.error.message)
    );
  }
  if (value.type === "file.request") {
    return nonEmptyString(value.transferId);
  }
  if (value.type === "client.ping" || value.type === "client.pong") {
    return typeof value.at === "number" && Number.isFinite(value.at);
  }
  return false;
}

export function isBrowserExtensionServerFrame(
  value: unknown,
): value is BrowserExtensionServerFrame {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "server.hello") {
    return (
      value.protocol === BROWSER_EXTENSION_PROTOCOL &&
      value.version === BROWSER_EXTENSION_PROTOCOL_VERSION &&
      (value.locale === "en" || value.locale === "ru") &&
      Array.isArray(value.projects) &&
      value.projects.every(isBrowserProjectSummary) &&
      Array.isArray(value.threads) &&
      value.threads.every(isBrowserThreadSummary)
    );
  }
  if (value.type === "session.result") {
    return (
      nonEmptyString(value.requestId) &&
      (value.action === "created" || value.action === "attached") &&
      isBrowserThreadSummary(value.thread)
    );
  }
  if (value.type === "session.error") {
    return (
      nonEmptyString(value.requestId) &&
      isRecord(value.error) &&
      nonEmptyString(value.error.code) &&
      nonEmptyString(value.error.message)
    );
  }
  if (value.type === "binding.detach") return nonEmptyString(value.threadId);
  if (value.type === "tool.call") {
    return (
      nonEmptyString(value.requestId) &&
      nonEmptyString(value.threadId) &&
      isBrowserToolName(value.tool)
    );
  }
  if (value.type === "file.transfer") {
    return (
      nonEmptyString(value.transferId) &&
      Number.isInteger(value.chunkIndex) &&
      Number.isInteger(value.chunkCount) &&
      typeof value.data === "string"
    );
  }
  if (value.type === "file.error") {
    return nonEmptyString(value.transferId) && nonEmptyString(value.error);
  }
  if (value.type === "catalog.updated") {
    return (
      Array.isArray(value.projects) &&
      value.projects.every(isBrowserProjectSummary) &&
      Array.isArray(value.threads) &&
      value.threads.every(isBrowserThreadSummary)
    );
  }
  if (value.type === "server.ping" || value.type === "server.pong") {
    return typeof value.at === "number" && Number.isFinite(value.at);
  }
  if (value.type === "protocol.error") {
    return nonEmptyString(value.code) && nonEmptyString(value.message);
  }
  return false;
}

function isBrowserExtensionBinding(value: unknown): value is BrowserExtensionBindingSummary {
  return (
    isRecord(value) &&
    nonEmptyString(value.threadId) &&
    nonEmptyString(value.projectId) &&
    typeof value.title === "string" &&
    Number.isInteger(value.groupId) &&
    Array.isArray(value.tabIds) &&
    value.tabIds.every((tabId) => Number.isInteger(tabId) && Number(tabId) >= 0) &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt) &&
    typeof value.updatedAt === "number" &&
    Number.isFinite(value.updatedAt)
  );
}

function isBrowserSessionTarget(value: unknown): value is BrowserSessionTarget {
  return (
    isRecord(value) &&
    ((value.kind === "new" && nonEmptyString(value.projectId)) ||
      (value.kind === "existing" && nonEmptyString(value.threadId)))
  );
}

function isBrowserTabSummary(value: unknown): value is BrowserTabSummary {
  return (
    isRecord(value) &&
    Number.isInteger(value.id) &&
    Number(value.id) >= 0 &&
    Number.isInteger(value.windowId) &&
    Number.isInteger(value.groupId) &&
    typeof value.active === "boolean" &&
    typeof value.title === "string" &&
    typeof value.url === "string"
  );
}

function isBrowserProjectSummary(value: unknown): value is BrowserExtensionProjectSummary {
  return (
    isRecord(value) &&
    nonEmptyString(value.id) &&
    typeof value.displayName === "string" &&
    typeof value.path === "string"
  );
}

function isBrowserThreadSummary(value: unknown): value is BrowserExtensionThreadSummary {
  return (
    isRecord(value) &&
    nonEmptyString(value.id) &&
    nonEmptyString(value.projectId) &&
    typeof value.title === "string" &&
    typeof value.state === "string"
  );
}

function isBrowserInstanceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 200 &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function bearerHeader(token: string): string {
  return `Bearer ${token}`;
}
