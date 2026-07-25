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
import { useLocation, useNavigate, useParams } from "react-router";

import type {
  ActivityItem,
  GitChangesSummary,
  QueuedMessage,
  ThreadDetail,
  ThreadDraft,
  ThreadState,
  TranscriptionConfigResponse,
  TranscriptionProvider,
  TurnProgress,
  TurnView,
  UiLanguage,
  UpdateThreadDraftRequest,
  UpdateThreadGoalRequest,
  UpdateThreadSettingsRequest,
  VoiceInputMode,
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
import { openDownloadUrl } from "../downloads";
import { localizeKnownServerText, type Translate, useI18n } from "../i18n";
import type { OptimisticMessage } from "../state";
import { AttentionPanel } from "./AttentionPanel";
import { Composer, type ComposerImage, type ComposerRecording } from "./Composer";
import {
  ArchiveIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  FileIcon,
  MoreIcon,
  MicrophoneIcon,
  PencilIcon,
  PinIcon,
  SendIcon,
  TerminalIcon,
  ToolIcon,
  TrashIcon,
  XIcon,
} from "./Icons";
import { ImageViewer } from "./ImageViewer";
import { SessionInspector, type GitChangesView } from "./SessionInspector";
import { WorkspaceHeader } from "./WorkspaceHeader";

type ComposerDraftState = {
  threadId: string;
  value: UpdateThreadDraftRequest;
};

type QueueAction = {
  messageId: string;
  kind: "send" | "update" | "delete";
};

type QueuedMessageView = QueuedMessage & {
  confirmed: boolean;
};

type VoiceUploadState = {
  mode: VoiceInputMode;
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

const VOICE_INPUT_MODE_KEY = "codexnest.voiceInputMode";
const COMPLETED_CHAT_RETRY_MS = 500;

function readVoiceInputMode(): VoiceInputMode {
  return localStorage.getItem(VOICE_INPUT_MODE_KEY) === "send" ? "send" : "draft";
}

export function ThreadPage({
  transcriptionConfig = null,
  transcriptionProvider = null,
  onOpenNavigation,
}: {
  transcriptionConfig?: TranscriptionConfigResponse | null;
  transcriptionProvider?: TranscriptionProvider | null;
  onOpenNavigation(): void;
}) {
  const { threadId = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { language, t } = useI18n();
  const languageRef = useRef(language);
  languageRef.current = language;
  const { api, state, dispatch, refreshDetail, loadOlderDetail } = useConnection();
  const summary = state.snapshot?.threads.find((thread) => thread.id === threadId);
  const project =
    state.snapshot?.projects.find((candidate) => candidate.id === summary?.projectId) ?? null;
  const detail = state.details[threadId];
  const [composerDraftState, setComposerDraftState] = useState<ComposerDraftState>(() => ({
    threadId,
    value: emptyComposerDraft(),
  }));
  const activeComposerDraft =
    composerDraftState.threadId === threadId ? composerDraftState.value : emptyComposerDraft();
  const { input, images, goalMode, annotations } = activeComposerDraft;
  const [goalBusy, setGoalBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [queueAction, setQueueAction] = useState<QueueAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [voiceMode, setVoiceMode] = useState<VoiceInputMode>(readVoiceInputMode);
  const [voiceUploads, setVoiceUploads] = useState<Record<string, VoiceUploadState>>({});
  const [transcriptionElapsedSeconds, setTranscriptionElapsedSeconds] = useState(0);
  const handledVoiceRemovalsRef = useRef(new Set<string>());
  const [renaming, setRenaming] = useState(false);
  const [attentionJump, setAttentionJump] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialScrollThread = useRef<string | null>(null);
  const followsTail = useRef(true);
  const previousAttentionIds = useRef<string | null>(null);
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
    new Map<string, { revision: number; value: UpdateThreadDraftRequest }>(),
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
    () => state.snapshot?.attention.filter((item) => item.threadId === threadId) ?? [],
    [state.snapshot?.attention, threadId],
  );
  const goal = state.goals?.[threadId];
  const voiceJob =
    state.snapshot?.voiceTranscriptions?.find((job) => job.threadId === threadId) ?? null;
  const voiceRemoval = state.voiceRemovals?.[threadId];
  const activeVoiceJob = voiceJob?.status === "failed" ? null : voiceJob;
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
      new Map((detail?.turns ?? []).map((turn) => [turn.id, groupActivities(turn.items)] as const)),
    [detail?.turns],
  );
  const voiceMessageMaterialized = activeVoiceJob
    ? hasMaterializedVoiceMessage(detail, optimisticMessages, activeVoiceJob.id)
    : false;
  const draftVoiceProgress: VoiceProgress | null =
    activeVoiceJob?.mode === "draft"
      ? {
          status: activeVoiceJob.status as Exclude<VoiceTranscriptionStatus, "failed">,
          elapsedSeconds: transcriptionElapsedSeconds,
          estimatedTotalSeconds: activeVoiceJob.estimatedTotalSeconds,
        }
      : voiceUpload?.mode === "draft"
        ? {
            status: "uploading",
            elapsedSeconds: transcriptionElapsedSeconds,
            estimatedTotalSeconds: null,
          }
        : null;
  const autoVoiceProgress: VoiceProgress | null =
    activeVoiceJob?.mode === "send" && !voiceMessageMaterialized
      ? {
          status: activeVoiceJob.status as Exclude<VoiceTranscriptionStatus, "failed">,
          elapsedSeconds: transcriptionElapsedSeconds,
          estimatedTotalSeconds: activeVoiceJob.estimatedTotalSeconds,
        }
      : voiceUpload?.mode === "send"
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

  function currentComposerDraft(): UpdateThreadDraftRequest {
    return composerDraftRef.current.threadId === threadId
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
          savedDraftUpdatedAtRef.current.set(targetThreadId, saved?.updatedAt ?? null);
          dispatch({ type: "draft", threadId: targetThreadId, draft: saved });
          if (legacyAnnotationThreadsRef.current.delete(targetThreadId)) {
            try {
              savePendingAnnotations(targetThreadId, []);
            } catch {
              // The server copy is authoritative once it has been accepted.
            }
          }
        } catch (caught) {
          if (composerDraftRef.current.threadId === targetThreadId) {
            setError(
              caught instanceof Error
                ? localizeKnownServerText(language, caught.message)
                : t("Не удалось сохранить черновик"),
            );
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
    pendingDraftsRef.current.set(targetThreadId, { revision, value });
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
    const next = { threadId, value };
    composerDraftRef.current = next;
    setComposerDraftState(next);
    if (!persistence) return;
    draftTouchedThreadsRef.current.add(threadId);
    scheduleDraftSave(threadId, value, persistence === "immediate");
  }

  function setInput(value: string): void {
    replaceComposerDraft({ ...currentComposerDraft(), input: value }, "debounced");
  }

  function setImages(value: ComposerImage[]): void {
    replaceComposerDraft({ ...currentComposerDraft(), images: value }, "immediate");
  }

  function setGoalMode(value: boolean): void {
    const current = currentComposerDraft();
    if (current.goalMode === value) return;
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
    const uploadMode = voiceMode;
    setVoiceUploads((current) => ({
      ...current,
      [targetThreadId]: { mode: uploadMode, startedAt: Date.now() },
    }));
    try {
      await flushDraft(targetThreadId);
      if (pendingDraftsRef.current.has(targetThreadId)) {
        throw new Error(t("Не удалось сохранить черновик"));
      }
      const expectedDraftUpdatedAt = savedDraftUpdatedAtRef.current.has(targetThreadId)
        ? savedDraftUpdatedAtRef.current.get(targetThreadId)!
        : (state.details[targetThreadId]?.draft?.updatedAt ?? null);
      const accepted = await api.createVoiceTranscription(targetThreadId, recording.audio, {
        recordingDurationMs: recording.durationMs,
        mode: uploadMode,
        selectionStart: recording.selection.start,
        selectionEnd: recording.selection.end,
        draftUpdatedAt: expectedDraftUpdatedAt,
      });
      dispatch({ type: "voice.accepted", job: accepted });
    } finally {
      setVoiceUploads((current) => {
        const next = { ...current };
        delete next[targetThreadId];
        return next;
      });
    }
  }

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
    if (voiceRemoval.outcome === "cancelled") return;
    if (voiceRemoval.outcome === "send") {
      pendingDraftsRef.current.delete(threadId);
      savedDraftUpdatedAtRef.current.set(threadId, null);
      draftTouchedThreadsRef.current.delete(threadId);
      hydratedDraftSourcesRef.current.delete(threadId);
      replaceComposerDraft(emptyComposerDraft(), false);
      dispatch({ type: "draft", threadId, draft: null });
      clearLegacyAnnotations();
      void refreshDetail(threadId, { force: true }).catch((caught: Error) => {
        setError(localizeKnownServerText(languageRef.current, caught.message));
      });
      return;
    }
    draftTouchedThreadsRef.current.delete(threadId);
    hydratedDraftSourcesRef.current.delete(threadId);
    void refreshDetail(threadId, { force: true }).catch((caught: Error) => {
      setError(localizeKnownServerText(languageRef.current, caught.message));
    });
  }, [refreshDetail, threadId, voiceRemoval]);

  useEffect(() => {
    if (goal) setGoalMode(false);
  }, [goal]);

  useEffect(() => {
    draftTouchedThreadsRef.current.delete(threadId);
    hydratedDraftSourcesRef.current.delete(threadId);
    return () => {
      void flushDraft(threadId);
    };
  }, [threadId]);

  useEffect(() => {
    if (!detail) return;
    if (draftTouchedThreadsRef.current.has(threadId)) return;
    const detailDraft = detail.draft ?? null;
    savedDraftUpdatedAtRef.current.set(threadId, detailDraft?.updatedAt ?? null);
    if (hydratedDraftSourcesRef.current.get(threadId) === detailDraft) return;
    const localAnnotations = loadPendingAnnotations(threadId);
    const serverDraft = detailDraft
      ? {
          input: detailDraft.input,
          images: detailDraft.images,
          goalMode: detailDraft.goalMode,
          annotations: detailDraft.annotations,
        }
      : emptyComposerDraft();
    const knownIds = new Set(serverDraft.annotations.map((annotation) => annotation.id));
    const mergedAnnotations = [
      ...serverDraft.annotations,
      ...localAnnotations.filter((annotation) => !knownIds.has(annotation.id)),
    ].sort((a, b) => a.createdAt - b.createdAt);
    const next = { ...serverDraft, annotations: mergedAnnotations };
    hydratedDraftSourcesRef.current.set(threadId, detailDraft);
    replaceComposerDraft(next, localAnnotations.length ? "immediate" : false);
    if (localAnnotations.length) legacyAnnotationThreadsRef.current.add(threadId);
  }, [detail, threadId]);

  useEffect(() => {
    const flushBeforePageExit = () => {
      void flushDraft(threadId, true);
    };
    window.addEventListener("pagehide", flushBeforePageExit);
    return () => window.removeEventListener("pagehide", flushBeforePageExit);
  }, [threadId]);

  useEffect(() => {
    if (!threadId) return;
    const request = api.readGoal?.(threadId);
    if (!request) return;
    void request
      .then((value) => dispatch({ type: "goal", threadId, goal: value }))
      .catch((caught: Error) =>
        setError(localizeKnownServerText(languageRef.current, caught.message)),
      );
  }, [api, dispatch, threadId]);

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
    if (threadId) {
      void refreshDetail(threadId, { force: true }).catch((caught: Error) =>
        setError(localizeKnownServerText(languageRef.current, caught.message)),
      );
    }
  }, [threadId, refreshDetail, state.snapshotEpoch]);

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
      void refreshDetail(threadId, { force: true }).catch((caught: Error) => {
        if (completedChatRetry.current?.key !== key) return;
        setError(localizeKnownServerText(languageRef.current, caught.message));
      });
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
    void refreshDetail(threadId, { force: true }).catch((caught: Error) => {
      detailReconcileKey.current = null;
      setError(localizeKnownServerText(languageRef.current, caught.message));
    });
  }, [detail, refreshDetail, summary?.currentTurnId, threadId]);

  useEffect(() => {
    if (summary?.unread && detail && summary.state === "failed") {
      void api.markRead(threadId, { observedUpdatedAt: summary.updatedAt }).catch(() => undefined);
    }
  }, [api, detail, summary, threadId]);

  useLayoutEffect(() => {
    if (!detail || initialScrollThread.current === threadId) return;
    initialScrollThread.current = threadId;
    followsTail.current = true;
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
    setAttentionJump(false);
    if (typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } else {
      scrollToEnd(node, "smooth");
    }
    scrollTargetMessageId.current = null;
  }, [detail, optimisticMessages, threadId]);

  useEffect(() => {
    const ids = attention.map((request) => request.id).join(":");
    if (
      previousAttentionIds.current !== null &&
      ids !== previousAttentionIds.current &&
      attention.length > 0 &&
      !followsTail.current
    ) {
      setAttentionJump(true);
    }
    previousAttentionIds.current = ids;
  }, [attention]);

  const loadOlder = useCallback(async () => {
    const cursor = detail?.olderTurnsCursor;
    const node = scrollRef.current;
    if (!cursor || !node || loadingOlder) return;
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
  }, [detail?.olderTurnsCursor, loadOlderDetail, loadingOlder, threadId]);

  function persistAnnotations(next: PendingAnnotation[]): boolean {
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

  function clearLegacyAnnotations() {
    try {
      savePendingAnnotations(threadId, []);
    } catch {
      // The sent server draft is already authoritative.
    }
    legacyAnnotationThreadsRef.current.delete(threadId);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const submittedComposerInput = input;
    const submittedAnnotations = annotations;
    const submittedInput = formatAnnotatedMessage(
      submittedComposerInput,
      submittedAnnotations,
      language,
    );
    if ((!submittedInput.trim() && !images.length) || (goalMode && !input.trim())) return;
    const submittedImages = images;
    const submittedGoalMode = goalMode;
    const submittedDraft = structuredClone(activeComposerDraft);
    const clientMessageId = createClientMessageId();
    const optimisticMessage: OptimisticMessage = {
      id: clientMessageId,
      threadId,
      text: submittedInput.trim(),
      images: submittedImages.map((image) => image.url),
      createdAt: Date.now(),
      destination: summary!.currentTurnId ? "queue" : "turn",
      turnId: null,
    };
    setBusy(true);
    setError(null);
    scrollTargetMessageId.current = clientMessageId;
    dispatch({ type: "optimistic.add", message: optimisticMessage });
    replaceComposerDraft(emptyComposerDraft(), false);
    await flushDraft();
    try {
      if (summary!.currentTurnId) {
        await api.enqueue(threadId, {
          input: submittedInput,
          ...(submittedImages.length ? { images: submittedImages.map((image) => image.url) } : {}),
          clientMessageId,
        });
      } else {
        const result = await api.startTurn(threadId, {
          input: submittedInput,
          ...(submittedImages.length ? { images: submittedImages.map((image) => image.url) } : {}),
          ...(submittedGoalMode ? { goal: true } : {}),
          clientMessageId,
        });
        dispatch({
          type: "optimistic.accept",
          threadId,
          messageId: clientMessageId,
          turnId: result.turnId,
        });
        if (result.goalWarning) setError(localizeKnownServerText(language, result.goalWarning));
      }
      pendingDraftsRef.current.delete(threadId);
      savedDraftUpdatedAtRef.current.set(threadId, null);
      dispatch({ type: "draft", threadId, draft: null });
      clearLegacyAnnotations();
    } catch (caught) {
      dispatch({ type: "optimistic.remove", threadId, messageId: clientMessageId });
      replaceComposerDraft(submittedDraft, false);
      setError(
        caught instanceof Error
          ? localizeKnownServerText(language, caught.message)
          : t("Не удалось отправить сообщение"),
      );
    } finally {
      setBusy(false);
    }
  }

  async function implementPlan() {
    setBusy(true);
    setError(null);
    let changedMode = false;
    let clientMessageId: string | null = null;
    try {
      const thread = await api.updateThreadSettings(threadId, { collaborationMode: "default" });
      changedMode = true;
      dispatch({ type: "thread", thread });
      clientMessageId = createClientMessageId();
      scrollTargetMessageId.current = clientMessageId;
      dispatch({
        type: "optimistic.add",
        message: {
          id: clientMessageId,
          threadId,
          text: t("Да, реализуй этот план"),
          images: [],
          createdAt: Date.now(),
          destination: "turn",
          turnId: null,
        },
      });
      const result = await api.startTurn(threadId, {
        input: t("Да, реализуй этот план"),
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
    setSettingsBusy(true);
    setError(null);
    try {
      const thread = await api.updateThreadSettings(threadId, patch);
      dispatch({ type: "thread", thread });
      if (patch.collaborationMode === "plan") setGoalMode(false);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? localizeKnownServerText(language, caught.message)
          : t("Не удалось изменить настройки"),
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

  if (!summary)
    return (
      <div className="center-state">
        <h2>{t("Задача не найдена")}</h2>
      </div>
    );

  const latestPlanId =
    !summary.currentTurnId && summary.settings.collaborationMode === "plan"
      ? findLatestCompletedPlan(detail)
      : null;
  const latestAnnotatableId = findLatestAnnotatable(detail, summary.currentTurnId);
  const latestPlanHasAnnotations = Boolean(
    latestPlanId && annotations.some((annotation) => annotation.messageId === latestPlanId),
  );

  return (
    <div className="thread-workspace">
      <div className="conversation-pane">
        <WorkspaceHeader
          title={localizeKnownServerText(language, summary.title) ?? summary.title}
          subtitle={project?.displayName ?? summary.cwd}
          onOpenNavigation={onOpenNavigation}
          onToggleInspector={() => setInspectorOpen((value) => !value)}
          actions={
            <details className="thread-action-menu" data-dismiss-on-outside-click>
              <summary className="icon-button" aria-label={t("Действия с задачей")}>
                <MoreIcon />
              </summary>
              <div className="action-menu-popover">
                <button onClick={togglePin}>
                  <PinIcon /> {summary.pinned ? t("Открепить") : t("Закрепить")}
                </button>
                <button onClick={() => setRenaming(true)}>
                  <PencilIcon /> {t("Переименовать")}
                </button>
                <button onClick={toggleArchive}>
                  <ArchiveIcon /> {summary.archived ? t("Вернуть из архива") : t("Архивировать")}
                </button>
                <button className="danger" disabled={deleting} onClick={() => void deleteThread()}>
                  <TrashIcon /> {deleting ? t("Удаляем…") : t("Удалить")}
                </button>
              </div>
            </details>
          }
        />
        <div
          className="conversation-scroll"
          ref={scrollRef}
          onScroll={(event) => {
            const node = event.currentTarget;
            followsTail.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
            if (followsTail.current) setAttentionJump(false);
            if (node.scrollTop < 160) void loadOlder();
          }}
        >
          <section className="timeline" aria-live="polite">
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
            {!detail && optimisticTurnMessages.length === 0 && (
              <div className="center-state compact">
                <div className="spinner" />
              </div>
            )}
            {detail?.turns.map((turn) => (
              <div className="turn" key={turn.id}>
                {optimisticTurnMessages
                  .filter(
                    (message) =>
                      message.turnId === turn.id ||
                      (!message.turnId && summary.currentTurnId === turn.id),
                  )
                  .map((message) => (
                    <Activity
                      item={optimisticActivity(message)}
                      cwd={summary.cwd}
                      onDownload={downloadFile}
                      key={message.id}
                    />
                  ))}
                {groupedTurnActivities.get(turn.id)!.map((entry) =>
                  Array.isArray(entry) ? (
                    <MemoizedActivityGroup
                      items={entry}
                      cwd={summary.cwd}
                      onDownload={downloadFile}
                      key={entry.map((item) => item.id).join(":")}
                    />
                  ) : (
                    <div key={entry.id}>
                      <MemoizedActivity
                        item={entry}
                        cwd={summary.cwd}
                        onDownload={downloadFile}
                        annotations={annotations}
                        annotationEnabled={!busy && entry.id === latestAnnotatableId}
                        annotationBusy={busy}
                        onCreateAnnotation={createAnnotationEvent}
                        onUpdateAnnotation={updateAnnotationEvent}
                        onDeleteAnnotation={deleteAnnotationEvent}
                      />
                      {entry.id === latestPlanId && (
                        <button
                          className="implement-plan"
                          disabled={busy || latestPlanHasAnnotations}
                          title={
                            latestPlanHasAnnotations
                              ? t("Сначала отправьте или удалите аннотации к плану")
                              : undefined
                          }
                          onClick={() => void implementPlan()}
                        >
                          {t("Да, реализуй этот план")}
                        </button>
                      )}
                    </div>
                  ),
                )}
                <MemoizedTurnTiming turn={turn} active={summary.currentTurnId === turn.id} />
              </div>
            ))}
            {summary.currentTurnId &&
              !detail?.turns.some((turn) => turn.id === summary.currentTurnId) && (
                <div className="turn active-turn-placeholder">
                  <ActiveTurnStatus progress={activeProgress} />
                </div>
              )}
            {detachedOptimisticMessages(
              optimisticTurnMessages,
              detail?.turns ?? [],
              summary.currentTurnId,
            ).map((message) => (
              <div className="turn optimistic-turn" key={`optimistic:${message.id}`}>
                <Activity
                  item={optimisticActivity(message)}
                  cwd={summary.cwd}
                  onDownload={downloadFile}
                />
              </div>
            ))}
            {autoVoiceProgress && <VoiceTranscriptionBubble progress={autoVoiceProgress} />}
            <AttentionPanel requests={attention} />
            {!activeVoiceJob &&
              !voiceUpload &&
              ["completed", "interrupted"].includes(summary.state) &&
              summary.unread && (
                <button
                  className="finish-thread-action"
                  disabled={finishing}
                  onClick={() => void finishThread()}
                >
                  {finishing ? t("Заканчиваем…") : t("Закончить")}
                </button>
              )}
          </section>
        </div>
        {attentionJump && (
          <button
            className="attention-jump"
            onClick={() => {
              followsTail.current = true;
              setAttentionJump(false);
              scrollToEnd(scrollRef.current, "smooth");
            }}
          >
            {t("Требуется внимание")} <ChevronDownIcon />
          </button>
        )}
        <Composer
          key={threadId}
          autoFocus={(location.state as { focusComposer?: unknown } | null)?.focusComposer === true}
          input={input}
          onInput={setInput}
          images={images}
          onImagesChange={setImages}
          onSubmit={submit}
          busy={busy}
          running={Boolean(summary.currentTurnId)}
          settings={summary.settings}
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
            summary.currentTurnId
              ? () => void api.interrupt(threadId, summary.currentTurnId!)
              : undefined
          }
          transcriptionConfig={transcriptionConfig}
          transcriptionProvider={transcriptionProvider}
          voiceMode={voiceMode}
          onVoiceModeChange={setVoiceMode}
          voiceUploadPending={Boolean(voiceUpload)}
          voiceInputLocked={Boolean(activeVoiceJob || voiceUpload)}
          onRecordingReady={(recording) => beginTranscription(threadId, recording)}
          transcriptionStatus={draftVoiceProgress}
          transcriptionError={
            voiceJob?.status === "failed"
              ? (localizeKnownServerText(language, voiceJob.error) ?? voiceJob.error)
              : null
          }
          error={error}
          hasSupplementalContent={annotations.length > 0}
        >
          <QueuedMessages
            messages={mergeOptimisticQueue(detail?.queuedMessages ?? [], optimisticQueuedMessages)}
            action={queueAction}
            onSendNow={sendQueuedNow}
            onUpdate={updateQueued}
            onDelete={deleteQueued}
          />
        </Composer>
      </div>
      <SessionInspector
        open={inspectorOpen}
        summary={summary}
        project={project}
        gitChanges={gitChangesState?.threadId === threadId ? gitChangesState.value : null}
        onClose={() => setInspectorOpen(false)}
        onPin={togglePin}
        onArchive={toggleArchive}
      />
      {inspectorOpen && (
        <button
          className="inspector-backdrop"
          aria-label={t("Закрыть сведения")}
          onClick={() => setInspectorOpen(false)}
        />
      )}
      {renaming && (
        <RenameDialog
          initialValue={summary.title}
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
  const status = items.some((item) => item.status === "failed")
    ? "failed"
    : items.some((item) => item.status === "inProgress")
      ? "inProgress"
      : "completed";
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
    <details className="activity-group">
      <summary>
        <span className="activity-group-icon">
          <ToolIcon />
        </span>
        <span>{labels.join(" · ") || t("Выполнены действия")}</span>
        {status === "inProgress" && <span className="spinner small" />}
        {status === "failed" && <span className="activity-group-error">{t("Ошибка")}</span>}
      </summary>
      <div className="activity-group-content">
        {items.map((item) => (
          <MemoizedActivity item={item} cwd={cwd} onDownload={onDownload} key={item.id} />
        ))}
      </div>
    </details>
  );
}

const MemoizedActivityGroup = memo(ActivityGroup);

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

function hasVisibleActivity(item: ActivityItem): boolean {
  if ("text" in item) return Boolean(item.text.trim() || item.images.length);
  return true;
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
  return (
    <details className="activity-card">
      <summary>
        <span className="activity-icon">{icon}</span>
        <span className="activity-title">{title}</span>
        <span className={`activity-status activity-status-${status}`}>
          {statusLabel(status, t)}
        </span>
      </summary>
      <div className="activity-content">{children}</div>
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
