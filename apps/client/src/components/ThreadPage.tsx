import {
  type FormEvent,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link, matchPath, Navigate, useLocation, useNavigate, useParams } from "react-router";

import { DEFAULT_SESSION_SETTINGS } from "@codexnest/protocol";
import type {
  ActivityItem,
  GitChangesSummary,
  ModelOption,
  Project,
  QueuedMessage,
  SessionSettings,
  TaskDefaults,
  ThreadDetail,
  ThreadDraft,
  ThreadSummary,
  ThreadState,
  TranscriptionConfigResponse,
  TranscriptionProvider,
  TranscriptionTimingEstimate,
  TurnProgress,
  TurnView,
  UiLanguage,
  UpdateThreadDraftRequest,
  UpdateThreadGoalRequest,
  UpdateThreadSettingsRequest,
  VoiceInputMode,
  VoiceTranscriptionMode,
  VoiceTranscriptionStatus,
} from "@codexnest/protocol";

import {
  type AnnotationDraft,
  formatAnnotatedMessage,
  loadPendingAnnotations,
  type PendingAnnotation,
  rangeOffsets,
  resolveAnnotationRange,
  savePendingAnnotations,
} from "../annotations";
import { copyText } from "../clipboard";
import { useConnection } from "../connection";
import { ApiClientError } from "../api";
import { openDownloadUrl } from "../downloads";
import { localizeKnownServerText, type Translate, useI18n } from "../i18n";
import {
  confirmLocalDraft,
  deleteLocalDraft,
  deleteNewSessionDraft,
  loadLocalDraft,
  loadNewSessionDraft,
  saveLocalDraft,
  saveNewSessionDraft,
} from "../offline-store";
import { acknowledgePendingThread, releaseActiveThread } from "../push";
import type { OptimisticMessage } from "../state";
import { AttentionPanel } from "./AttentionPanel";
import { Composer, type ComposerImage, type ComposerRecording } from "./Composer";
import {
  ArchiveIcon,
  ArrowDownIcon,
  CheckIcon,
  CopyIcon,
  FileIcon,
  MoreIcon,
  MicrophoneIcon,
  NewTaskIcon,
  PencilIcon,
  PinIcon,
  RefreshIcon,
  SendIcon,
  TeamIcon,
  TerminalIcon,
  ToolIcon,
  TrashIcon,
  XIcon,
} from "./Icons";
import { ImageViewer } from "./ImageViewer";
import { NewSessionInspector, SessionInspector, type GitChangesView } from "./SessionInspector";
import { WorkspaceHeader } from "./WorkspaceHeader";

type ComposerDraftState = {
  threadId: string;
  value: UpdateThreadDraftRequest;
};

type NewSessionPreparation = {
  active: boolean;
  projectId: string;
  value: UpdateThreadDraftRequest;
  settings: SessionSettings;
  phase: "creating" | "transferring";
  threadId: string | null;
  thread: ThreadSummary | null;
  revision: number;
};

type EarlySubmission = {
  attachmentScope: number;
  clearedRevision: number;
  draft: UpdateThreadDraftRequest;
  editRevision: number;
};

type PreparationDraftTransfer = {
  generation: number;
  promise: Promise<ThreadDraft | null>;
  revision: number;
  serverWriteStarted: boolean;
};

type AcceptedDraftClearGuard = {
  editRevision: number;
  generation: number;
  pendingRevision: number;
};

type PendingSettingsField = keyof UpdateThreadSettingsRequest;

type QueueAction = {
  messageId: string;
  kind: "send" | "update" | "delete";
};

type QueuedMessageView = QueuedMessage & {
  confirmed: boolean;
};

type VoiceUploadState = {
  mode: VoiceTranscriptionMode;
  startedAt: number;
};

type VoiceProgress = {
  status: "uploading" | Exclude<VoiceTranscriptionStatus, "failed">;
  elapsedSeconds: number;
  estimatedTotalSeconds: number | null;
};

function emptyComposerDraft(): UpdateThreadDraftRequest {
  return { input: "", images: [], goalMode: false, annotations: [] };
}

function composerDraftHasContent(value: UpdateThreadDraftRequest): boolean {
  return (
    Boolean(value.input) ||
    value.images.length > 0 ||
    value.goalMode ||
    value.annotations.length > 0
  );
}

function normalizeNewSessionDraft(value: UpdateThreadDraftRequest): UpdateThreadDraftRequest {
  return structuredClone(value);
}

export function initialSessionSettings(
  defaultReasoningEffort: string | undefined,
  models: ModelOption[],
  taskDefaults?: TaskDefaults,
): SessionSettings {
  const settings = { ...DEFAULT_SESSION_SETTINGS, ...(taskDefaults ?? {}) };
  const model = models.find((candidate) => candidate.isDefault) ?? models[0];
  if (
    defaultReasoningEffort &&
    (!model || model.reasoningEfforts.some((option) => option.value === defaultReasoningEffort))
  ) {
    settings.reasoningEffort = defaultReasoningEffort;
  }
  return settings;
}

function applySessionSettingsPatch(
  current: SessionSettings,
  patch: UpdateThreadSettingsRequest,
): SessionSettings {
  const next = { ...current };
  if (patch.collaborationMode !== undefined) {
    next.collaborationMode = patch.collaborationMode;
  }
  for (const key of ["model", "reasoningEffort", "serviceTier", "personality"] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

function settingsPatchBetween(
  current: SessionSettings,
  target: SessionSettings,
  touched: ReadonlySet<PendingSettingsField>,
): UpdateThreadSettingsRequest {
  const patch: UpdateThreadSettingsRequest = {};
  if (touched.has("collaborationMode") && current.collaborationMode !== target.collaborationMode) {
    patch.collaborationMode = target.collaborationMode;
  }
  for (const key of ["model", "reasoningEffort", "serviceTier", "personality"] as const) {
    if (!touched.has(key) || current[key] === target[key]) continue;
    patch[key] = target[key] ?? null;
  }
  return patch;
}

function mergeComposerImages(
  first: readonly ComposerImage[],
  second: readonly ComposerImage[],
): ComposerImage[] {
  const merged = [...first];
  const known = new Set(first.map((image) => image.id || image.url));
  for (const image of second) {
    const key = image.id || image.url;
    if (known.has(key)) continue;
    known.add(key);
    merged.push(image);
  }
  return merged;
}

function mergeComposerDrafts(
  submitted: UpdateThreadDraftRequest,
  newer: UpdateThreadDraftRequest,
): UpdateThreadDraftRequest {
  const submittedInput = submitted.input.trimEnd();
  const newerInput = newer.input.trimStart();
  const input =
    !submittedInput || !newerInput || submittedInput === newerInput
      ? submittedInput || newerInput
      : `${submittedInput}\n\n${newerInput}`;
  const annotationIds = new Set(submitted.annotations.map((annotation) => annotation.id));
  return {
    input,
    images: mergeComposerImages(submitted.images, newer.images),
    goalMode: newer.goalMode || (!newerInput && submitted.goalMode),
    annotations: [
      ...submitted.annotations,
      ...newer.annotations.filter((annotation) => !annotationIds.has(annotation.id)),
    ],
  };
}

const PREPARATION_SUPERSEDED = Symbol("preparation superseded");

function pendingThreadSummary(project: Project, settings: SessionSettings): ThreadSummary {
  return {
    id: "",
    projectId: project.id,
    title: "Новая задача",
    preview: "",
    cwd: project.path,
    state: "idle",
    unread: false,
    unseen: false,
    pinned: false,
    archived: false,
    createdAt: 0,
    updatedAt: 0,
    currentTurnId: null,
    queuedMessageCount: 0,
    settings,
    relation: { kind: "session", sessionId: "" },
  };
}

const VOICE_INPUT_MODE_KEY = "codexnest.voiceInputMode";
const COMPLETED_CHAT_RETRY_MS = 500;
const TAIL_FOLLOW_THRESHOLD_PX = 120;
const DRAFT_SAVE_DELAY_MS = 500;

function readVoiceInputMode(): VoiceInputMode {
  return localStorage.getItem(VOICE_INPUT_MODE_KEY) === "send" ? "send" : "draft";
}

function resolveVoiceTranscriptionMode(
  preference: VoiceInputMode,
  currentTurnId: string | null,
): VoiceTranscriptionMode {
  if (!currentTurnId) return preference;
  return preference === "send" ? "steer" : "queue";
}

export function ThreadPage({
  projects,
  transcriptionConfig = null,
  transcriptionProvider = null,
  onTranscriptionTimingEstimateChange,
  onOpenNavigation,
}: {
  projects?: Project[];
  transcriptionConfig?: TranscriptionConfigResponse | null;
  transcriptionProvider?: TranscriptionProvider | null;
  onTranscriptionTimingEstimateChange?(estimate: TranscriptionTimingEstimate): void;
  onOpenNavigation(): void;
}) {
  const { threadId: parameterThreadId = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const newSessionRoute = location.pathname === "/new";
  const requestedProjectId = newSessionRoute
    ? (new URLSearchParams(location.search).get("projectId") ?? "")
    : "";
  const initialNewSessionRef = useRef({
    active: newSessionRoute,
    projectId: requestedProjectId,
    workspaceId:
      typeof (location.state as { newSessionWorkspaceId?: unknown } | null)
        ?.newSessionWorkspaceId === "string"
        ? (
            location.state as {
              newSessionWorkspaceId: string;
            }
          ).newSessionWorkspaceId
        : `direct:${location.search}`,
    admitted:
      (location.state as { newSessionProjectId?: unknown } | null)?.newSessionProjectId ===
      requestedProjectId,
  });
  const [createdThreadId, setCreatedThreadId] = useState<string | null>(null);
  const matchedThreadId = matchPath("/threads/:threadId", location.pathname)?.params.threadId ?? "";
  const threadId = parameterThreadId || matchedThreadId || createdThreadId || "";
  const { language, t } = useI18n();
  const languageRef = useRef(language);
  languageRef.current = language;
  const {
    api,
    state,
    dispatch,
    refreshDetail,
    forceRefreshDetail,
    loadOlderDetail,
    loadTurnItems,
    sendReliable,
    queueVoiceRecording,
  } = useConnection();
  const activeThreadIdRef = useRef(threadId);
  activeThreadIdRef.current = threadId;
  const availableProjects = projects ?? state.snapshot?.projects ?? [];
  const newSessionProject =
    availableProjects.find(
      (candidate) => candidate.id === initialNewSessionRef.current.projectId,
    ) ?? null;
  const [newSessionAdmitted, setNewSessionAdmitted] = useState(
    initialNewSessionRef.current.admitted,
  );
  const [newSessionRejected, setNewSessionRejected] = useState(false);
  const [newSessionHydrated, setNewSessionHydrated] = useState(
    !initialNewSessionRef.current.active,
  );
  const [preparationWorking, setPreparationWorking] = useState(false);
  const [preparationRetry, setPreparationRetry] = useState(0);
  const [storageWarning, setStorageWarning] = useState(false);
  const [pendingSettings, setPendingSettings] = useState<SessionSettings>(() =>
    initialSessionSettings(
      state.snapshot?.defaultReasoningEffort,
      state.snapshot?.models ?? [],
      state.snapshot?.taskDefaults,
    ),
  );
  const pendingSettingsRef = useRef(pendingSettings);
  const preparationRef = useRef<NewSessionPreparation>({
    active: initialNewSessionRef.current.active,
    projectId: initialNewSessionRef.current.projectId,
    value: emptyComposerDraft(),
    settings: pendingSettings,
    phase: "creating",
    threadId: null,
    thread: null,
    revision: 0,
  });
  const pendingSettingsRevisionRef = useRef(0);
  const pendingSettingsTouchedRef = useRef(new Set<PendingSettingsField>());
  const appliedSettingsRevisionRef = useRef(0);
  const settingsApplyPromiseRef = useRef<Promise<ThreadSummary> | null>(null);
  const creationPromiseRef = useRef<Promise<ThreadSummary> | null>(null);
  const preparationOperationRef = useRef<Promise<void> | null>(null);
  const preparationGenerationRef = useRef(1);
  const preparationAliveRef = useRef(true);
  const preparationDiscardRef = useRef(false);
  const preparationDraftTouchedRef = useRef(false);
  const preparationDraftTimerRef = useRef<number | null>(null);
  const preparationDraftSaveChainRef = useRef<Promise<void>>(Promise.resolve());
  const [attachmentScope, setAttachmentScope] = useState(0);
  const attachmentScopeRef = useRef(attachmentScope);
  const pendingAttachmentScopesRef = useRef(new Set<number>());
  const attachmentWaitersRef = useRef(new Set<{ scope: number | null; resolve: () => void }>());
  const earlySubmitRef = useRef(false);
  const preparationClaimedForSubmitRef = useRef(false);
  const preparationDraftTransferGenerationRef = useRef(0);
  const activePreparationDraftTransferRef = useRef<PreparationDraftTransfer | null>(null);
  const claimedPreparationDraftTransferRef = useRef<PreparationDraftTransfer | null>(null);
  const earlySubmissionRef = useRef<EarlySubmission | null>(null);
  const composerEditRevisionRef = useRef(0);
  const createdInWorkspaceRef = useRef<string | null>(null);
  const [pendingOptimisticMessage, setPendingOptimisticMessage] =
    useState<OptimisticMessage | null>(null);
  const detail = state.details?.[threadId];
  const summary = reconcileVisibleThreadSummary(
    state.snapshot?.threads.find((thread) => thread.id === threadId),
    detail,
  );
  const parentThreadId =
    summary?.relation.kind === "subagent" ? summary.relation.parentThreadId : null;
  const isSubagent = parentThreadId !== null;
  const parentSummary = parentThreadId
    ? state.snapshot?.threads.find((thread) => thread.id === parentThreadId)
    : undefined;
  const project =
    newSessionProject ??
    state.snapshot?.projects.find((candidate) => candidate.id === summary?.projectId) ??
    null;
  const [composerDraftState, setComposerDraftState] = useState<ComposerDraftState>(() => ({
    threadId,
    value: detail?.draft
      ? {
          input: detail.draft.input,
          images: detail.draft.images,
          goalMode: detail.draft.goalMode,
          annotations: detail.draft.annotations,
        }
      : emptyComposerDraft(),
  }));
  const activeComposerDraft =
    composerDraftState.threadId === threadId ? composerDraftState.value : emptyComposerDraft();
  const { input, images, goalMode, annotations } = activeComposerDraft;
  const [goalBusy, setGoalBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [queueAction, setQueueAction] = useState<QueueAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [teamUpgradeRequired, setTeamUpgradeRequired] = useState(false);
  const [threadMissing, setThreadMissing] = useState(false);
  const [voiceMode, setVoiceMode] = useState<VoiceInputMode>(readVoiceInputMode);
  const voiceModeRef = useRef(voiceMode);
  voiceModeRef.current = voiceMode;
  const currentTurnIdRef = useRef(summary?.currentTurnId ?? null);
  currentTurnIdRef.current = summary?.currentTurnId ?? null;
  const [voiceUploads, setVoiceUploads] = useState<Record<string, VoiceUploadState>>({});
  const localVoiceJobIdsRef = useRef(new Set<string>());
  const [voiceCancellationPending, setVoiceCancellationPending] = useState(false);
  const [transcriptionElapsedSeconds, setTranscriptionElapsedSeconds] = useState(0);
  const handledVoiceRemovalsRef = useRef(new Set<string>());
  const [renaming, setRenaming] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialScrollThread = useRef<string | null>(null);
  const followsTail = useRef(true);
  const locationNoticeHandled = useRef<string | null>(null);
  const detailReconcileKey = useRef<string | null>(null);
  const completedChatRetry = useRef<{
    key: string;
    timer: number | null;
  } | null>(null);
  const scrollTargetMessageId = useRef<string | null>(null);
  const olderScrollAnchor = useRef<{
    threadId: string;
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [gitChangesState, setGitChangesState] = useState<{
    threadId: string;
    value: GitChangesView;
  } | null>(null);
  const gitChangesRequest = useRef(0);
  const composerDraftRef = useRef<ComposerDraftState>(composerDraftState);
  const draftTimerRef = useRef<{ threadId: string; timer: number } | null>(null);
  const pendingDraftsRef = useRef(
    new Map<
      string,
      { revision: number; value: UpdateThreadDraftRequest; localUpdatedAt: number }
    >(),
  );
  const savedDraftUpdatedAtRef = useRef(new Map<string, number | null>());
  const draftRevisionRef = useRef(0);
  const draftSaveChainRef = useRef<Promise<void>>(Promise.resolve());
  const draftTouchedThreadsRef = useRef(new Set<string>());
  const hydratedDraftSourcesRef = useRef(new Map<string, ThreadDraft | null>());
  const legacyAnnotationThreadsRef = useRef(new Set<string>());
  const annotationActionsRef = useRef<{
    create(draft: AnnotationDraft): boolean;
    update(annotationId: string, comment: string): boolean;
    delete(annotationId: string): boolean;
  } | null>(null);
  const createAnnotationEvent = useCallback(
    (draft: AnnotationDraft) => annotationActionsRef.current?.create(draft) ?? false,
    [],
  );
  const updateAnnotationEvent = useCallback(
    (annotationId: string, comment: string) =>
      annotationActionsRef.current?.update(annotationId, comment) ?? false,
    [],
  );
  const deleteAnnotationEvent = useCallback(
    (annotationId: string) => annotationActionsRef.current?.delete(annotationId) ?? false,
    [],
  );
  const attention = useMemo(
    () => state.snapshot?.attention?.filter((item) => item.threadId === threadId) ?? [],
    [state.snapshot?.attention, threadId],
  );
  const goal = state.goals?.[threadId];
  const voiceJob =
    state.snapshot?.voiceTranscriptions?.find((job) => job.threadId === threadId) ?? null;
  const voiceRemoval = state.voiceRemovals?.[threadId];
  const activeVoiceJob = voiceJob?.status === "failed" ? null : voiceJob;
  const localActiveVoiceJob =
    activeVoiceJob && localVoiceJobIdsRef.current.has(activeVoiceJob.id) ? activeVoiceJob : null;
  const voiceUpload = voiceUploads[threadId] ?? null;
  const optimisticMessages = state.optimisticMessages?.[threadId] ?? [];
  const optimisticTurnMessages = optimisticMessages.filter(
    (message) => message.destination === "turn",
  );
  const optimisticQueuedMessages = optimisticMessages.filter(
    (message) => message.destination === "queue",
  );
  const groupedTurnActivities = useMemo(
    () =>
      new Map(
        (detail?.turns ?? []).map(
          (turn) =>
            [
              turn.id,
              groupActivities(
                activitiesForThreadDisplay(turn.items, isSubagent).filter(
                  (item) => !isTechnicalActivity(item),
                ),
              ),
            ] as const,
        ),
      ),
    [detail?.turns, isSubagent],
  );
  const technicalTurnActivities = useMemo(
    () =>
      new Map(
        (detail?.turns ?? []).map(
          (turn) => [turn.id, isSubagent ? [] : turn.items.filter(isTechnicalActivity)] as const,
        ),
      ),
    [detail?.turns, isSubagent],
  );
  const voiceMessageMaterialized = activeVoiceJob
    ? hasMaterializedVoiceMessage(detail, optimisticMessages, activeVoiceJob.id)
    : false;
  const draftVoiceProgress: VoiceProgress | null =
    localActiveVoiceJob?.mode === "draft"
      ? {
          status: localActiveVoiceJob.status as Exclude<VoiceTranscriptionStatus, "failed">,
          elapsedSeconds: transcriptionElapsedSeconds,
          estimatedTotalSeconds: localActiveVoiceJob.estimatedTotalSeconds,
        }
      : voiceUpload?.mode === "draft"
        ? {
            status: "uploading",
            elapsedSeconds: transcriptionElapsedSeconds,
            estimatedTotalSeconds: null,
          }
        : null;
  const autoVoiceProgress: VoiceProgress | null =
    activeVoiceJob && activeVoiceJob.mode !== "draft" && !voiceMessageMaterialized
      ? {
          status: activeVoiceJob.status as Exclude<VoiceTranscriptionStatus, "failed">,
          elapsedSeconds: transcriptionElapsedSeconds,
          estimatedTotalSeconds: activeVoiceJob.estimatedTotalSeconds,
        }
      : voiceUpload && voiceUpload.mode !== "draft"
        ? {
            status: "uploading",
            elapsedSeconds: transcriptionElapsedSeconds,
            estimatedTotalSeconds: null,
          }
        : null;
  const autoVoiceProgressKey = autoVoiceProgress
    ? `${activeVoiceJob?.id ?? `upload:${threadId}`}:${autoVoiceProgress.status}`
    : null;
  const activeProgress = summary?.currentTurnId
    ? detail?.turns.find((turn) => turn.id === summary.currentTurnId)?.progress
    : undefined;
  const gitChangesRefreshKey = summary?.currentTurnId
    ? [
        summary.currentTurnId,
        activeProgress?.filesChanged ?? 0,
        activeProgress?.additions ?? 0,
        activeProgress?.deletions ?? 0,
      ].join(":")
    : "idle";

  const downloadFile = useCallback(
    async (path: string) => {
      const ticket = await api.createDownload(threadId, path);
      await openDownloadUrl(api.settings.baseUrl, ticket.downloadUrl);
    },
    [api, threadId],
  );

  function snapshotPreparation(): NewSessionPreparation {
    const current = preparationRef.current;
    const claimedDraft = earlySubmissionRef.current?.draft;
    return {
      ...current,
      value: structuredClone(
        claimedDraft
          ? composerDraftHasContent(current.value)
            ? mergeComposerDrafts(claimedDraft, current.value)
            : claimedDraft
          : current.value,
      ),
      settings: structuredClone(current.settings),
    };
  }

  function preparationGenerationActive(generation: number): boolean {
    return (
      preparationAliveRef.current &&
      preparationGenerationRef.current === generation &&
      preparationRef.current.active &&
      !preparationDiscardRef.current
    );
  }

  function assertPreparationGeneration(generation: number): void {
    if (!preparationGenerationActive(generation)) throw PREPARATION_SUPERSEDED;
  }

  function invalidatePreparation(): void {
    preparationAliveRef.current = false;
    preparationGenerationRef.current += 1;
    for (const waiter of attachmentWaitersRef.current) waiter.resolve();
    attachmentWaitersRef.current.clear();
  }

  function enqueuePreparationSave(snapshot: NewSessionPreparation): Promise<void> {
    const request = preparationDraftSaveChainRef.current
      .catch(() => undefined)
      .then(async () => {
        const saved = await saveNewSessionDraft(api.settings, snapshot.projectId, snapshot.value, {
          phase: snapshot.phase,
          threadId: snapshot.threadId,
          thread: snapshot.thread,
          revision: snapshot.revision,
          settings: snapshot.settings,
        });
        if (!saved && preparationAliveRef.current) setStorageWarning(true);
      });
    preparationDraftSaveChainRef.current = request;
    return request;
  }

  function flushPreparation(): Promise<void> {
    if (preparationDraftTimerRef.current !== null) {
      window.clearTimeout(preparationDraftTimerRef.current);
      preparationDraftTimerRef.current = null;
    }
    if (!preparationRef.current.active || !newSessionAdmitted || preparationDiscardRef.current) {
      return preparationDraftSaveChainRef.current;
    }
    return enqueuePreparationSave(snapshotPreparation());
  }

  function setPendingAttachments(pending: boolean, scope = attachmentScopeRef.current): void {
    if (pending) {
      pendingAttachmentScopesRef.current.add(scope);
      return;
    }
    pendingAttachmentScopesRef.current.delete(scope);
    for (const waiter of attachmentWaitersRef.current) {
      if (waiter.scope !== null && pendingAttachmentScopesRef.current.has(waiter.scope)) {
        continue;
      }
      if (waiter.scope === null && pendingAttachmentScopesRef.current.size > 0) continue;
      attachmentWaitersRef.current.delete(waiter);
      waiter.resolve();
    }
  }

  function waitForPendingAttachments(scope: number | null = null): Promise<void> {
    if (
      scope === null
        ? pendingAttachmentScopesRef.current.size === 0
        : !pendingAttachmentScopesRef.current.has(scope)
    ) {
      return Promise.resolve();
    }
    return new Promise((resolve) => attachmentWaitersRef.current.add({ scope, resolve }));
  }

  function replacePreparationDraft(value: UpdateThreadDraftRequest): void {
    preparationDraftTouchedRef.current = true;
    preparationRef.current = {
      ...preparationRef.current,
      value,
      revision: preparationRef.current.revision + 1,
    };
    const next = { threadId, value };
    composerDraftRef.current = next;
    setComposerDraftState(next);
  }

  function preparationDraftTransferActive(transfer: PreparationDraftTransfer): boolean {
    return (
      preparationDraftTransferGenerationRef.current === transfer.generation &&
      !preparationClaimedForSubmitRef.current &&
      preparationRef.current.active &&
      !preparationDiscardRef.current &&
      preparationRef.current.revision === transfer.revision &&
      pendingAttachmentScopesRef.current.size === 0
    );
  }

  function transferPreparationDraft(
    targetThreadId: string,
    value: UpdateThreadDraftRequest,
  ): Promise<ThreadDraft | null> {
    const transfer: PreparationDraftTransfer = {
      generation: preparationDraftTransferGenerationRef.current,
      promise: Promise.resolve(null),
      revision: preparationRef.current.revision,
      serverWriteStarted: false,
    };
    const request = (async () => {
      if (!preparationDraftTransferActive(transfer)) return null;
      await saveLocalDraft(api.settings, targetThreadId, value, Date.now());
      if (!preparationDraftTransferActive(transfer)) return null;
      transfer.serverWriteStarted = true;
      try {
        const saved = await api.updateThreadDraft(targetThreadId, value, { retry: true });
        if (!preparationDraftTransferActive(transfer)) return saved;
        if (saved) {
          await saveLocalDraft(api.settings, targetThreadId, value, saved.updatedAt);
        } else {
          await deleteLocalDraft(api.settings, targetThreadId);
        }
        return saved;
      } catch (caught) {
        if (!preparationDraftTransferActive(transfer)) return null;
        throw caught;
      }
    })().finally(() => {
      if (activePreparationDraftTransferRef.current === transfer) {
        activePreparationDraftTransferRef.current = null;
      }
    });
    transfer.promise = request;
    activePreparationDraftTransferRef.current = transfer;
    return request;
  }

  async function settleClaimedPreparationDraftTransfer(): Promise<boolean> {
    const transfer = claimedPreparationDraftTransferRef.current;
    if (!transfer) return false;
    await transfer.promise.catch(() => undefined);
    if (claimedPreparationDraftTransferRef.current === transfer) {
      claimedPreparationDraftTransferRef.current = null;
    }
    return transfer.serverWriteStarted;
  }

  async function ensureCreatedThread(
    activeProject: Project,
    generation: number,
  ): Promise<ThreadSummary> {
    assertPreparationGeneration(generation);
    const prepared = preparationRef.current.thread;
    if (prepared) return prepared;
    if (!creationPromiseRef.current) {
      const request = (async () => {
        assertPreparationGeneration(generation);
        const existingThreadId = preparationRef.current.threadId;
        let thread = existingThreadId
          ? state.snapshot?.threads.find((candidate) => candidate.id === existingThreadId)
          : undefined;
        if (!thread) {
          thread = existingThreadId
            ? (await api.readThread(existingThreadId, undefined, { fresh: true })).summary
            : (await api.createProjectThread(activeProject.id)).thread;
          assertPreparationGeneration(generation);
        }
        preparationRef.current = {
          ...preparationRef.current,
          phase: "transferring",
          threadId: thread.id,
          thread,
        };
        await enqueuePreparationSave(snapshotPreparation());
        assertPreparationGeneration(generation);
        return thread;
      })();
      creationPromiseRef.current = request;
      void request.catch(() => {
        if (creationPromiseRef.current === request) creationPromiseRef.current = null;
      });
    }
    const thread = await creationPromiseRef.current;
    assertPreparationGeneration(generation);
    return thread;
  }

  async function applyPendingSettings(
    thread: ThreadSummary,
    generation: number,
  ): Promise<ThreadSummary> {
    assertPreparationGeneration(generation);
    if (settingsApplyPromiseRef.current) {
      await settingsApplyPromiseRef.current;
      assertPreparationGeneration(generation);
      return applyPendingSettings(preparationRef.current.thread ?? thread, generation);
    }
    if (appliedSettingsRevisionRef.current === pendingSettingsRevisionRef.current) {
      return preparationRef.current.thread ?? thread;
    }
    const request = (async () => {
      let configured = preparationRef.current.thread ?? thread;
      while (appliedSettingsRevisionRef.current !== pendingSettingsRevisionRef.current) {
        assertPreparationGeneration(generation);
        const revision = pendingSettingsRevisionRef.current;
        const patch = settingsPatchBetween(
          configured.settings,
          pendingSettingsRef.current,
          pendingSettingsTouchedRef.current,
        );
        if (Object.keys(patch).length > 0) {
          configured = await api.updateThreadSettings(thread.id, patch);
          assertPreparationGeneration(generation);
          preparationRef.current = { ...preparationRef.current, thread: configured };
        }
        appliedSettingsRevisionRef.current = revision;
      }
      return configured;
    })();
    settingsApplyPromiseRef.current = request;
    try {
      return await request;
    } finally {
      if (settingsApplyPromiseRef.current === request) {
        settingsApplyPromiseRef.current = null;
      }
    }
  }

  function activateCreatedThread(
    thread: ThreadSummary,
    draft: ThreadDraft | null,
    generation: number,
  ): boolean {
    if (!preparationGenerationActive(generation)) return false;
    const targetThreadId = thread.id;
    preparationDiscardRef.current = true;
    preparationRef.current = {
      ...preparationRef.current,
      active: false,
      threadId: targetThreadId,
      thread,
    };
    activeThreadIdRef.current = targetThreadId;
    createdInWorkspaceRef.current = targetThreadId;
    draftTouchedThreadsRef.current.add(targetThreadId);
    hydratedDraftSourcesRef.current.set(targetThreadId, draft);
    const value = composerDraftRef.current.value;
    const next = { threadId: targetThreadId, value };
    composerDraftRef.current = next;
    setComposerDraftState(next);
    setCreatedThreadId(targetThreadId);
    if (!preparationAliveRef.current || preparationGenerationRef.current !== generation) {
      return false;
    }
    dispatch({ type: "thread", thread });
    dispatch({
      type: "detail",
      detail: {
        summary: thread,
        turns: [],
        queuedMessages: [],
        olderTurnsCursor: null,
        draft,
      },
      page: "latest",
    });
    if (!preparationAliveRef.current || preparationGenerationRef.current !== generation) {
      return false;
    }
    navigate(`/threads/${encodeURIComponent(targetThreadId)}`, {
      replace: true,
      state: {
        ...(typeof location.state === "object" && location.state ? location.state : {}),
        focusComposer: true,
        newSessionWorkspaceId: initialNewSessionRef.current.workspaceId,
      },
    });
    return true;
  }

  async function finishNewSessionPreparation(
    activeProject: Project,
    generation: number,
  ): Promise<void> {
    let thread = await ensureCreatedThread(activeProject, generation);
    assertPreparationGeneration(generation);
    thread = await applyPendingSettings(thread, generation);
    assertPreparationGeneration(generation);
    preparationRef.current = { ...preparationRef.current, thread };
    if (preparationClaimedForSubmitRef.current) return;

    while (true) {
      await waitForPendingAttachments();
      assertPreparationGeneration(generation);
      if (preparationClaimedForSubmitRef.current) return;
      const transferring = snapshotPreparation();
      const hasDraft =
        Boolean(transferring.value.input) ||
        transferring.value.images.length > 0 ||
        transferring.value.goalMode ||
        transferring.value.annotations.length > 0;
      const saved = hasDraft ? await transferPreparationDraft(thread.id, transferring.value) : null;
      assertPreparationGeneration(generation);
      if (
        preparationClaimedForSubmitRef.current ||
        pendingAttachmentScopesRef.current.size > 0 ||
        preparationRef.current.revision !== transferring.revision
      ) {
        continue;
      }

      await flushPreparation();
      assertPreparationGeneration(generation);
      if (
        preparationClaimedForSubmitRef.current ||
        pendingAttachmentScopesRef.current.size > 0 ||
        preparationRef.current.revision !== transferring.revision
      ) {
        continue;
      }
      await deleteNewSessionDraft(api.settings, activeProject.id);
      assertPreparationGeneration(generation);
      if (
        preparationClaimedForSubmitRef.current ||
        pendingAttachmentScopesRef.current.size > 0 ||
        preparationRef.current.revision !== transferring.revision
      ) {
        continue;
      }

      thread = await applyPendingSettings(thread, generation);
      assertPreparationGeneration(generation);
      preparationRef.current = { ...preparationRef.current, thread };
      activateCreatedThread(thread, saved, generation);
      return;
    }
  }

  function currentComposerDraft(
    targetThreadId = activeThreadIdRef.current,
  ): UpdateThreadDraftRequest {
    return composerDraftRef.current.threadId === targetThreadId
      ? composerDraftRef.current.value
      : emptyComposerDraft();
  }

  function persistPendingDraft(targetThreadId: string, keepalive = false): Promise<void> {
    if (!pendingDraftsRef.current.has(targetThreadId)) return draftSaveChainRef.current;
    const request = draftSaveChainRef.current
      .catch(() => undefined)
      .then(async () => {
        const pending = pendingDraftsRef.current.get(targetThreadId);
        if (!pending) return;
        try {
          const saved = await api.updateThreadDraft(targetThreadId, pending.value, { keepalive });
          if (pendingDraftsRef.current.get(targetThreadId)?.revision !== pending.revision) return;
          pendingDraftsRef.current.delete(targetThreadId);
          await confirmLocalDraft(api.settings, targetThreadId, saved, pending.localUpdatedAt);
          savedDraftUpdatedAtRef.current.set(targetThreadId, saved?.updatedAt ?? null);
          dispatch({ type: "draft", threadId: targetThreadId, draft: saved });
          if (legacyAnnotationThreadsRef.current.delete(targetThreadId)) {
            try {
              savePendingAnnotations(targetThreadId, []);
            } catch {
              // The server copy is authoritative once it has been accepted.
            }
          }
        } catch {
          if (pendingDraftsRef.current.has(targetThreadId) && !draftTimerRef.current) {
            const timer = window.setTimeout(() => {
              if (draftTimerRef.current?.timer === timer) draftTimerRef.current = null;
              void persistPendingDraft(targetThreadId);
            }, 5_000);
            draftTimerRef.current = { threadId: targetThreadId, timer };
          }
        }
      });
    draftSaveChainRef.current = request;
    return request;
  }

  function scheduleDraftSave(
    targetThreadId: string,
    value: UpdateThreadDraftRequest,
    immediate: boolean,
  ): void {
    const revision = ++draftRevisionRef.current;
    const localUpdatedAt = Date.now();
    pendingDraftsRef.current.set(targetThreadId, { revision, value, localUpdatedAt });
    void saveLocalDraft(api.settings, targetThreadId, value, localUpdatedAt);
    if (draftTimerRef.current) {
      window.clearTimeout(draftTimerRef.current.timer);
      draftTimerRef.current = null;
    }
    if (immediate) {
      void persistPendingDraft(targetThreadId);
      return;
    }
    const timer = window.setTimeout(() => {
      if (draftTimerRef.current?.timer === timer) draftTimerRef.current = null;
      void persistPendingDraft(targetThreadId);
    }, 500);
    draftTimerRef.current = { threadId: targetThreadId, timer };
  }

  function replaceComposerDraft(
    value: UpdateThreadDraftRequest,
    persistence: "debounced" | "immediate" | false,
  ): void {
    if (preparationRef.current.active) {
      replacePreparationDraft(value);
      return;
    }
    const targetThreadId = activeThreadIdRef.current;
    const next = { threadId: targetThreadId, value };
    composerDraftRef.current = next;
    setComposerDraftState(next);
    if (!persistence) return;
    draftTouchedThreadsRef.current.add(targetThreadId);
    scheduleDraftSave(targetThreadId, value, persistence === "immediate");
  }

  function setInput(value: string): void {
    composerEditRevisionRef.current += 1;
    replaceComposerDraft({ ...currentComposerDraft(), input: value }, "debounced");
  }

  function setImages(value: ComposerImage[], sourceScope = attachmentScopeRef.current): void {
    if (preparationRef.current.active && earlySubmitRef.current) {
      const submission = earlySubmissionRef.current;
      if (submission && sourceScope === submission.attachmentScope) {
        submission.draft = {
          ...submission.draft,
          images: mergeComposerImages(submission.draft.images, value),
        };
        setPendingOptimisticMessage((message) =>
          message
            ? { ...message, images: submission.draft.images.map((image) => image.url) }
            : message,
        );
        return;
      }
    }
    composerEditRevisionRef.current += 1;
    replaceComposerDraft({ ...currentComposerDraft(), images: value }, "immediate");
  }

  function setGoalMode(value: boolean): void {
    const current = currentComposerDraft();
    if (current.goalMode === value) return;
    composerEditRevisionRef.current += 1;
    replaceComposerDraft({ ...current, goalMode: value }, "immediate");
  }

  function flushDraft(targetThreadId = threadId, keepalive = false): Promise<void> {
    if (draftTimerRef.current?.threadId === targetThreadId) {
      window.clearTimeout(draftTimerRef.current.timer);
      draftTimerRef.current = null;
    }
    return persistPendingDraft(targetThreadId, keepalive);
  }

  async function beginTranscription(
    targetThreadId: string,
    recording: ComposerRecording,
  ): Promise<void> {
    if (!transcriptionProvider || activeVoiceJob || voiceUploads[targetThreadId]) return;
    const uploadMode = resolveVoiceTranscriptionMode(
      voiceModeRef.current,
      currentTurnIdRef.current,
    );
    setVoiceUploads((current) => ({
      ...current,
      [targetThreadId]: { mode: uploadMode, startedAt: Date.now() },
    }));
    const uploadId = createClientMessageId();
    localVoiceJobIdsRef.current.add(uploadId);
    try {
      const draft = structuredClone(currentComposerDraft());
      const expectedDraftUpdatedAt = savedDraftUpdatedAtRef.current.has(targetThreadId)
        ? savedDraftUpdatedAtRef.current.get(targetThreadId)!
        : (state.details[targetThreadId]?.draft?.updatedAt ?? null);
      await queueVoiceRecording({
        id: uploadId,
        threadId: targetThreadId,
        audio: recording.audio,
        durationMs: recording.durationMs,
        mode: uploadMode,
        selectionStart: recording.selection.start,
        selectionEnd: recording.selection.end,
        draftUpdatedAt: expectedDraftUpdatedAt,
        draft,
      });
    } catch (error) {
      localVoiceJobIdsRef.current.delete(uploadId);
      throw error;
    } finally {
      setVoiceUploads((current) => {
        const next = { ...current };
        delete next[targetThreadId];
        return next;
      });
    }
  }

  async function cancelVoiceTranscription(): Promise<void> {
    if (!activeVoiceJob || voiceCancellationPending) return;
    setVoiceCancellationPending(true);
    setError(null);
    try {
      await api.cancelVoiceTranscription(threadId);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? localizeKnownServerText(language, caught.message)
          : t("Не удалось отменить обработку записи"),
      );
    } finally {
      setVoiceCancellationPending(false);
    }
  }

  useLayoutEffect(() => {
    if (!preparationRef.current.active) return;
    const workspaceId =
      typeof (location.state as { newSessionWorkspaceId?: unknown } | null)
        ?.newSessionWorkspaceId === "string"
        ? (
            location.state as {
              newSessionWorkspaceId: string;
            }
          ).newSessionWorkspaceId
        : `direct:${location.search}`;
    if (location.pathname !== "/new" || workspaceId !== initialNewSessionRef.current.workspaceId) {
      invalidatePreparation();
    }
  }, [location.pathname, location.search, location.state]);

  useEffect(() => {
    if (!preparationRef.current.active) return;
    if (!newSessionProject) {
      setNewSessionHydrated(true);
      return;
    }
    let active = true;
    const generation = preparationGenerationRef.current;
    void (async () => {
      const stored = await loadNewSessionDraft(api.settings, newSessionProject.id);
      if (!active || !preparationGenerationActive(generation)) return;
      if (!stored && !initialNewSessionRef.current.admitted) {
        setNewSessionRejected(true);
        setNewSessionHydrated(true);
        return;
      }

      const current = preparationRef.current;
      const value =
        stored && !preparationDraftTouchedRef.current
          ? normalizeNewSessionDraft(stored.value)
          : current.value;
      const settings =
        stored?.settings && pendingSettingsTouchedRef.current.size === 0
          ? structuredClone(stored.settings)
          : current.settings;
      if (stored?.settings && pendingSettingsTouchedRef.current.size === 0) {
        for (const key of [
          "collaborationMode",
          "model",
          "reasoningEffort",
          "serviceTier",
          "personality",
        ] as const) {
          if (pendingSettingsRef.current[key] !== settings[key]) {
            pendingSettingsTouchedRef.current.add(key);
          }
        }
        pendingSettingsRef.current = settings;
        pendingSettingsRevisionRef.current += 1;
        setPendingSettings(settings);
      }
      const storedThreadId = stored?.threadId ?? null;
      preparationRef.current = {
        ...current,
        projectId: newSessionProject.id,
        value,
        settings,
        phase: storedThreadId ? "transferring" : "creating",
        threadId: storedThreadId,
        thread: stored?.thread?.id === storedThreadId ? stored.thread : null,
        revision: Math.max(current.revision, stored?.revision ?? 0),
      };
      if (stored && !preparationDraftTouchedRef.current) {
        const next = { threadId, value };
        composerDraftRef.current = next;
        setComposerDraftState(next);
      }
      setNewSessionAdmitted(true);
      await enqueuePreparationSave(snapshotPreparation());
      if (active && preparationGenerationActive(generation)) setNewSessionHydrated(true);
    })();
    return () => {
      active = false;
    };
  }, [api.settings, newSessionProject?.id]);

  useEffect(() => {
    if (
      !preparationRef.current.active ||
      !newSessionHydrated ||
      !newSessionAdmitted ||
      preparationDiscardRef.current
    ) {
      return;
    }
    if (preparationDraftTimerRef.current !== null) {
      window.clearTimeout(preparationDraftTimerRef.current);
    }
    const timer = window.setTimeout(() => {
      if (preparationDraftTimerRef.current === timer) {
        preparationDraftTimerRef.current = null;
      }
      if (!preparationDiscardRef.current) {
        void enqueuePreparationSave(snapshotPreparation());
      }
    }, DRAFT_SAVE_DELAY_MS);
    preparationDraftTimerRef.current = timer;
  }, [activeComposerDraft, newSessionAdmitted, newSessionHydrated]);

  useEffect(() => {
    if (
      !preparationRef.current.active ||
      !newSessionHydrated ||
      !newSessionAdmitted ||
      !newSessionProject ||
      preparationOperationRef.current
    ) {
      return;
    }
    setPreparationWorking(true);
    setError(null);
    const generation = preparationGenerationRef.current;
    const operation = finishNewSessionPreparation(newSessionProject, generation)
      .catch(async (caught: unknown) => {
        if (caught === PREPARATION_SUPERSEDED) return;
        if (
          caught instanceof ApiClientError &&
          caught.status === 404 &&
          preparationRef.current.threadId &&
          preparationGenerationActive(generation)
        ) {
          preparationRef.current = {
            ...preparationRef.current,
            phase: "creating",
            threadId: null,
            thread: null,
          };
          creationPromiseRef.current = null;
        }
        await flushPreparation();
        if (preparationAliveRef.current && preparationGenerationRef.current === generation) {
          setError(
            caught instanceof Error
              ? (localizeKnownServerText(language, caught.message) ?? caught.message)
              : t("Не удалось создать сессию"),
          );
        }
      })
      .finally(() => {
        if (preparationOperationRef.current === operation) {
          preparationOperationRef.current = null;
        }
        if (preparationAliveRef.current && preparationGenerationRef.current === generation) {
          setPreparationWorking(false);
        }
      });
    preparationOperationRef.current = operation;
  }, [newSessionAdmitted, newSessionHydrated, newSessionProject, preparationRetry]);

  useEffect(() => {
    preparationAliveRef.current = true;
    const flushBeforePageExit = () => {
      if (!preparationDiscardRef.current) void flushPreparation();
    };
    window.addEventListener("pagehide", flushBeforePageExit);
    return () => {
      invalidatePreparation();
      window.removeEventListener("pagehide", flushBeforePageExit);
      if (!preparationDiscardRef.current) void flushPreparation();
      else if (preparationDraftTimerRef.current !== null) {
        window.clearTimeout(preparationDraftTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const startedAt = activeVoiceJob
      ? activeVoiceJob.status === "queued"
        ? activeVoiceJob.createdAt
        : (activeVoiceJob.startedAt ?? activeVoiceJob.createdAt)
      : voiceUpload?.startedAt;
    if (startedAt === undefined) {
      setTranscriptionElapsedSeconds(0);
      return;
    }
    const updateElapsed = () =>
      setTranscriptionElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1_000)));
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 250);
    return () => window.clearInterval(timer);
  }, [activeVoiceJob, voiceUpload]);

  useEffect(() => {
    localStorage.setItem(VOICE_INPUT_MODE_KEY, voiceMode);
  }, [voiceMode]);

  useEffect(() => {
    if (!voiceRemoval || handledVoiceRemovalsRef.current.has(voiceRemoval.jobId)) {
      return;
    }
    handledVoiceRemovalsRef.current.add(voiceRemoval.jobId);
    localVoiceJobIdsRef.current.delete(voiceRemoval.jobId);
    if (voiceRemoval.outcome === "cancelled") return;
    if (voiceRemoval.outcome === "send") {
      pendingDraftsRef.current.delete(threadId);
      savedDraftUpdatedAtRef.current.set(threadId, null);
      draftTouchedThreadsRef.current.delete(threadId);
      hydratedDraftSourcesRef.current.delete(threadId);
      replaceComposerDraft(emptyComposerDraft(), false);
      dispatch({ type: "draft", threadId, draft: null });
      clearLegacyAnnotations();
      void deleteLocalDraft(api.settings, threadId)
        .catch(() => undefined)
        .then(() => refreshDetail(threadId, { force: true }))
        .catch(() => undefined);
      return;
    }
    draftTouchedThreadsRef.current.delete(threadId);
    hydratedDraftSourcesRef.current.delete(threadId);
    void refreshDetail(threadId, { force: true }).catch(() => undefined);
  }, [api.settings, refreshDetail, threadId, voiceRemoval]);

  useEffect(() => {
    void acknowledgePendingThread(threadId);
    return () => {
      void releaseActiveThread(threadId);
    };
  }, [threadId]);

  useEffect(() => {
    if (goal) setGoalMode(false);
  }, [goal]);

  useEffect(() => {
    if (createdInWorkspaceRef.current !== threadId) {
      draftTouchedThreadsRef.current.delete(threadId);
      hydratedDraftSourcesRef.current.delete(threadId);
    }
    return () => {
      void flushDraft(threadId);
    };
  }, [threadId]);

  useEffect(() => {
    if (isSubagent) return;
    if (!detail) return;
    if (draftTouchedThreadsRef.current.has(threadId)) return;
    const detailDraft = detail.draft ?? null;
    const localAnnotations = loadPendingAnnotations(threadId);
    const serverSource = detailDraft
      ? {
          input: detailDraft.input,
          images: detailDraft.images,
          goalMode: detailDraft.goalMode,
          annotations: detailDraft.annotations,
        }
      : emptyComposerDraft();
    const mergeLegacyAnnotations = (source: UpdateThreadDraftRequest) => {
      const knownIds = new Set(source.annotations.map((annotation) => annotation.id));
      return {
        ...source,
        annotations: [
          ...source.annotations,
          ...localAnnotations.filter((annotation) => !knownIds.has(annotation.id)),
        ].sort((a, b) => a.createdAt - b.createdAt),
      };
    };
    savedDraftUpdatedAtRef.current.set(threadId, detailDraft?.updatedAt ?? null);
    if (hydratedDraftSourcesRef.current.get(threadId) !== detailDraft) {
      hydratedDraftSourcesRef.current.set(threadId, detailDraft);
      replaceComposerDraft(
        mergeLegacyAnnotations(serverSource),
        localAnnotations.length ? "immediate" : false,
      );
      if (localAnnotations.length) legacyAnnotationThreadsRef.current.add(threadId);
    }
    let active = true;
    void loadLocalDraft(api.settings, threadId).then((localDraft) => {
      if (!active || draftTouchedThreadsRef.current.has(threadId)) return;
      if (!localDraft || localDraft.updatedAt <= (detailDraft?.updatedAt ?? 0)) return;
      replaceComposerDraft(mergeLegacyAnnotations(localDraft.value), "immediate");
    });
    return () => {
      active = false;
    };
  }, [api.settings, detail, isSubagent, threadId]);

  useEffect(() => {
    const flushBeforePageExit = () => {
      void flushDraft(threadId, true);
    };
    window.addEventListener("pagehide", flushBeforePageExit);
    return () => window.removeEventListener("pagehide", flushBeforePageExit);
  }, [threadId]);

  useEffect(() => {
    if (!threadId || isSubagent || createdInWorkspaceRef.current === threadId) {
      return;
    }
    const request = api.readGoal?.(threadId);
    if (!request) return;
    void request
      .then((value) => dispatch({ type: "goal", threadId, goal: value }))
      .catch(() => undefined);
  }, [api, dispatch, isSubagent, threadId]);

  useEffect(() => {
    const notice = (location.state as { notice?: unknown } | null)?.notice;
    if (typeof notice !== "string" || locationNoticeHandled.current === notice) return;
    locationNoticeHandled.current = notice;
    setError(notice);
  }, [location.state]);

  const loadGitChanges = useCallback(async () => {
    const requestId = ++gitChangesRequest.current;
    setGitChangesState({ threadId, value: null });
    try {
      const value: GitChangesSummary = await api.readGitChanges(threadId);
      if (gitChangesRequest.current === requestId) setGitChangesState({ threadId, value });
    } catch {
      if (gitChangesRequest.current === requestId) {
        setGitChangesState({ threadId, value: "error" });
      }
    }
  }, [api, threadId]);

  useEffect(() => {
    if (!inspectorOpen || !threadId) return;
    void loadGitChanges();
    return () => {
      gitChangesRequest.current += 1;
    };
  }, [gitChangesRefreshKey, inspectorOpen, loadGitChanges, threadId]);

  useEffect(() => {
    setThreadMissing(false);
    if (threadId && createdInWorkspaceRef.current !== threadId) {
      void refreshDetail(threadId, { force: true }).catch((caught: unknown) => {
        if (caught instanceof ApiClientError && caught.status === 404) {
          dispatch({ type: "thread.remove", threadId });
          setThreadMissing(true);
        }
      });
    }
  }, [threadId, refreshDetail]);

  useEffect(() => {
    const latestTurn = detail?.turns.at(-1);
    if (
      !threadId ||
      !summary ||
      summary.currentTurnId ||
      summary.state !== "needsAttention" ||
      summary.settings.collaborationMode !== "plan" ||
      !latestTurn ||
      latestTurn.status === "inProgress" ||
      latestTurn.itemsLoaded !== false
    ) {
      return;
    }
    void loadTurnItems(threadId, latestTurn.id).catch(() => undefined);
  }, [detail?.turns, loadTurnItems, summary, threadId]);

  useEffect(
    () => () => {
      const retry = completedChatRetry.current;
      if (retry?.timer !== null && retry?.timer !== undefined) {
        window.clearTimeout(retry.timer);
      }
      completedChatRetry.current = null;
    },
    [threadId],
  );

  useEffect(() => {
    if (!summary || !completedChatLooksIncomplete(summary.state, detail)) {
      const retry = completedChatRetry.current;
      if (retry?.timer !== null && retry?.timer !== undefined) {
        window.clearTimeout(retry.timer);
      }
      completedChatRetry.current = null;
      return;
    }
    const key = `${threadId}:${summary.updatedAt}`;
    if (completedChatRetry.current?.key === key) return;
    const previous = completedChatRetry.current;
    if (previous?.timer !== null && previous?.timer !== undefined) {
      window.clearTimeout(previous.timer);
    }
    const timer = window.setTimeout(() => {
      if (completedChatRetry.current?.timer !== timer) return;
      completedChatRetry.current = { key, timer: null };
      void refreshDetail(threadId, { force: true }).catch(() => undefined);
    }, COMPLETED_CHAT_RETRY_MS);
    completedChatRetry.current = { key, timer };
  }, [detail, refreshDetail, summary, threadId]);

  useEffect(() => {
    if (!detail) return;
    const currentTurnId = summary?.currentTurnId ?? null;
    const currentTurn = currentTurnId
      ? detail.turns.find((turn) => turn.id === currentTurnId)
      : null;
    const staleTurn = !currentTurnId && detail.turns.some((turn) => turn.status === "inProgress");
    const missingTurn = Boolean(
      currentTurnId && (!currentTurn || currentTurn.status !== "inProgress"),
    );
    if (!staleTurn && !missingTurn) {
      detailReconcileKey.current = null;
      return;
    }
    const key = `${threadId}:${currentTurnId ?? "idle"}:${staleTurn ? "stale" : "missing"}`;
    if (detailReconcileKey.current === key) return;
    detailReconcileKey.current = key;
    void refreshDetail(threadId, { force: true }).catch(() => {
      detailReconcileKey.current = null;
    });
  }, [detail, refreshDetail, summary?.currentTurnId, threadId]);

  useEffect(() => {
    if (summary?.unread && detail && summary.state === "failed") {
      void api.markRead(threadId, { observedUpdatedAt: summary.updatedAt }).catch(() => undefined);
    }
  }, [api, detail, summary, threadId]);

  useLayoutEffect(() => {
    if (initialScrollThread.current === threadId) return;
    followsTail.current = true;
    setShowScrollToBottom(false);
    if (!detail) return;
    initialScrollThread.current = threadId;
    scrollToEnd(scrollRef.current);
  }, [detail, threadId]);

  useLayoutEffect(() => {
    const anchor = olderScrollAnchor.current;
    const node = scrollRef.current;
    if (!anchor || anchor.threadId !== threadId || !node) return;
    node.scrollTop = anchor.scrollTop + (node.scrollHeight - anchor.scrollHeight);
    olderScrollAnchor.current = null;
  }, [detail, threadId]);

  useLayoutEffect(() => {
    if (!detail || initialScrollThread.current !== threadId || !followsTail.current) return;
    scrollToEnd(scrollRef.current);
  }, [attention, autoVoiceProgressKey, detail, threadId]);

  useLayoutEffect(() => {
    const messageId = scrollTargetMessageId.current;
    const node = scrollRef.current;
    if (!messageId || !node) return;
    const target = [...node.querySelectorAll<HTMLElement>("[data-message-id]")].find(
      (candidate) => candidate.dataset.messageId === messageId,
    );
    if (!target) return;
    followsTail.current = true;
    setShowScrollToBottom(false);
    if (typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } else {
      scrollToEnd(node, "smooth");
    }
    scrollTargetMessageId.current = null;
  }, [detail, optimisticMessages, threadId]);

  const loadOlder = useCallback(async () => {
    const cursor = detail?.olderTurnsCursor;
    const node = scrollRef.current;
    if (isSubagent || !cursor || !node || loadingOlder) return;
    olderScrollAnchor.current = {
      threadId,
      scrollHeight: node.scrollHeight,
      scrollTop: node.scrollTop,
    };
    setLoadingOlder(true);
    setOlderError(false);
    try {
      await loadOlderDetail(threadId, cursor);
    } catch {
      olderScrollAnchor.current = null;
      setOlderError(true);
    } finally {
      setLoadingOlder(false);
    }
  }, [detail?.olderTurnsCursor, isSubagent, loadOlderDetail, loadingOlder, threadId]);

  function persistAnnotations(next: PendingAnnotation[]): boolean {
    composerEditRevisionRef.current += 1;
    replaceComposerDraft(
      { ...currentComposerDraft(), annotations: next, ...(next.length ? { goalMode: false } : {}) },
      "immediate",
    );
    return true;
  }

  function createAnnotation(draft: AnnotationDraft): boolean {
    return persistAnnotations([
      ...annotations,
      {
        ...draft,
        id: createClientMessageId(),
        createdAt: Date.now(),
      },
    ]);
  }

  function updateAnnotation(annotationId: string, comment: string): boolean {
    const next = annotations.map((annotation) =>
      annotation.id === annotationId ? { ...annotation, comment: comment.trim() } : annotation,
    );
    return persistAnnotations(next);
  }

  function deleteAnnotation(annotationId: string): boolean {
    return persistAnnotations(annotations.filter((annotation) => annotation.id !== annotationId));
  }

  function clearLegacyAnnotations(targetThreadId = threadId) {
    try {
      savePendingAnnotations(targetThreadId, []);
    } catch {
      // The sent server draft is already authoritative.
    }
    legacyAnnotationThreadsRef.current.delete(targetThreadId);
  }

  function persistDraftAfterAcceptedSend(
    targetThreadId: string,
    value: UpdateThreadDraftRequest,
  ): void {
    draftTouchedThreadsRef.current.add(targetThreadId);
    scheduleDraftSave(targetThreadId, value, true);
  }

  function reconcileAcceptedDraftAfterClear(
    targetThreadId: string,
    guard: AcceptedDraftClearGuard,
    clearFailed: boolean,
  ): boolean {
    if (!preparationAliveRef.current || preparationGenerationRef.current !== guard.generation) {
      return false;
    }
    const pending = pendingDraftsRef.current.get(targetThreadId);
    const editorHasNewerDraft =
      composerDraftRef.current.threadId === targetThreadId &&
      composerEditRevisionRef.current !== guard.editRevision;
    if (editorHasNewerDraft || (pending?.revision ?? 0) > guard.pendingRevision) {
      persistDraftAfterAcceptedSend(
        targetThreadId,
        structuredClone(editorHasNewerDraft ? composerDraftRef.current.value : pending!.value),
      );
      return false;
    }
    if (!clearFailed) return true;
    if ((pendingDraftsRef.current.get(targetThreadId)?.revision ?? 0) <= guard.pendingRevision) {
      persistDraftAfterAcceptedSend(targetThreadId, emptyComposerDraft());
    }
    return false;
  }

  async function cleanupAcceptedDraft(
    targetThreadId: string,
    submittedEditRevision: number,
  ): Promise<void> {
    if (composerEditRevisionRef.current !== submittedEditRevision) {
      persistDraftAfterAcceptedSend(
        targetThreadId,
        structuredClone(composerDraftRef.current.value),
      );
      return;
    }
    try {
      await deleteLocalDraft(api.settings, targetThreadId);
    } catch {
      // Delivery is authoritative; local cleanup is best-effort.
    }
    if (composerEditRevisionRef.current !== submittedEditRevision) {
      persistDraftAfterAcceptedSend(
        targetThreadId,
        structuredClone(composerDraftRef.current.value),
      );
      return;
    }
    pendingDraftsRef.current.delete(targetThreadId);
    savedDraftUpdatedAtRef.current.set(targetThreadId, null);
    dispatch({ type: "draft", threadId: targetThreadId, draft: null });
    clearLegacyAnnotations(targetThreadId);
  }

  async function preserveAcceptedDraft(
    targetThreadId: string,
    value: UpdateThreadDraftRequest,
    expectedEditRevision = composerEditRevisionRef.current,
  ): Promise<boolean> {
    let savedLocally = false;
    try {
      await saveLocalDraft(api.settings, targetThreadId, value, Date.now());
      savedLocally = true;
    } catch {
      // The debounced server persistence below will keep retrying.
    }
    if (composerEditRevisionRef.current !== expectedEditRevision) {
      persistDraftAfterAcceptedSend(
        targetThreadId,
        structuredClone(composerDraftRef.current.value),
      );
      return savedLocally;
    }
    persistDraftAfterAcceptedSend(targetThreadId, value);
    return savedLocally;
  }

  async function deletePreparationPersistence(projectId: string): Promise<void> {
    try {
      await preparationDraftSaveChainRef.current.catch(() => undefined);
      await deleteNewSessionDraft(api.settings, projectId);
    } catch {
      // The created thread and its local draft are already authoritative.
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (preparationRef.current.active && newSessionProject) {
      await submitPreparingSession(newSessionProject);
      return;
    }
    const targetThreadId = activeThreadIdRef.current;
    if (!targetThreadId) {
      setError(t("Не удалось отправить сообщение"));
      return;
    }
    const submittedDraft = structuredClone(currentComposerDraft(targetThreadId));
    const submittedInput = formatAnnotatedMessage(
      submittedDraft.input,
      submittedDraft.annotations,
      language,
    );
    if (
      (!submittedInput.trim() && !submittedDraft.images.length) ||
      (submittedDraft.goalMode && !submittedDraft.input.trim())
    ) {
      return;
    }
    const submittedEditRevision = composerEditRevisionRef.current;
    const clientMessageId = createClientMessageId();
    const optimisticMessage: OptimisticMessage = {
      id: clientMessageId,
      threadId: targetThreadId,
      text: submittedInput.trim(),
      images: submittedDraft.images.map((image) => image.url),
      createdAt: Date.now(),
      destination: "queue",
      turnId: null,
    };
    setBusy(true);
    setError(null);
    scrollTargetMessageId.current = clientMessageId;
    dispatch({ type: "optimistic.add", message: optimisticMessage });
    replaceComposerDraft(emptyComposerDraft(), false);
    await flushDraft(targetThreadId);
    try {
      await sendReliable(targetThreadId, {
        input: submittedInput,
        ...(submittedDraft.images.length
          ? { images: submittedDraft.images.map((image) => image.url) }
          : {}),
        ...(submittedDraft.goalMode ? { goal: true } : {}),
        clientMessageId,
      });
    } catch (caught) {
      dispatch({ type: "optimistic.remove", threadId: targetThreadId, messageId: clientMessageId });
      const restore =
        composerEditRevisionRef.current === submittedEditRevision
          ? submittedDraft
          : mergeComposerDrafts(submittedDraft, currentComposerDraft(targetThreadId));
      replaceComposerDraft(restore, "immediate");
      setError(
        caught instanceof Error
          ? localizeKnownServerText(language, caught.message)
          : t("Не удалось отправить сообщение"),
      );
      setBusy(false);
      return;
    }
    try {
      await cleanupAcceptedDraft(targetThreadId, submittedEditRevision);
    } finally {
      setBusy(false);
    }
  }

  async function stopTask(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.interrupt(threadId, workspaceSummary.currentTurnId ?? undefined);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? localizeKnownServerText(language, caught.message)
          : t("Не удалось остановить задачу"),
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitPreparingSession(activeProject: Project): Promise<void> {
    const generation = preparationGenerationRef.current;
    assertPreparationGeneration(generation);
    const submittedDraft = structuredClone(preparationRef.current.value);
    const submittedInput = formatAnnotatedMessage(
      submittedDraft.input,
      submittedDraft.annotations,
      language,
    );
    if (
      (!submittedInput.trim() &&
        !submittedDraft.images.length &&
        !pendingAttachmentScopesRef.current.has(attachmentScopeRef.current)) ||
      (submittedDraft.goalMode && !submittedDraft.input.trim())
    ) {
      return;
    }

    const clientMessageId = createClientMessageId();
    earlySubmitRef.current = true;
    preparationClaimedForSubmitRef.current = true;
    preparationDraftTransferGenerationRef.current += 1;
    claimedPreparationDraftTransferRef.current = activePreparationDraftTransferRef.current;
    setBusy(true);
    setError(null);
    setPendingOptimisticMessage({
      id: clientMessageId,
      threadId: "",
      text: submittedInput.trim(),
      images: submittedDraft.images.map((image) => image.url),
      createdAt: Date.now(),
      destination: "queue",
      turnId: null,
    });
    replacePreparationDraft(emptyComposerDraft());
    const submittedAttachmentScope = attachmentScopeRef.current;
    attachmentScopeRef.current += 1;
    setAttachmentScope(attachmentScopeRef.current);
    earlySubmissionRef.current = {
      attachmentScope: submittedAttachmentScope,
      clearedRevision: preparationRef.current.revision,
      draft: submittedDraft,
      editRevision: composerEditRevisionRef.current,
    };

    let activatedThreadId: string | null = null;
    let accepted = false;
    try {
      await waitForPendingAttachments(submittedAttachmentScope);
      assertPreparationGeneration(generation);
      const submission = earlySubmissionRef.current;
      const completeDraft = structuredClone(submission?.draft ?? submittedDraft);
      const completeInput = formatAnnotatedMessage(
        completeDraft.input,
        completeDraft.annotations,
        language,
      );
      let thread = await ensureCreatedThread(activeProject, generation);
      assertPreparationGeneration(generation);
      thread = await applyPendingSettings(thread, generation);
      assertPreparationGeneration(generation);
      preparationRef.current = { ...preparationRef.current, thread };
      const optimisticMessage: OptimisticMessage = {
        id: clientMessageId,
        threadId: thread.id,
        text: completeInput.trim(),
        images: completeDraft.images.map((image) => image.url),
        createdAt: Date.now(),
        destination: "queue",
        turnId: null,
      };
      assertPreparationGeneration(generation);
      dispatch({ type: "optimistic.add", message: optimisticMessage });
      setPendingOptimisticMessage(null);
      if (!activateCreatedThread(thread, null, generation)) throw PREPARATION_SUPERSEDED;
      activatedThreadId = thread.id;
      await sendReliable(thread.id, {
        input: completeInput,
        ...(completeDraft.images.length
          ? { images: completeDraft.images.map((image) => image.url) }
          : {}),
        ...(completeDraft.goalMode ? { goal: true } : {}),
        clientMessageId,
      });
      accepted = true;
      await waitForPendingAttachments();
      const staleServerWrite = await settleClaimedPreparationDraftTransfer();
      await waitForPendingAttachments();
      const settledSubmission = earlySubmissionRef.current;
      const submittedEditRevision =
        settledSubmission?.editRevision ?? composerEditRevisionRef.current;
      const hasNewerDraft =
        composerEditRevisionRef.current !== submittedEditRevision ||
        (settledSubmission !== null &&
          preparationRef.current.revision !== settledSubmission.clearedRevision);
      const remainingDraft = structuredClone(composerDraftRef.current.value);
      const remainingEditRevision = composerEditRevisionRef.current;
      earlySubmissionRef.current = null;
      earlySubmitRef.current = false;
      let newerDraftStored = true;
      if (hasNewerDraft) {
        newerDraftStored = await preserveAcceptedDraft(
          thread.id,
          remainingDraft,
          remainingEditRevision,
        );
      } else {
        if (staleServerWrite) {
          const clearGuard: AcceptedDraftClearGuard = {
            editRevision: composerEditRevisionRef.current,
            generation,
            pendingRevision: draftRevisionRef.current,
          };
          let clearFailed = false;
          try {
            await api.updateThreadDraft(thread.id, emptyComposerDraft(), { retry: true });
          } catch {
            clearFailed = true;
          }
          if (reconcileAcceptedDraftAfterClear(thread.id, clearGuard, clearFailed)) {
            await cleanupAcceptedDraft(thread.id, clearGuard.editRevision);
          }
        } else {
          await cleanupAcceptedDraft(thread.id, submittedEditRevision);
        }
      }
      if (!hasNewerDraft || newerDraftStored) {
        await deletePreparationPersistence(activeProject.id);
      }
    } catch (caught) {
      if (accepted) return;
      if (caught === PREPARATION_SUPERSEDED) return;
      await waitForPendingAttachments();
      const targetThreadId = activatedThreadId ?? preparationRef.current.threadId;
      if (activatedThreadId) {
        dispatch({
          type: "optimistic.remove",
          threadId: activatedThreadId,
          messageId: clientMessageId,
        });
      }
      setPendingOptimisticMessage(null);
      const submission = earlySubmissionRef.current;
      const submitted = submission?.draft ?? submittedDraft;
      const hasNewerDraft =
        composerEditRevisionRef.current !==
          (submission?.editRevision ?? composerEditRevisionRef.current) ||
        (submission !== null && preparationRef.current.revision !== submission.clearedRevision);
      const current = structuredClone(composerDraftRef.current.value);
      const restore = hasNewerDraft ? mergeComposerDrafts(submitted, current) : submitted;
      earlySubmissionRef.current = null;
      earlySubmitRef.current = false;
      if (!activatedThreadId) preparationClaimedForSubmitRef.current = false;
      if (activatedThreadId) {
        const restored = { threadId: activatedThreadId, value: restore };
        composerDraftRef.current = restored;
        draftTouchedThreadsRef.current.add(activatedThreadId);
        setComposerDraftState(restored);
        const savedLocally = await preserveAcceptedDraft(activatedThreadId, restore);
        if (savedLocally) await deletePreparationPersistence(activeProject.id);
      } else {
        replacePreparationDraft(restore);
      }
      if (!targetThreadId) creationPromiseRef.current = null;
      setError(
        caught instanceof Error
          ? (localizeKnownServerText(language, caught.message) ?? caught.message)
          : t("Не удалось отправить сообщение"),
      );
    } finally {
      if (preparationAliveRef.current && preparationGenerationRef.current === generation) {
        setBusy(false);
      }
    }
  }

  async function implementPlan(targetMode: "default" | "team") {
    const implementationMessage =
      targetMode === "team"
        ? t("Да, реализуй этот план в режиме оркестратора")
        : t("Да, реализуй этот план");
    setBusy(true);
    setError(null);
    setTeamUpgradeRequired(false);
    let changedMode = false;
    let clientMessageId: string | null = null;
    try {
      const thread = await api.updateThreadSettings(threadId, {
        collaborationMode: targetMode,
      });
      changedMode = true;
      dispatch({ type: "thread", thread });
      clientMessageId = createClientMessageId();
      scrollTargetMessageId.current = clientMessageId;
      dispatch({
        type: "optimistic.add",
        message: {
          id: clientMessageId,
          threadId,
          text: implementationMessage,
          images: [],
          createdAt: Date.now(),
          destination: "turn",
          turnId: null,
        },
      });
      const result = await api.startTurn(threadId, {
        input: implementationMessage,
        clientMessageId,
      });
      dispatch({
        type: "optimistic.accept",
        threadId,
        messageId: clientMessageId,
        turnId: result.turnId,
      });
    } catch (caught) {
      if (clientMessageId) {
        dispatch({ type: "optimistic.remove", threadId, messageId: clientMessageId });
      }
      if (changedMode) {
        await api
          .updateThreadSettings(threadId, { collaborationMode: "plan" })
          .then((thread) => dispatch({ type: "thread", thread }))
          .catch(() => undefined);
      }
      setError(
        caught instanceof Error
          ? localizeKnownServerText(language, caught.message)
          : targetMode === "team"
            ? t("Не удалось начать реализацию плана в режиме оркестратора")
            : t("Не удалось начать реализацию плана"),
      );
    } finally {
      setBusy(false);
    }
  }

  async function sendQueuedNow(messageId: string): Promise<boolean> {
    setQueueAction({ messageId, kind: "send" });
    setError(null);
    try {
      await api.sendQueuedNow(threadId, messageId);
      return true;
    } catch (caught) {
      setError(
        caught instanceof Error
          ? localizeKnownServerText(language, caught.message)
          : t("Не удалось отправить сообщение"),
      );
      return false;
    } finally {
      setQueueAction(null);
    }
  }

  async function updateQueued(messageId: string, value: string): Promise<boolean> {
    setQueueAction({ messageId, kind: "update" });
    setError(null);
    try {
      await api.updateQueued(threadId, messageId, { input: value });
      return true;
    } catch (caught) {
      setError(
        caught instanceof Error
          ? localizeKnownServerText(language, caught.message)
          : t("Не удалось изменить сообщение в очереди"),
      );
      return false;
    } finally {
      setQueueAction(null);
    }
  }

  async function deleteQueued(messageId: string): Promise<boolean> {
    setQueueAction({ messageId, kind: "delete" });
    setError(null);
    try {
      await api.deleteQueued(threadId, messageId);
      return true;
    } catch (caught) {
      setError(
        caught instanceof Error
          ? localizeKnownServerText(language, caught.message)
          : t("Не удалось удалить сообщение из очереди"),
      );
      return false;
    } finally {
      setQueueAction(null);
    }
  }

  async function finishThread() {
    setFinishing(true);
    setError(null);
    try {
      await api.markRead(threadId, { observedUpdatedAt: summary!.updatedAt });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? localizeKnownServerText(language, caught.message)
          : t("Не удалось закончить сессию"),
      );
    } finally {
      setFinishing(false);
    }
  }

  async function forceRefreshSession() {
    if (refreshing) return;
    setRefreshing(true);
    setError(null);
    try {
      await forceRefreshDetail(threadId);
      if (inspectorOpen) await loadGitChanges();
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.status === 404) {
        dispatch({ type: "thread.remove", threadId });
        setThreadMissing(true);
      } else {
        setError(
          caught instanceof Error
            ? localizeKnownServerText(language, caught.message)
            : t("Не удалось обновить сессию"),
        );
      }
    } finally {
      setRefreshing(false);
    }
  }

  const togglePin = () => void api.updateThread(threadId, { pinned: !summary!.pinned });
  const toggleArchive = () => void api.archive(threadId, !summary!.archived);

  async function deleteThread() {
    if (!window.confirm(t("Удалить эту сессию? Это действие нельзя отменить."))) return;
    setDeleting(true);
    setError(null);
    try {
      await api.deleteThread(threadId);
      dispatch({ type: "thread.remove", threadId });
      navigate("/", { replace: true });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? localizeKnownServerText(language, caught.message)
          : t("Не удалось удалить сессию"),
      );
      setDeleting(false);
    }
  }

  async function updateSettings(patch: UpdateThreadSettingsRequest) {
    if (preparationRef.current.active) {
      const next = applySessionSettingsPatch(pendingSettingsRef.current, patch);
      for (const key of [
        "collaborationMode",
        "model",
        "reasoningEffort",
        "serviceTier",
        "personality",
      ] as const) {
        if (patch[key] !== undefined) pendingSettingsTouchedRef.current.add(key);
      }
      pendingSettingsRef.current = next;
      pendingSettingsRevisionRef.current += 1;
      preparationRef.current = { ...preparationRef.current, settings: next };
      setPendingSettings(next);
      return;
    }
    setSettingsBusy(true);
    setError(null);
    setTeamUpgradeRequired(false);
    try {
      const thread = await api.updateThreadSettings(threadId, patch);
      dispatch({ type: "thread", thread });
      if (patch.collaborationMode !== undefined && patch.collaborationMode !== "default") {
        setGoalMode(false);
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "";
      if (patch.collaborationMode === "team" && message.includes("managed Team tools")) {
        setTeamUpgradeRequired(true);
      }
      setError(
        caught instanceof Error
          ? localizeKnownServerText(language, caught.message)
          : t("Не удалось изменить настройки"),
      );
    } finally {
      setSettingsBusy(false);
    }
  }

  async function createManagedTeamSession() {
    if (!project) return;
    setSettingsBusy(true);
    setError(null);
    try {
      const created = await api.createProjectThread(project.id);
      dispatch({ type: "thread", thread: created.thread });
      const configured = await api.updateThreadSettings(created.thread.id, {
        collaborationMode: "team",
      });
      dispatch({ type: "thread", thread: configured });
      setTeamUpgradeRequired(false);
      navigate(`/threads/${encodeURIComponent(configured.id)}`, {
        state: { focusComposer: true },
      });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? localizeKnownServerText(language, caught.message)
          : t("Не удалось создать Team-сессию"),
      );
    } finally {
      setSettingsBusy(false);
    }
  }

  async function updateGoal(patch: UpdateThreadGoalRequest) {
    setGoalBusy(true);
    setError(null);
    try {
      const updated = await api.updateGoal(threadId, patch);
      dispatch({ type: "goal", threadId, goal: updated });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? localizeKnownServerText(language, caught.message)
          : t("Не удалось изменить цель"),
      );
    } finally {
      setGoalBusy(false);
    }
  }

  async function clearGoal() {
    setGoalBusy(true);
    setError(null);
    try {
      await api.clearGoal(threadId);
      dispatch({ type: "goal", threadId, goal: null });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? localizeKnownServerText(language, caught.message)
          : t("Не удалось очистить цель"),
      );
    } finally {
      setGoalBusy(false);
    }
  }

  useLayoutEffect(() => {
    annotationActionsRef.current = {
      create: createAnnotation,
      update: updateAnnotation,
      delete: deleteAnnotation,
    };
  });

  if (
    initialNewSessionRef.current.active &&
    (newSessionRejected || (newSessionHydrated && !newSessionProject))
  ) {
    return <Navigate to="/" replace />;
  }
  if (preparationRef.current.active && !newSessionAdmitted) return null;
  if (!summary && !preparationRef.current.active && !preparationRef.current.thread)
    return (
      <div className="center-state">
        {threadMissing ? (
          <h2>{t("Задача не найдена")}</h2>
        ) : (
          <>
            <div className="spinner" />
            <p>{t("Получаем состояние Codex…")}</p>
          </>
        )}
      </div>
    );

  const workspaceSummary =
    summary ??
    preparationRef.current.thread ??
    pendingThreadSummary(newSessionProject!, pendingSettings);
  const emptyCreatedWorkspace =
    createdInWorkspaceRef.current === threadId &&
    (detail?.turns.length ?? 0) === 0 &&
    (detail?.queuedMessages.length ?? 0) === 0 &&
    optimisticMessages.length === 0;
  const showEmptySessionHero =
    pendingOptimisticMessage === null &&
    !autoVoiceProgress &&
    (preparationRef.current.active || emptyCreatedWorkspace);
  const showNewSessionChrome = preparationRef.current.active || showEmptySessionHero;
  const latestPlanId =
    !workspaceSummary.currentTurnId && workspaceSummary.settings.collaborationMode === "plan"
      ? findLatestCompletedPlan(detail)
      : null;
  const latestAnnotatableId = findLatestAnnotatable(detail, workspaceSummary.currentTurnId);
  const latestPlanHasAnnotations = Boolean(
    latestPlanId && annotations.some((annotation) => annotation.messageId === latestPlanId),
  );

  return (
    <div className="thread-workspace">
      <div className="conversation-pane">
        <WorkspaceHeader
          title={
            showNewSessionChrome
              ? t("Новая задача")
              : (localizeKnownServerText(language, workspaceSummary.title) ??
                workspaceSummary.title)
          }
          subtitle={project?.displayName ?? workspaceSummary.cwd}
          onOpenNavigation={onOpenNavigation}
          onToggleInspector={() => setInspectorOpen((value) => !value)}
          actions={
            showNewSessionChrome ? undefined : (
              <>
                {!isSubagent && (
                  <details className="thread-action-menu" data-dismiss-on-outside-click>
                    <summary className="icon-button" aria-label={t("Действия с задачей")}>
                      <MoreIcon />
                    </summary>
                    <div className="action-menu-popover">
                      <button onClick={togglePin}>
                        <PinIcon /> {workspaceSummary.pinned ? t("Открепить") : t("Закрепить")}
                      </button>
                      <button onClick={() => setRenaming(true)}>
                        <PencilIcon /> {t("Переименовать")}
                      </button>
                      <button onClick={toggleArchive}>
                        <ArchiveIcon />{" "}
                        {workspaceSummary.archived ? t("Вернуть из архива") : t("Архивировать")}
                      </button>
                      <button
                        className="danger"
                        disabled={deleting}
                        onClick={() => void deleteThread()}
                      >
                        <TrashIcon /> {deleting ? t("Удаляем…") : t("Удалить")}
                      </button>
                    </div>
                  </details>
                )}
                <button
                  className={`icon-button session-refresh${refreshing ? " refreshing" : ""}`}
                  aria-label={
                    refreshing
                      ? t("Обновляем состояние сессии")
                      : t("Принудительно обновить сессию")
                  }
                  disabled={refreshing}
                  onClick={() => void forceRefreshSession()}
                >
                  <RefreshIcon />
                </button>
              </>
            )
          }
        />
        <div
          className="conversation-scroll"
          ref={scrollRef}
          onScroll={(event) => {
            const node = event.currentTarget;
            followsTail.current =
              node.scrollHeight - node.scrollTop - node.clientHeight < TAIL_FOLLOW_THRESHOLD_PX;
            setShowScrollToBottom(!followsTail.current);
            if (node.scrollTop < 160) void loadOlder();
          }}
        >
          <section className="timeline" aria-live="polite">
            {showEmptySessionHero ? (
              <div className="new-session-empty">
                <span className="new-session-glyph">
                  <NewTaskIcon />
                </span>
                <h2>{t("Что поручим Codex?")}</h2>
                <p>{t("Введите сообщение или добавьте контекст.")}</p>
              </div>
            ) : pendingOptimisticMessage ? (
              <div className="turn optimistic-turn">
                <Activity
                  item={optimisticActivity(pendingOptimisticMessage)}
                  cwd={project?.path ?? workspaceSummary.cwd}
                  onDownload={async () => undefined}
                />
              </div>
            ) : (
              <>
                {loadingOlder && (
                  <div className="history-loader" aria-label={t("Загружаем старые сообщения")}>
                    <span className="spinner small" />
                  </div>
                )}
                {olderError && (
                  <button className="history-retry" type="button" onClick={() => void loadOlder()}>
                    {t("Повторить загрузку старых сообщений")}
                  </button>
                )}
                {!detail &&
                  optimisticTurnMessages.length === 0 &&
                  createdInWorkspaceRef.current !== threadId && (
                    <div className="center-state compact">
                      <div className="spinner" />
                    </div>
                  )}
                {detail?.turns.map((turn) => {
                  const entries = groupedTurnActivities.get(turn.id)!;
                  const technicalItems = technicalTurnActivities.get(turn.id)!;
                  const turnOptimisticMessages = optimisticTurnMessages.filter(
                    (message) =>
                      message.turnId === turn.id ||
                      (!message.turnId && workspaceSummary.currentTurnId === turn.id),
                  );
                  const active = workspaceSummary.currentTurnId === turn.id;
                  if (
                    isSubagent &&
                    entries.length === 0 &&
                    technicalItems.length === 0 &&
                    turnOptimisticMessages.length === 0 &&
                    !active
                  ) {
                    return null;
                  }
                  return (
                    <div className="turn" key={turn.id}>
                      {turnOptimisticMessages.map((message) => (
                        <Activity
                          item={optimisticActivity(message)}
                          cwd={workspaceSummary.cwd}
                          onDownload={downloadFile}
                          key={message.id}
                        />
                      ))}
                      {entries.map((entry) =>
                        Array.isArray(entry) ? (
                          <MemoizedActivityGroup
                            items={entry}
                            cwd={workspaceSummary.cwd}
                            onDownload={downloadFile}
                            key={entry.map((item) => item.id).join(":")}
                          />
                        ) : (
                          <div key={entry.id}>
                            <MemoizedActivity
                              item={entry}
                              cwd={workspaceSummary.cwd}
                              onDownload={downloadFile}
                              annotations={annotations}
                              annotationEnabled={
                                !isSubagent && !busy && entry.id === latestAnnotatableId
                              }
                              annotationBusy={busy}
                              onCreateAnnotation={createAnnotationEvent}
                              onUpdateAnnotation={updateAnnotationEvent}
                              onDeleteAnnotation={deleteAnnotationEvent}
                            />
                            {!isSubagent && entry.id === latestPlanId && (
                              <div className="implement-plan-actions">
                                <button
                                  className="implement-plan"
                                  disabled={busy || latestPlanHasAnnotations}
                                  title={
                                    latestPlanHasAnnotations
                                      ? t("Сначала отправьте или удалите аннотации к плану")
                                      : undefined
                                  }
                                  type="button"
                                  onClick={() => void implementPlan("default")}
                                >
                                  {t("Да, реализуй этот план")}
                                </button>
                                <button
                                  className="implement-plan orchestrator"
                                  disabled={busy || latestPlanHasAnnotations}
                                  title={
                                    latestPlanHasAnnotations
                                      ? t("Сначала отправьте или удалите аннотации к плану")
                                      : undefined
                                  }
                                  type="button"
                                  onClick={() => void implementPlan("team")}
                                >
                                  <TeamIcon />
                                  {t("Запустить в режиме оркестратора")}
                                </button>
                              </div>
                            )}
                          </div>
                        ),
                      )}
                      {!isSubagent && (
                        <LazyTechnicalDetails
                          items={technicalItems}
                          loaded={turn.itemsLoaded !== false}
                          onLoad={() => loadTurnItems(threadId, turn.id)}
                          cwd={workspaceSummary.cwd}
                          onDownload={downloadFile}
                        />
                      )}
                      {isSubagent ? (
                        active && (
                          <ActiveTurnStatus
                            progress={{
                              ...turn.progress,
                              startedAt: turn.startedAt ?? turn.progress.startedAt,
                            }}
                          />
                        )
                      ) : (
                        <MemoizedTurnTiming turn={turn} active={active} />
                      )}
                    </div>
                  );
                })}
                {workspaceSummary.currentTurnId &&
                  !detail?.turns.some((turn) => turn.id === workspaceSummary.currentTurnId) && (
                    <div className="turn active-turn-placeholder">
                      <ActiveTurnStatus progress={activeProgress} />
                    </div>
                  )}
                {detachedOptimisticMessages(
                  optimisticTurnMessages,
                  detail?.turns ?? [],
                  workspaceSummary.currentTurnId,
                ).map((message) => (
                  <div className="turn optimistic-turn" key={`optimistic:${message.id}`}>
                    <Activity
                      item={optimisticActivity(message)}
                      cwd={workspaceSummary.cwd}
                      onDownload={downloadFile}
                    />
                  </div>
                ))}
                {!isSubagent && autoVoiceProgress && (
                  <VoiceTranscriptionBubble progress={autoVoiceProgress} />
                )}
                <AttentionPanel
                  requests={attention}
                  transcriptionConfig={transcriptionConfig}
                  transcriptionProvider={transcriptionProvider}
                  onTranscriptionTimingEstimateChange={onTranscriptionTimingEstimateChange}
                />
                {!isSubagent &&
                  !activeVoiceJob &&
                  !voiceUpload &&
                  ["completed", "interrupted"].includes(workspaceSummary.state) &&
                  workspaceSummary.unread && (
                    <button
                      className="finish-thread-action"
                      disabled={finishing}
                      onClick={() => void finishThread()}
                    >
                      {finishing ? t("Заканчиваем…") : t("Закончить")}
                    </button>
                  )}
              </>
            )}
          </section>
        </div>
        {isSubagent ? (
          <div className="subagent-readonly">
            <div className="subagent-readonly-copy">
              {t("Субагент управляется родительской сессией. Здесь доступен только просмотр.")}
            </div>
            {parentThreadId && (
              <Link to={`/threads/${encodeURIComponent(parentThreadId)}`}>
                <span>{t("Открыть родительскую сессию")}</span>
                {parentSummary && <small>{parentSummary.title}</small>}
              </Link>
            )}
          </div>
        ) : (
          <Composer
            autoFocus={
              preparationRef.current.active ||
              (location.state as { focusComposer?: unknown } | null)?.focusComposer === true
            }
            sessionIdentity={
              initialNewSessionRef.current.active ? "new-session-workspace" : threadId
            }
            input={input}
            onInput={setInput}
            images={images}
            onImagesChange={setImages}
            attachmentScope={attachmentScope}
            onPendingAttachmentsChange={setPendingAttachments}
            onSubmit={submit}
            busy={busy}
            running={
              Boolean(workspaceSummary.currentTurnId) ||
              (workspaceSummary.settings.collaborationMode === "team" &&
                workspaceSummary.state === "running")
            }
            settings={preparationRef.current.active ? pendingSettings : workspaceSummary.settings}
            onSettingsChange={(patch) => void updateSettings(patch)}
            settingsBusy={settingsBusy}
            goalMode={goalMode}
            goal={goal}
            goalBusy={goalBusy}
            onGoalModeChange={(value) => {
              if (value && annotations.length) {
                setError(t("Сначала отправьте или удалите аннотации"));
                return;
              }
              setGoalMode(value);
            }}
            onGoalUpdate={(patch) => void updateGoal(patch)}
            onGoalClear={() => void clearGoal()}
            models={state.snapshot?.models ?? []}
            onStop={
              !busy &&
              (workspaceSummary.currentTurnId ||
                (workspaceSummary.settings.collaborationMode === "team" &&
                  workspaceSummary.state === "running"))
                ? () => void stopTask()
                : undefined
            }
            transcriptionConfig={transcriptionConfig}
            transcriptionProvider={transcriptionProvider}
            voiceMode={voiceMode}
            onVoiceModeChange={setVoiceMode}
            voiceUploadPending={Boolean(voiceUpload)}
            voiceInputLocked={Boolean(activeVoiceJob || voiceUpload)}
            onCancelVoiceTranscription={
              activeVoiceJob ? () => void cancelVoiceTranscription() : undefined
            }
            voiceCancellationPending={voiceCancellationPending}
            onTranscribe={
              preparationRef.current.active
                ? async (audio, durationMs) => {
                    if (!transcriptionProvider) {
                      throw new Error(t("Распознавание речи не настроено"));
                    }
                    const response = await api.transcribe(audio, durationMs);
                    onTranscriptionTimingEstimateChange?.(response.timingEstimate);
                    return response.text;
                  }
                : undefined
            }
            onRecordingReady={
              preparationRef.current.active
                ? undefined
                : (recording) => beginTranscription(activeThreadIdRef.current, recording)
            }
            transcriptionStatus={draftVoiceProgress}
            transcriptionError={
              voiceJob?.status === "failed"
                ? (localizeKnownServerText(language, voiceJob.error) ?? voiceJob.error)
                : null
            }
            error={error}
            hasSupplementalContent={annotations.length > 0}
          >
            {storageWarning && preparationRef.current.active && (
              <p className="new-session-storage-warning" role="status">
                {t(
                  "Локальное сохранение недоступно. Не закрывайте страницу, пока сессия не откроется.",
                )}
              </p>
            )}
            {error && preparationRef.current.active && (
              <button
                className="new-session-retry"
                type="button"
                disabled={preparationWorking || busy}
                onClick={() => {
                  if (!preparationRef.current.threadId) creationPromiseRef.current = null;
                  setPreparationRetry((value) => value + 1);
                }}
              >
                {t("Повторить")}
              </button>
            )}
            {teamUpgradeRequired && project && (
              <button
                className="team-session-upgrade"
                type="button"
                disabled={settingsBusy}
                onClick={() => void createManagedTeamSession()}
              >
                {t("Создать новую Team-сессию")}
              </button>
            )}
            {showScrollToBottom && (
              <button
                type="button"
                className="scroll-to-bottom"
                aria-label={t("Прокрутить к последнему сообщению")}
                onClick={() => {
                  followsTail.current = true;
                  scrollToEnd(scrollRef.current, "smooth");
                }}
              >
                <ArrowDownIcon />
              </button>
            )}
            <QueuedMessages
              messages={
                preparationRef.current.active
                  ? []
                  : mergeOptimisticQueue(detail?.queuedMessages ?? [], optimisticQueuedMessages)
              }
              action={queueAction}
              onSendNow={sendQueuedNow}
              onUpdate={updateQueued}
              onDelete={deleteQueued}
            />
          </Composer>
        )}
      </div>
      {showNewSessionChrome ? (
        <NewSessionInspector
          open={inspectorOpen}
          project={project}
          onClose={() => setInspectorOpen(false)}
        />
      ) : (
        <SessionInspector
          open={inspectorOpen}
          summary={workspaceSummary}
          project={project}
          gitChanges={gitChangesState?.threadId === threadId ? gitChangesState.value : null}
          onClose={() => setInspectorOpen(false)}
          onPin={togglePin}
          onArchive={toggleArchive}
          readOnly={isSubagent}
        />
      )}
      {inspectorOpen && (
        <button
          className="inspector-backdrop"
          aria-label={t("Закрыть сведения")}
          onClick={() => setInspectorOpen(false)}
        />
      )}
      {renaming && (
        <RenameDialog
          initialValue={workspaceSummary.title}
          onClose={() => setRenaming(false)}
          onRename={async (name) => {
            await api.updateThread(threadId, { name });
            setRenaming(false);
          }}
        />
      )}
    </div>
  );
}

export function VoiceTranscriptionBubble({ progress }: { progress: VoiceProgress }) {
  const { t } = useI18n();
  const label =
    progress.status === "uploading"
      ? t("Отправляем запись")
      : progress.status === "queued"
        ? t("На сервере · ожидание")
        : progress.status === "applying"
          ? t("Готовим отправку")
          : t("Распознаём");
  const timer =
    progress.status === "transcribing"
      ? formatVoiceTranscriptionTimer(progress.elapsedSeconds, progress.estimatedTotalSeconds)
      : formatVoiceClock(progress.elapsedSeconds);

  return (
    <article
      aria-label={label}
      aria-live="polite"
      className="message userMessage voice-transcription-message"
      role="status"
    >
      <div className="message-body">
        <span className="voice-transcription-icon" aria-hidden="true">
          {progress.status === "uploading" || progress.status === "applying" ? (
            <span className="spinner small" />
          ) : progress.status === "queued" ? (
            <CheckIcon />
          ) : (
            <MicrophoneIcon />
          )}
        </span>
        <span>{label}</span>
        <span className="voice-transcription-timer" aria-hidden="true">
          {timer}
        </span>
      </div>
    </article>
  );
}

function formatVoiceClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatVoiceTranscriptionTimer(
  elapsedSeconds: number,
  estimatedTotalSeconds: number | null,
): string {
  if (estimatedTotalSeconds === null) return formatVoiceClock(elapsedSeconds);
  if (elapsedSeconds <= estimatedTotalSeconds) {
    return `≈${formatVoiceClock(Math.max(0, estimatedTotalSeconds - elapsedSeconds))}`;
  }
  return `+${formatVoiceClock(elapsedSeconds - estimatedTotalSeconds)}`;
}

function hasMaterializedVoiceMessage(
  detail: ThreadDetail | undefined,
  optimisticMessages: OptimisticMessage[],
  voiceJobId: string,
): boolean {
  return Boolean(
    detail?.queuedMessages.some((message) => message.id === voiceJobId) ||
    optimisticMessages.some((message) => message.id === voiceJobId) ||
    detail?.turns.some((turn) =>
      turn.items.some((item) => item.type === "userMessage" && item.id === voiceJobId),
    ),
  );
}

function optimisticActivity(message: OptimisticMessage): ActivityItem {
  return {
    type: "userMessage",
    id: message.id,
    status: "completed",
    text: message.text,
    images: message.images,
    timestamp: message.createdAt,
    phase: null,
  };
}

function detachedOptimisticMessages(
  messages: OptimisticMessage[],
  turns: TurnView[],
  currentTurnId: string | null,
): OptimisticMessage[] {
  const loadedTurnIds = new Set(turns.map((turn) => turn.id));
  return messages.filter(
    (message) =>
      !(
        (message.turnId && loadedTurnIds.has(message.turnId)) ||
        (!message.turnId && currentTurnId && loadedTurnIds.has(currentTurnId))
      ),
  );
}

function mergeOptimisticQueue(
  messages: QueuedMessage[],
  optimistic: OptimisticMessage[],
): QueuedMessageView[] {
  const confirmedIds = new Set(messages.map((message) => message.id));
  return [
    ...messages.map((message) => ({ ...message, confirmed: true })),
    ...optimistic
      .filter((message) => !confirmedIds.has(message.id))
      .map((message) => ({
        id: message.id,
        threadId: message.threadId,
        text: message.text,
        ...(message.images.length ? { images: message.images } : {}),
        createdAt: message.createdAt,
        status: "queued" as const,
        confirmed: false,
      })),
  ];
}

function createClientMessageId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function MarkdownContent({
  text,
  cwd,
  onDownload,
}: {
  text: string;
  cwd?: string;
  onDownload?(path: string): Promise<void>;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        pre({ children }) {
          return <CopyableCodeBlock>{children}</CopyableCodeBlock>;
        },
        table({ children }) {
          return (
            <div className="markdown-table-scroll">
              <table>{children}</table>
            </div>
          );
        },
        a({ href, children, title }) {
          const path = cwd ? localDownloadPath(href, cwd) : null;
          return path && onDownload ? (
            <DownloadLink href={href!} path={path} title={title} onDownload={onDownload}>
              {children}
            </DownloadLink>
          ) : (
            <a href={href} title={title}>
              {children}
            </a>
          );
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

function CopyableCodeBlock({ children }: { children?: React.ReactNode }) {
  const { t } = useI18n();
  const preRef = useRef<HTMLPreElement>(null);
  const timerRef = useRef<number | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  async function copy() {
    const text = (preRef.current?.textContent ?? "").replace(/\n$/, "");
    try {
      await copyText(text);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopyState("idle"), 1_800);
  }

  const label =
    copyState === "copied"
      ? t("Блок скопирован")
      : copyState === "failed"
        ? t("Не удалось скопировать блок")
        : t("Копировать блок");

  return (
    <div className="markdown-code-block" data-copy-state={copyState}>
      <pre ref={preRef}>{children}</pre>
      <button
        type="button"
        className="markdown-code-copy"
        aria-label={label}
        aria-live="polite"
        title={label}
        onClick={() => void copy()}
      >
        {copyState === "copied" ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
  );
}

function DownloadLink({
  href,
  path,
  title,
  onDownload,
  children,
}: {
  href: string;
  path: string;
  title?: string;
  onDownload(path: string): Promise<void>;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const busyRef = useRef(false);

  async function download() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFailed(false);
    try {
      await onDownload(path);
    } catch {
      setFailed(true);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <span className="download-link-container">
      <a
        href={href}
        title={title}
        className="download-link"
        aria-busy={busy}
        aria-disabled={busy}
        onClick={(event) => {
          event.preventDefault();
          void download();
        }}
      >
        {children}
        {busy && <span className="download-link-status"> — {t("скачиваем…")}</span>}
      </a>
      {failed && (
        <span className="download-link-error" role="alert">
          {t("Не удалось скачать файл. Нажмите ещё раз.")}
        </span>
      )}
    </span>
  );
}

function localDownloadPath(href: string | undefined, cwd: string): string | null {
  if (!href?.startsWith("/")) return null;
  let path: string;
  try {
    path = decodeURI(href);
  } catch {
    return null;
  }
  const root = cwd.replace(/\/+$/, "") || "/";
  if (root === "/" || path === root || path.startsWith(`${root}/`)) return path;
  return null;
}

export function Activity({
  item,
  cwd,
  onDownload,
  annotations = [],
  annotationEnabled = false,
  annotationBusy = false,
  onCreateAnnotation,
  onUpdateAnnotation,
  onDeleteAnnotation,
}: {
  item: ActivityItem;
  cwd?: string;
  onDownload?(path: string): Promise<void>;
  annotations?: PendingAnnotation[];
  annotationEnabled?: boolean;
  annotationBusy?: boolean;
  onCreateAnnotation?(draft: AnnotationDraft): boolean;
  onUpdateAnnotation?(annotationId: string, comment: string): boolean;
  onDeleteAnnotation?(annotationId: string): boolean;
}) {
  const { language, t } = useI18n();
  if (!hasVisibleActivity(item)) return null;
  if (item.type === "userMessage" || item.type === "agentMessage") {
    const messageAnnotations = numberedAnnotations(annotations, item.id);
    return (
      <article
        className={`message ${item.type}`}
        data-message-id={item.type === "userMessage" ? item.id : undefined}
      >
        <div className="message-body">
          {item.text &&
            (item.type === "agentMessage" ? (
              <AnnotatableMarkdownContent
                text={item.text}
                messageId={item.id}
                source="agentMessage"
                cwd={cwd}
                onDownload={onDownload}
                annotations={messageAnnotations}
                enabled={annotationEnabled}
                readOnly={annotationBusy}
                onCreate={onCreateAnnotation}
                onUpdate={onUpdateAnnotation}
                onDelete={onDeleteAnnotation}
              />
            ) : (
              <MarkdownContent text={item.text} cwd={cwd} onDownload={onDownload} />
            ))}
          {item.images.length > 0 && <MessageImages images={item.images} />}
        </div>
        <MessageFooter text={item.text} timestamp={item.timestamp} />
      </article>
    );
  }
  if (item.type === "reasoning") {
    return (
      <article className="message reasoning">
        <div className="message-body">
          <MarkdownContent text={item.text} cwd={cwd} onDownload={onDownload} />
        </div>
        <MessageFooter text={item.text} timestamp={item.timestamp} />
      </article>
    );
  }
  if (item.type === "plan") {
    const messageAnnotations = numberedAnnotations(annotations, item.id);
    return (
      <article className="message plan">
        <div className="message-body">
          <div className="activity-label">{t("План")}</div>
          <AnnotatableMarkdownContent
            text={item.text}
            messageId={item.id}
            source="plan"
            cwd={cwd}
            onDownload={onDownload}
            annotations={messageAnnotations}
            enabled={annotationEnabled}
            readOnly={annotationBusy}
            onCreate={onCreateAnnotation}
            onUpdate={onUpdateAnnotation}
            onDelete={onDeleteAnnotation}
          />
        </div>
        <MessageFooter text={item.text} timestamp={item.timestamp} />
      </article>
    );
  }
  if (item.type === "userInputResponse") {
    const text = item.entries.flatMap((entry) => [entry.question, ...entry.answers]).join("\n");
    return (
      <article className="message userMessage user-input-response">
        <div className="message-body">
          {item.entries.map((entry, index) => (
            <section key={`${index}:${entry.header}:${entry.question}`}>
              <strong>{entry.header}</strong>
              <p>{entry.question}</p>
              {entry.answers.map((answer, answerIndex) => (
                <div className="user-input-answer" key={`${answerIndex}:${answer}`}>
                  {answer}
                </div>
              ))}
            </section>
          ))}
        </div>
        <MessageFooter text={text} timestamp={item.timestamp} />
      </article>
    );
  }
  if (item.type === "planChecklist") {
    return (
      <article className="message plan-checklist">
        <div className="activity-label">{t("Ход работы")}</div>
        {item.explanation && <p>{item.explanation}</p>}
        <ol>
          {item.steps.map((step, index) => {
            const status =
              item.status === "inProgress" || step.status === "completed" ? step.status : "pending";
            return (
              <li className={status} key={`${index}:${step.step}`}>
                <input
                  aria-label={status === "completed" ? t("Выполнено") : t("Не выполнено")}
                  checked={status === "completed"}
                  readOnly
                  tabIndex={-1}
                  type="checkbox"
                />
                <span>{step.step}</span>
                {status === "inProgress" && <span className="spinner small" />}
              </li>
            );
          })}
        </ol>
      </article>
    );
  }
  if (item.type === "subagentLaunch") {
    const label =
      item.status === "failed"
        ? t("Не удалось запустить субагента")
        : item.status === "inProgress"
          ? t("Запуск субагента")
          : t("Запущен субагент");
    return (
      <article className="message orchestration-notice">
        <div className="activity-label">{label}</div>
        <ul>
          <li>
            {item.threadId ? (
              <Link to={`/threads/${encodeURIComponent(item.threadId)}`}>{item.title}</Link>
            ) : (
              <strong>{item.title}</strong>
            )}
            {item.status !== "completed" && (
              <span>{item.status === "failed" ? t("Ошибка") : t("Выполняется")}</span>
            )}
          </li>
        </ul>
      </article>
    );
  }
  if (item.type === "orchestrationNotice") {
    return (
      <article className="message orchestration-notice">
        <div className="activity-label">
          {item.agents.length === 1
            ? t("Получен результат субагента")
            : t("Получены результаты субагентов")}
        </div>
        <ul>
          {item.agents.map((agent) => (
            <li key={agent.threadId}>
              <Link to={`/threads/${encodeURIComponent(agent.threadId)}`}>
                {agent.nickname ? `${agent.nickname} · ${agent.title}` : agent.title}
              </Link>
              <span>{orchestrationOutcomeLabel(agent.outcome, t)}</span>
            </li>
          ))}
        </ul>
      </article>
    );
  }
  if (item.type === "command") {
    return (
      <ActivityDetails
        icon={<TerminalIcon />}
        title={item.command || t("Выполнена команда")}
        status={item.status}
      >
        {item.cwd && <div className="path">{item.cwd}</div>}
        <pre>{item.output || `$ ${item.command}`}</pre>
        {item.exitCode !== null && <small>exit {item.exitCode}</small>}
      </ActivityDetails>
    );
  }
  if (item.type === "fileChange") {
    return (
      <ActivityDetails
        icon={<FileIcon />}
        title={item.path ? t("Изменён {{path}}", { path: item.path }) : t("Изменены файлы")}
        status={item.status}
      >
        <pre>{item.patch}</pre>
      </ActivityDetails>
    );
  }
  if (item.type === "tool") {
    return (
      <ActivityDetails icon={<ToolIcon />} title={item.title} status={item.status}>
        {item.detail && <p>{localizeKnownServerText(language, item.detail)}</p>}
      </ActivityDetails>
    );
  }
  if (item.type === "error" || item.type === "unsupported") {
    return (
      <article className="error-banner activity-error">
        <strong>{item.type === "unsupported" ? t("Несовместимое событие") : t("Ошибка")}</strong>
        <p>{localizeKnownServerText(language, item.message)}</p>
      </article>
    );
  }
  return null;
}

const MemoizedActivity = memo(Activity);

type NumberedAnnotation = {
  annotation: PendingAnnotation;
  number: number;
};

type AnnotationPosition = {
  left: number;
  top: number;
};

type SelectionDraft = AnnotationPosition & {
  quote: string;
  startOffset: number;
  endOffset: number;
  editorTop: number;
};

type AnnotationEditor =
  | ({ mode: "new" } & SelectionDraft)
  | ({ mode: "existing"; annotationId: string } & AnnotationPosition);

function numberedAnnotations(
  annotations: PendingAnnotation[],
  messageId: string,
): NumberedAnnotation[] {
  return annotations.flatMap((annotation, index) =>
    annotation.messageId === messageId ? [{ annotation, number: index + 1 }] : [],
  );
}

function AnnotatableMarkdownContent({
  text,
  messageId,
  source,
  cwd,
  onDownload,
  annotations,
  enabled,
  readOnly,
  onCreate,
  onUpdate,
  onDelete,
}: {
  text: string;
  messageId: string;
  source: "agentMessage" | "plan";
  cwd?: string;
  onDownload?(path: string): Promise<void>;
  annotations: NumberedAnnotation[];
  enabled: boolean;
  readOnly: boolean;
  onCreate?(draft: AnnotationDraft): boolean;
  onUpdate?(annotationId: string, comment: string): boolean;
  onDelete?(annotationId: string): boolean;
}) {
  const { t } = useI18n();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLFormElement>(null);
  const copyTimerRef = useRef<number | null>(null);
  const [selectionDraft, setSelectionDraft] = useState<SelectionDraft | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [editor, setEditor] = useState<AnnotationEditor | null>(null);
  const [comment, setComment] = useState("");
  const [markerPositions, setMarkerPositions] = useState<Record<string, AnnotationPosition>>({});

  const saveEditor = useCallback(() => {
    if (!editor) return true;
    const value = comment.trim();
    if (!value) {
      setEditor(null);
      return true;
    }
    const saved =
      editor.mode === "new"
        ? onCreate?.({
            messageId,
            source,
            quote: editor.quote,
            startOffset: editor.startOffset,
            endOffset: editor.endOffset,
            comment: value,
          })
        : onUpdate?.(editor.annotationId, value);
    if (saved) setEditor(null);
    return Boolean(saved);
  }, [comment, editor, messageId, onCreate, onUpdate, source]);

  const captureSelection = useCallback(() => {
    if (!enabled || editor) {
      setSelectionDraft(null);
      return;
    }
    const content = contentRef.current;
    const surface = surfaceRef.current;
    const selection = window.getSelection();
    if (!content || !surface || !selection || selection.rangeCount !== 1 || selection.isCollapsed) {
      setSelectionDraft(null);
      return;
    }
    const range = selection.getRangeAt(0);
    const quote = range.toString();
    const offsets = quote.trim() ? rangeOffsets(content, range) : null;
    if (!offsets) {
      setSelectionDraft(null);
      return;
    }
    const rect = safeRangeRect(range, content);
    const surfaceRect = surface.getBoundingClientRect();
    const selectionTop = rect.bottom - surfaceRect.top + 8;
    const editorTop =
      rect.bottom + 112 < window.innerHeight
        ? rect.bottom - surfaceRect.top + 8
        : rect.top - surfaceRect.top - 112;
    setSelectionDraft({
      quote,
      ...offsets,
      left: clampPopoverLeft(rect.left + rect.width / 2 - surfaceRect.left, surface.clientWidth),
      top: selectionTop,
      editorTop,
    });
  }, [editor, enabled]);

  const positionMarkers = useCallback(() => {
    const content = contentRef.current;
    const surface = surfaceRef.current;
    if (!content || !surface) return;
    const surfaceRect = surface.getBoundingClientRect();
    const next: Record<string, AnnotationPosition> = {};
    const occupied: AnnotationPosition[] = [];
    for (const { annotation } of annotations) {
      const range = resolveAnnotationRange(content, annotation);
      if (!range) continue;
      const rect = safeRangeRect(range, content);
      const position = {
        left: Math.max(0, Math.min(rect.right - surfaceRect.left + 4, surface.clientWidth - 22)),
        top: Math.max(0, rect.bottom - surfaceRect.top - 20),
      };
      while (
        occupied.some(
          (candidate) =>
            Math.abs(candidate.left - position.left) < 22 &&
            Math.abs(candidate.top - position.top) < 22,
        )
      ) {
        position.left += 22;
      }
      occupied.push(position);
      next[annotation.id] = position;
    }
    setMarkerPositions(next);
  }, [annotations]);

  useLayoutEffect(() => {
    positionMarkers();
  }, [positionMarkers, text]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(positionMarkers);
    observer?.observe(content);
    window.addEventListener("resize", positionMarkers);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", positionMarkers);
    };
  }, [positionMarkers]);

  useEffect(() => {
    if (!enabled) setSelectionDraft(null);
  }, [enabled]);

  useEffect(() => {
    if (readOnly) setEditor(null);
  }, [readOnly]);

  useEffect(() => {
    if (!editor) return;
    function closeOutside(event: PointerEvent) {
      if (event.target instanceof Node && editorRef.current?.contains(event.target)) return;
      if (!saveEditor()) {
        event.preventDefault();
        event.stopPropagation();
      }
    }
    document.addEventListener("pointerdown", closeOutside, true);
    return () => document.removeEventListener("pointerdown", closeOutside, true);
  }, [editor, saveEditor]);

  useEffect(() => {
    if (!enabled) return;
    let timer: number | null = null;
    const selectionChanged = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(captureSelection, 80);
    };
    document.addEventListener("selectionchange", selectionChanged);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("selectionchange", selectionChanged);
    };
  }, [captureSelection, enabled]);

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    },
    [],
  );

  async function copySelection() {
    if (!selectionDraft) return;
    try {
      await copyText(selectionDraft.quote);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => {
      setCopyState("idle");
      setSelectionDraft(null);
    }, 1_200);
  }

  function openNewEditor() {
    if (!selectionDraft) return;
    setComment("");
    setEditor({
      mode: "new",
      ...selectionDraft,
      left: clampEditorLeft(selectionDraft.left, surfaceRef.current?.clientWidth ?? 0),
      top: selectionDraft.editorTop,
    });
    setSelectionDraft(null);
    window.getSelection()?.removeAllRanges();
  }

  function openExistingEditor(item: NumberedAnnotation) {
    const position = markerPositions[item.annotation.id] ?? { left: 0, top: 0 };
    const surface = surfaceRef.current;
    const markerViewportTop = (surface?.getBoundingClientRect().top ?? 0) + position.top;
    setComment(item.annotation.comment);
    setEditor({
      mode: "existing",
      annotationId: item.annotation.id,
      left: clampEditorLeft(position.left, surface?.clientWidth ?? 0),
      top: markerViewportTop + 112 < window.innerHeight ? position.top + 28 : position.top - 112,
    });
    setSelectionDraft(null);
  }

  const editedAnnotation =
    editor?.mode === "existing"
      ? annotations.find(({ annotation }) => annotation.id === editor.annotationId)
      : null;

  return (
    <div className="annotation-surface" ref={surfaceRef}>
      <div
        className="message-markdown"
        ref={contentRef}
        onPointerUp={() => window.setTimeout(captureSelection, 0)}
        onKeyUp={captureSelection}
      >
        <MarkdownContent text={text} cwd={cwd} onDownload={onDownload} />
      </div>
      {annotations.map((item) => {
        const position = markerPositions[item.annotation.id];
        return position ? (
          <button
            type="button"
            className="annotation-marker"
            style={{ left: position.left, top: position.top }}
            aria-label={t("Аннотация {{number}}", { number: item.number })}
            disabled={readOnly}
            onClick={() => openExistingEditor(item)}
            key={item.annotation.id}
          >
            {item.number}
          </button>
        ) : null;
      })}
      {selectionDraft && (
        <div
          className="selection-actions"
          style={{ left: selectionDraft.left, top: selectionDraft.top }}
          onPointerDown={(event) => event.preventDefault()}
        >
          <button type="button" onClick={openNewEditor}>
            {t("Аннотация")}
          </button>
          <button type="button" onClick={() => void copySelection()}>
            {copyState === "copied"
              ? t("Скопировано")
              : copyState === "failed"
                ? t("Ошибка копирования")
                : t("Копировать")}
          </button>
        </div>
      )}
      {editor && (
        <form
          ref={editorRef}
          className="annotation-editor"
          style={{ left: editor.left, top: editor.top }}
          onSubmit={(event) => {
            event.preventDefault();
            saveEditor();
          }}
        >
          <textarea
            autoFocus
            aria-label={t("Комментарий к выделенному тексту")}
            placeholder={t("Комментарий")}
            rows={2}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
          <div className="annotation-editor-actions">
            <button
              className="annotation-editor-save"
              type="submit"
              aria-label={t("Сохранить аннотацию")}
              disabled={!comment.trim()}
            >
              <SendIcon />
            </button>
            <button
              className="annotation-editor-delete"
              type="button"
              aria-label={t("Удалить аннотацию")}
              onClick={() => {
                if (!editedAnnotation || onDelete?.(editedAnnotation.annotation.id)) {
                  setEditor(null);
                }
              }}
            >
              <TrashIcon />
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function safeRangeRect(range: Range, fallback: HTMLElement): DOMRect {
  return typeof range.getBoundingClientRect === "function"
    ? range.getBoundingClientRect()
    : fallback.getBoundingClientRect();
}

function clampPopoverLeft(left: number, width: number): number {
  if (width <= 0) return Math.max(0, left);
  return Math.max(76, Math.min(left, width - 76));
}

function clampEditorLeft(left: number, width: number): number {
  if (width <= 0) return Math.max(0, left);
  const halfWidth = Math.min(160, width / 2);
  return Math.max(halfWidth, Math.min(left, width - halfWidth));
}

function ActivityGroup({
  items,
  cwd,
  onDownload,
}: {
  items: ActivityItem[];
  cwd: string;
  onDownload(path: string): Promise<void>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const inProgress = items.some((item) => item.status === "inProgress");
  const labels: string[] = [];
  if (items.some((item) => item.type === "command" && item.kind === "read")) {
    labels.push(t("Прочитаны файлы"));
  }
  if (items.some((item) => item.type === "command" && item.kind === "search")) {
    labels.push(t("Выполнен поиск"));
  }
  if (items.some((item) => item.type === "command" && item.kind === "command")) {
    labels.push(t("Выполнены команды"));
  }
  if (items.some((item) => item.type === "fileChange")) labels.push(t("Отредактированы файлы"));
  if (items.some((item) => item.type === "tool")) labels.push(t("Использованы инструменты"));
  return (
    <details className="activity-group" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span className="activity-group-icon">
          <ToolIcon />
        </span>
        <span>{labels.join(" · ") || t("Выполнены действия")}</span>
        {inProgress && <span className="spinner small" />}
      </summary>
      {open && (
        <div className="activity-group-content">
          {items.map((item) => (
            <MemoizedActivity item={item} cwd={cwd} onDownload={onDownload} key={item.id} />
          ))}
        </div>
      )}
    </details>
  );
}

const MemoizedActivityGroup = memo(ActivityGroup);

function LazyTechnicalDetails({
  items,
  loaded,
  onLoad,
  cwd,
  onDownload,
}: {
  items: ActivityItem[];
  loaded: boolean;
  onLoad(): Promise<void>;
  cwd: string;
  onDownload(path: string): Promise<void>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const load = useCallback(() => {
    if (loading || loaded) return;
    setLoading(true);
    setError(false);
    void onLoad()
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [loaded, loading, onLoad]);

  if (loaded && items.length === 0) return null;
  return (
    <details
      className="activity-group technical-details"
      onToggle={(event) => {
        const nextOpen = event.currentTarget.open;
        setOpen(nextOpen);
        if (nextOpen) load();
      }}
    >
      <summary>
        <span className="activity-group-icon">
          <ToolIcon />
        </span>
        <span>{t("Технические детали")}</span>
        {loading && <span className="spinner small" />}
      </summary>
      {open && (
        <div className="activity-group-content">
          {error && (
            <button type="button" className="history-retry" onClick={load}>
              {t("Повторить загрузку технических деталей")}
            </button>
          )}
          {loaded &&
            items.map((item) => (
              <MemoizedActivity item={item} cwd={cwd} onDownload={onDownload} key={item.id} />
            ))}
        </div>
      )}
    </details>
  );
}

function QueuedMessages({
  messages,
  action,
  onSendNow,
  onUpdate,
  onDelete,
}: {
  messages: QueuedMessageView[];
  action: QueueAction | null;
  onSendNow(messageId: string): Promise<boolean>;
  onUpdate(messageId: string, value: string): Promise<boolean>;
  onDelete(messageId: string): Promise<boolean>;
}) {
  const { t } = useI18n();
  const [editor, setEditor] = useState<{ messageId: string; value: string } | null>(null);

  useEffect(() => {
    if (
      editor &&
      !messages.some(
        (message) =>
          message.id === editor.messageId && message.confirmed && message.status === "queued",
      )
    ) {
      setEditor(null);
    }
  }, [editor, messages]);

  if (!messages.length) return null;
  return (
    <section className="queued-messages" aria-label={t("Очередь сообщений")}>
      <header className="queued-messages-header">
        <span>{t("Очередь сообщений")}</span>
        <span>{messages.length}</span>
      </header>
      <div className="queued-messages-list">
        {messages.map((message) => {
          const editing = editor?.messageId === message.id;
          const busy = action?.messageId === message.id;
          const actionsDisabled =
            action !== null || !message.confirmed || message.status === "dispatching";
          const editValue = editing ? editor.value : "";
          const canSave =
            Boolean(editValue.trim() || message.images?.length) &&
            editValue.trim() !== message.text;
          const status = !message.confirmed
            ? t("Добавляется…")
            : action?.messageId === message.id && action.kind === "delete"
              ? t("Удаляем…")
              : action?.messageId === message.id && action.kind === "update"
                ? t("Сохраняем…")
                : message.status === "dispatching" ||
                    (action?.messageId === message.id && action.kind === "send")
                  ? t("Отправляется…")
                  : t("В очереди");
          return (
            <article className="queued-message" data-message-id={message.id} key={message.id}>
              <div className="queued-message-heading">
                <span>{status}</span>
                <div className="queued-message-actions">
                  {!editing && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={t("Изменить сообщение в очереди")}
                      disabled={actionsDisabled}
                      onClick={() => setEditor({ messageId: message.id, value: message.text })}
                    >
                      <PencilIcon />
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-button danger"
                    aria-label={t("Удалить сообщение из очереди")}
                    disabled={actionsDisabled}
                    onClick={() => void onDelete(message.id)}
                  >
                    <TrashIcon />
                  </button>
                  <button
                    type="button"
                    className="queued-message-send"
                    disabled={actionsDisabled}
                    onClick={() => void onSendNow(message.id)}
                  >
                    {t("Отправить сейчас")}
                  </button>
                </div>
              </div>
              {editing ? (
                <div className="queued-message-editor">
                  <textarea
                    autoFocus
                    aria-label={t("Текст сообщения в очереди")}
                    rows={3}
                    value={editValue}
                    disabled={busy}
                    onChange={(event) =>
                      setEditor({ messageId: message.id, value: event.target.value })
                    }
                  />
                  <div className="queued-message-editor-actions">
                    <button type="button" disabled={busy} onClick={() => setEditor(null)}>
                      {t("Отмена")}
                    </button>
                    <button
                      type="button"
                      className="primary"
                      disabled={busy || !canSave}
                      onClick={() => {
                        void onUpdate(message.id, editValue).then((saved) => {
                          if (saved) setEditor(null);
                        });
                      }}
                    >
                      {busy ? t("Сохраняем…") : t("Сохранить")}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {message.text && <div className="queued-message-text">{message.text}</div>}
                  {(message.images?.length ?? 0) > 0 && (
                    <MessageImages images={message.images ?? []} />
                  )}
                </>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function MessageImages({ images }: { images: string[] }) {
  const { t } = useI18n();
  const [viewer, setViewer] = useState<{ index: number; opener: HTMLButtonElement } | null>(null);
  const viewerImages = images.map((src, index) => ({
    src,
    alt: t("Изображение {{number}}", { number: index + 1 }),
  }));

  useEffect(() => {
    if (viewer && viewer.index >= images.length) setViewer(null);
  }, [images.length, viewer]);

  return (
    <>
      <div className="message-images">
        {viewerImages.map((image, index) => (
          <button
            type="button"
            className="message-image-preview"
            aria-label={t("Открыть изображение {{number}}", { number: index + 1 })}
            key={`${index}:${image.src.slice(-24)}`}
            onClick={(event) => setViewer({ index, opener: event.currentTarget })}
          >
            <img src={image.src} alt={image.alt} />
          </button>
        ))}
      </div>
      {viewer && (
        <ImageViewer
          images={viewerImages}
          index={viewer.index}
          opener={viewer.opener}
          onIndexChange={(index) => setViewer({ ...viewer, index })}
          onClose={() => setViewer(null)}
        />
      )}
    </>
  );
}

function MessageFooter({ text, timestamp }: { text: string; timestamp: number | null }) {
  const { language, t } = useI18n();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const timerRef = useRef<number | null>(null);
  const canCopy = Boolean(text.trim());

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  async function copy() {
    try {
      await copyText(text);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopyState("idle"), 1_800);
  }

  return (
    <footer className="message-footer">
      {copyState === "copied" && <span role="status">{t("Скопировано")}</span>}
      {copyState === "failed" && <span role="alert">{t("Не удалось скопировать")}</span>}
      {timestamp !== null && (
        <time dateTime={new Date(timestamp).toISOString()}>
          {formatMessageTime(timestamp, language)}
        </time>
      )}
      {canCopy && (
        <button type="button" aria-label={t("Копировать сообщение")} onClick={() => void copy()}>
          <CopyIcon />
        </button>
      )}
    </footer>
  );
}

export function TurnTiming({
  turn,
  active = turn.status === "inProgress",
}: {
  turn: TurnView;
  active?: boolean;
}) {
  const { language, t } = useI18n();
  const startedAt = turn.startedAt ?? turn.progress.startedAt;
  if (active) return <ActiveTurnStatus progress={{ ...turn.progress, startedAt }} />;
  if (turn.status === "inProgress" || startedAt === null) return null;
  const duration =
    turn.durationMs ??
    (turn.completedAt === null ? null : Math.max(0, turn.completedAt - startedAt));
  return duration === null ? null : (
    <div className="turn-timing">
      {t("Работал {{duration}}", { duration: formatDuration(duration, language) })}
    </div>
  );
}

const MemoizedTurnTiming = memo(TurnTiming);

function ActiveTurnStatus({ progress }: { progress?: TurnProgress }) {
  const { language, t } = useI18n();
  const startedAt = progress?.startedAt ?? null;
  const elapsed = useElapsed(startedAt ?? 0, startedAt !== null, language);
  const label = progress?.explanation?.trim() || t("Codex работает");
  return (
    <div className="turn-timing active" role="status">
      <span className="spinner small" />
      <span>
        {label}
        {startedAt !== null ? ` ${elapsed}` : "…"}
      </span>
    </div>
  );
}

export function formatMessageTime(timestamp: number, language: UiLanguage = "ru"): string {
  const value = new Date(timestamp);
  const today = new Date();
  const locale = language === "ru" ? "ru-RU" : "en-US";
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
  if (value.toDateString() === today.toDateString()) return time;
  return `${new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", year: "numeric" }).format(value)}, ${time}`;
}

function useElapsed(startedAt: number, active = true, language: UiLanguage = "ru"): string {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active, startedAt]);
  return formatDuration(Math.max(0, now - startedAt), language);
}

function formatDuration(durationMs: number, language: UiLanguage = "ru"): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (language === "en") {
    if (hours) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
  }
  if (hours) return `${hours}ч ${minutes % 60}м ${seconds % 60}с`;
  return minutes ? `${minutes}м ${seconds % 60}с` : `${seconds}с`;
}

function groupActivities(items: ActivityItem[]): Array<ActivityItem | ActivityItem[]> {
  const result: Array<ActivityItem | ActivityItem[]> = [];
  let group: ActivityItem[] = [];
  const flush = () => {
    if (group.length) result.push(group);
    group = [];
  };
  for (const item of activitiesForDisplay(items)) {
    if (!hasVisibleActivity(item)) continue;
    if (["command", "fileChange", "tool"].includes(item.type)) {
      group.push(item);
    } else {
      flush();
      result.push(item);
    }
  }
  flush();
  return result;
}

function isTechnicalActivity(item: ActivityItem): boolean {
  return ["reasoning", "command", "fileChange", "tool"].includes(item.type);
}

function activitiesForThreadDisplay(items: ActivityItem[], isSubagent: boolean): ActivityItem[] {
  if (!isSubagent) return items;
  return items.filter((item) => item.type === "userMessage" || item.type === "agentMessage");
}

function activitiesForDisplay(items: ActivityItem[]): ActivityItem[] {
  const finalAnswerIndex = items.findIndex(
    (item) => item.type === "agentMessage" && item.phase === "final_answer",
  );
  if (finalAnswerIndex < 0) return items;
  const trailingItems = items.slice(finalAnswerIndex + 1);
  const trailingChecklists = trailingItems.filter((item) => item.type === "planChecklist");
  if (!trailingChecklists.length) return items;
  return [
    ...items.slice(0, finalAnswerIndex),
    ...trailingChecklists,
    items[finalAnswerIndex]!,
    ...trailingItems.filter((item) => item.type !== "planChecklist"),
  ];
}

function completedChatLooksIncomplete(
  state: ThreadState,
  detail: ThreadDetail | undefined,
): boolean {
  if (state !== "completed" || !detail?.turns.length) return false;
  const latestTurn = detail.turns.at(-1)!;
  if (latestTurn.status === "inProgress") return true;
  return !latestTurn.items.some(
    (item) =>
      item.type === "agentMessage" &&
      item.phase === "final_answer" &&
      Boolean(item.text.trim() || item.images.length),
  );
}

function reconcileVisibleThreadSummary(
  snapshotSummary: ThreadSummary | undefined,
  detail: ThreadDetail | undefined,
): ThreadSummary | undefined {
  if (!snapshotSummary) return detail?.summary;
  if (snapshotSummary.currentTurnId) return snapshotSummary;
  if (detail?.summary.currentTurnId && detail.summary.updatedAt >= snapshotSummary.updatedAt) {
    return detail.summary;
  }
  return snapshotSummary;
}

function hasVisibleActivity(item: ActivityItem): boolean {
  if ("text" in item) return Boolean(item.text.trim() || item.images.length);
  return true;
}

function orchestrationOutcomeLabel(
  outcome: "completed" | "failed" | "interrupted",
  t: Translate,
): string {
  if (outcome === "failed") return t("Ошибка");
  if (outcome === "interrupted") return t("Прервана");
  return t("Завершена");
}

function findLatestCompletedPlan(detail?: ThreadDetail): string | null {
  const turn = detail?.turns.at(-1);
  if (!turn || turn.status === "inProgress") return null;
  return (
    [...turn.items].reverse().find((item) => item.type === "plan" && item.status === "completed")
      ?.id ?? null
  );
}

function findLatestAnnotatable(
  detail: ThreadDetail | undefined,
  currentTurnId: string | null,
): string | null {
  if (!detail || currentTurnId) return null;
  for (const turn of [...detail.turns].reverse()) {
    if (turn.status === "inProgress") continue;
    for (const item of [...turn.items].reverse()) {
      if (
        (item.type === "agentMessage" || item.type === "plan") &&
        item.status === "completed" &&
        Boolean(item.text.trim())
      ) {
        return item.id;
      }
    }
  }
  return null;
}

function scrollToEnd(node: HTMLDivElement | null, behavior: ScrollBehavior = "auto") {
  if (!node) return;
  if (typeof node.scrollTo === "function") {
    node.scrollTo({ top: node.scrollHeight, behavior });
  } else {
    node.scrollTop = node.scrollHeight;
  }
}

function ActivityDetails({
  icon,
  title,
  status,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  status: string;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <details className="activity-card" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span className="activity-icon">{icon}</span>
        <span className="activity-title">{title}</span>
        <span className={`activity-status activity-status-${status}`}>
          {statusLabel(status, t)}
        </span>
      </summary>
      {open && <div className="activity-content">{children}</div>}
    </details>
  );
}

function RenameDialog({
  initialValue,
  onClose,
  onRename,
}: {
  initialValue: string;
  onClose(): void;
  onRename(value: string): Promise<void>;
}) {
  const { language, t } = useI18n();
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form
        className="modal compact"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (!value.trim()) return;
          setBusy(true);
          setError(null);
          void onRename(value.trim())
            .catch((caught: Error) => setError(localizeKnownServerText(language, caught.message)))
            .finally(() => setBusy(false));
        }}
      >
        <div className="row-between">
          <div>
            <span className="dialog-eyebrow">{t("Задача")}</span>
            <h2>{t("Переименовать")}</h2>
          </div>
          <button type="button" className="icon-button" aria-label={t("Закрыть")} onClick={onClose}>
            <XIcon />
          </button>
        </div>
        <label>
          {t("Название")}
          <input autoFocus value={value} onChange={(event) => setValue(event.target.value)} />
        </label>
        {error && <div className="error-banner">{error}</div>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            {t("Отмена")}
          </button>
          <button className="primary" disabled={busy || !value.trim()}>
            {busy ? t("Сохраняем…") : t("Сохранить")}
          </button>
        </div>
      </form>
    </div>
  );
}

function statusLabel(status: string, t: Translate): string {
  return status === "inProgress"
    ? t("выполняется")
    : status === "failed"
      ? t("ошибка")
      : t("готово");
}
