import {
  type FormEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useLocation, useNavigate, useParams } from "react-router-dom";

import type {
  ActivityItem,
  GitChangesSummary,
  QueuedMessage,
  ThreadDetail,
  TranscriptionConfigResponse,
  TranscriptionProvider,
  TurnProgress,
  TurnView,
  UpdateThreadGoalRequest,
  UpdateThreadSettingsRequest,
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
import type { OptimisticMessage } from "../state";
import { AttentionPanel } from "./AttentionPanel";
import { Composer, type ComposerImage } from "./Composer";
import {
  ArchiveIcon,
  ChevronDownIcon,
  CopyIcon,
  FileIcon,
  MoreIcon,
  PencilIcon,
  PinIcon,
  SendIcon,
  TerminalIcon,
  ToolIcon,
  TrashIcon,
  XIcon,
} from "./Icons";
import { SessionInspector, type GitChangesView } from "./SessionInspector";
import { WorkspaceHeader } from "./WorkspaceHeader";

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
  const { api, state, dispatch, refreshDetail, loadOlderDetail } = useConnection();
  const summary = state.snapshot?.threads.find((thread) => thread.id === threadId);
  const project =
    state.snapshot?.projects.find((candidate) => candidate.id === summary?.projectId) ?? null;
  const detail = state.details[threadId];
  const [input, setInput] = useState("");
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [goalMode, setGoalMode] = useState(false);
  const [goalBusy, setGoalBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [sendingQueuedId, setSendingQueuedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [annotationState, setAnnotationState] = useState<{
    threadId: string;
    items: PendingAnnotation[];
  }>(() => ({ threadId, items: loadPendingAnnotations(threadId) }));
  const [renaming, setRenaming] = useState(false);
  const [attentionJump, setAttentionJump] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialScrollThread = useRef<string | null>(null);
  const followsTail = useRef(true);
  const previousAttentionIds = useRef<string | null>(null);
  const locationNoticeHandled = useRef<string | null>(null);
  const detailReconcileKey = useRef<string | null>(null);
  const olderScrollAnchor = useRef<{
    threadId: string;
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia("(min-width: 1280px)").matches,
  );
  const [gitChangesState, setGitChangesState] = useState<{
    threadId: string;
    value: GitChangesView;
  } | null>(null);
  const gitChangesRequest = useRef(0);
  const attention = useMemo(
    () => state.snapshot?.attention.filter((item) => item.threadId === threadId) ?? [],
    [state.snapshot?.attention, threadId],
  );
  const goal = state.goals?.[threadId];
  const optimisticMessages = state.optimisticMessages?.[threadId] ?? [];
  const optimisticTurnMessages = optimisticMessages.filter(
    (message) => message.destination === "turn",
  );
  const optimisticQueuedMessages = optimisticMessages.filter(
    (message) => message.destination === "queue",
  );
  const annotations = annotationState.threadId === threadId ? annotationState.items : [];
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

  useEffect(() => {
    if (goal) setGoalMode(false);
  }, [goal]);

  useEffect(() => {
    setAnnotationState({ threadId, items: loadPendingAnnotations(threadId) });
  }, [threadId]);

  useEffect(() => {
    if (!threadId) return;
    const request = api.readGoal?.(threadId);
    if (!request) return;
    void request
      .then((value) => dispatch({ type: "goal", threadId, goal: value }))
      .catch((caught: Error) => setError(caught.message));
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
    if (threadId) void refreshDetail(threadId).catch((caught: Error) => setError(caught.message));
  }, [threadId, refreshDetail, state.snapshotEpoch]);

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
    void refreshDetail(threadId).catch((caught: Error) => {
      detailReconcileKey.current = null;
      setError(caught.message);
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
  }, [attention, detail, threadId]);

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

  if (!summary)
    return (
      <div className="center-state">
        <h2>Задача не найдена</h2>
      </div>
    );

  function persistAnnotations(next: PendingAnnotation[]): boolean {
    try {
      savePendingAnnotations(threadId, next);
      setAnnotationState({ threadId, items: next });
      return true;
    } catch {
      setError("Не удалось сохранить аннотации локально");
      return false;
    }
  }

  function createAnnotation(draft: AnnotationDraft): boolean {
    const saved = persistAnnotations([
      ...annotations,
      {
        ...draft,
        id: createClientMessageId(),
        createdAt: Date.now(),
      },
    ]);
    if (saved && goalMode) setGoalMode(false);
    return saved;
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

  function clearSentAnnotations(sent: PendingAnnotation[]) {
    if (!sent.length) return;
    const sentIds = new Set(sent.map((annotation) => annotation.id));
    const next = annotations.filter((annotation) => !sentIds.has(annotation.id));
    try {
      savePendingAnnotations(threadId, next);
    } catch {
      setError("Сообщение отправлено, но локальный черновик аннотаций не удалось очистить");
    }
    setAnnotationState({ threadId, items: next });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const submittedComposerInput = input;
    const submittedAnnotations = annotations;
    const submittedInput = formatAnnotatedMessage(submittedComposerInput, submittedAnnotations);
    if ((!submittedInput.trim() && !images.length) || (goalMode && !input.trim())) return;
    const submittedImages = images;
    const submittedGoalMode = goalMode;
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
    dispatch({ type: "optimistic.add", message: optimisticMessage });
    setInput("");
    setImages([]);
    setGoalMode(false);
    try {
      if (summary!.currentTurnId) {
        await api.enqueue(threadId, {
          input: submittedInput,
          ...(submittedImages.length ? { images: submittedImages.map((image) => image.url) } : {}),
          clientMessageId,
        });
        clearSentAnnotations(submittedAnnotations);
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
        clearSentAnnotations(submittedAnnotations);
        if (result.goalWarning) setError(result.goalWarning);
      }
    } catch (caught) {
      dispatch({ type: "optimistic.remove", threadId, messageId: clientMessageId });
      setInput(submittedComposerInput);
      setImages(submittedImages);
      setGoalMode(submittedGoalMode);
      setError(caught instanceof Error ? caught.message : "Не удалось отправить сообщение");
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
      dispatch({
        type: "optimistic.add",
        message: {
          id: clientMessageId,
          threadId,
          text: "Да, реализуй этот план",
          images: [],
          createdAt: Date.now(),
          destination: "turn",
          turnId: null,
        },
      });
      const result = await api.startTurn(threadId, {
        input: "Да, реализуй этот план",
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
      setError(caught instanceof Error ? caught.message : "Не удалось начать реализацию плана");
    } finally {
      setBusy(false);
    }
  }

  async function sendQueuedNow(messageId: string) {
    setSendingQueuedId(messageId);
    setError(null);
    try {
      await api.sendQueuedNow(threadId, messageId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось отправить сообщение");
    } finally {
      setSendingQueuedId(null);
    }
  }

  async function finishThread() {
    setFinishing(true);
    setError(null);
    try {
      await api.markRead(threadId, { observedUpdatedAt: summary!.updatedAt });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось закончить сессию");
    } finally {
      setFinishing(false);
    }
  }

  const togglePin = () => void api.updateThread(threadId, { pinned: !summary.pinned });
  const toggleArchive = () => void api.archive(threadId, !summary.archived);

  async function deleteThread() {
    if (!window.confirm("Удалить эту сессию? Это действие нельзя отменить.")) return;
    setDeleting(true);
    setError(null);
    try {
      await api.deleteThread(threadId);
      navigate("/new", { replace: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось удалить сессию");
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
      setError(caught instanceof Error ? caught.message : "Не удалось изменить настройки");
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
      setError(caught instanceof Error ? caught.message : "Не удалось изменить цель");
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
      setError(caught instanceof Error ? caught.message : "Не удалось очистить цель");
    } finally {
      setGoalBusy(false);
    }
  }

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
          title={summary.title}
          subtitle={project?.displayName ?? summary.cwd}
          onOpenNavigation={onOpenNavigation}
          onToggleInspector={() => setInspectorOpen((value) => !value)}
          actions={
            <details className="thread-action-menu" data-dismiss-on-outside-click>
              <summary className="icon-button" aria-label="Действия с задачей">
                <MoreIcon />
              </summary>
              <div className="action-menu-popover">
                <button onClick={togglePin}>
                  <PinIcon /> {summary.pinned ? "Открепить" : "Закрепить"}
                </button>
                <button onClick={() => setRenaming(true)}>
                  <PencilIcon /> Переименовать
                </button>
                <button onClick={toggleArchive}>
                  <ArchiveIcon /> {summary.archived ? "Вернуть из архива" : "Архивировать"}
                </button>
                <button className="danger" disabled={deleting} onClick={() => void deleteThread()}>
                  <TrashIcon /> {deleting ? "Удаляем…" : "Удалить"}
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
              <div className="history-loader" aria-label="Загружаем старые сообщения">
                <span className="spinner small" />
              </div>
            )}
            {olderError && (
              <button className="history-retry" type="button" onClick={() => void loadOlder()}>
                Повторить загрузку старых сообщений
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
                {groupActivities(turn.items).map((entry) =>
                  Array.isArray(entry) ? (
                    <ActivityGroup
                      items={entry}
                      cwd={summary.cwd}
                      onDownload={downloadFile}
                      key={entry.map((item) => item.id).join(":")}
                    />
                  ) : (
                    <div key={entry.id}>
                      <Activity
                        item={entry}
                        cwd={summary.cwd}
                        onDownload={downloadFile}
                        annotations={annotations}
                        annotationEnabled={!busy && entry.id === latestAnnotatableId}
                        annotationBusy={busy}
                        onCreateAnnotation={createAnnotation}
                        onUpdateAnnotation={updateAnnotation}
                        onDeleteAnnotation={deleteAnnotation}
                      />
                      {entry.id === latestPlanId && (
                        <button
                          className="implement-plan"
                          disabled={busy || latestPlanHasAnnotations}
                          title={
                            latestPlanHasAnnotations
                              ? "Сначала отправьте или удалите аннотации к плану"
                              : undefined
                          }
                          onClick={() => void implementPlan()}
                        >
                          Да, реализуй этот план
                        </button>
                      )}
                    </div>
                  ),
                )}
                <TurnTiming turn={turn} active={summary.currentTurnId === turn.id} />
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
            <AttentionPanel requests={attention} />
            <QueuedMessages
              messages={mergeOptimisticQueue(
                detail?.queuedMessages ?? [],
                optimisticQueuedMessages,
              )}
              sendingId={sendingQueuedId}
              onSendNow={(messageId) => void sendQueuedNow(messageId)}
              cwd={summary.cwd}
              onDownload={downloadFile}
            />
            {["completed", "interrupted"].includes(summary.state) && summary.unread && (
              <button
                className="finish-thread-action"
                disabled={finishing}
                onClick={() => void finishThread()}
              >
                {finishing ? "Заканчиваем…" : "Закончить"}
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
            Требуется внимание <ChevronDownIcon />
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
              setError("Сначала отправьте или удалите аннотации");
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
          onTranscribe={async (audio) => {
            if (!transcriptionProvider) throw new Error("Распознавание речи не настроено");
            return (await api.transcribe(audio)).text;
          }}
          error={error}
          hasSupplementalContent={annotations.length > 0}
        />
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
          aria-label="Закрыть сведения"
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
): QueuedMessage[] {
  const confirmedIds = new Set(messages.map((message) => message.id));
  return [
    ...messages,
    ...optimistic
      .filter((message) => !confirmedIds.has(message.id))
      .map((message) => ({
        id: message.id,
        threadId: message.threadId,
        text: message.text,
        ...(message.images.length ? { images: message.images } : {}),
        createdAt: message.createdAt,
        status: "queued" as const,
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
        {busy && <span className="download-link-status"> — скачиваем…</span>}
      </a>
      {failed && (
        <span className="download-link-error" role="alert">
          Не удалось скачать файл. Нажмите ещё раз.
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
  if (!hasVisibleActivity(item)) return null;
  if (item.type === "userMessage" || item.type === "agentMessage") {
    const messageAnnotations = numberedAnnotations(annotations, item.id);
    return (
      <article className={`message ${item.type}`}>
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
          <div className="activity-label">План</div>
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
        <div className="activity-label">Ход работы</div>
        {item.explanation && <p>{item.explanation}</p>}
        <ol>
          {item.steps.map((step, index) => (
            <li className={step.status} key={`${index}:${step.step}`}>
              <input
                aria-label={step.status === "completed" ? "Выполнено" : "Не выполнено"}
                checked={step.status === "completed"}
                readOnly
                tabIndex={-1}
                type="checkbox"
              />
              <span>{step.step}</span>
              {step.status === "inProgress" && <span className="spinner small" />}
            </li>
          ))}
        </ol>
      </article>
    );
  }
  if (item.type === "command") {
    return (
      <ActivityDetails
        icon={<TerminalIcon />}
        title={item.command || "Выполнена команда"}
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
        title={item.path ? `Изменён ${item.path}` : "Изменены файлы"}
        status={item.status}
      >
        <pre>{item.patch}</pre>
      </ActivityDetails>
    );
  }
  if (item.type === "tool") {
    return (
      <ActivityDetails icon={<ToolIcon />} title={item.title} status={item.status}>
        {item.detail && <p>{item.detail}</p>}
      </ActivityDetails>
    );
  }
  if (item.type === "error" || item.type === "unsupported") {
    return (
      <article className="error-banner activity-error">
        <strong>{item.type === "unsupported" ? "Несовместимое событие" : "Ошибка"}</strong>
        <p>{item.message}</p>
      </article>
    );
  }
  return null;
}

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
            aria-label={`Аннотация ${item.number}`}
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
            Аннотация
          </button>
          <button type="button" onClick={() => void copySelection()}>
            {copyState === "copied"
              ? "Скопировано"
              : copyState === "failed"
                ? "Ошибка копирования"
                : "Копировать"}
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
            aria-label="Комментарий к выделенному тексту"
            placeholder="Комментарий"
            rows={2}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
          <div className="annotation-editor-actions">
            <button
              className="annotation-editor-save"
              type="submit"
              aria-label="Сохранить аннотацию"
              disabled={!comment.trim()}
            >
              <SendIcon />
            </button>
            <button
              className="annotation-editor-delete"
              type="button"
              aria-label="Удалить аннотацию"
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
  const status = items.some((item) => item.status === "failed")
    ? "failed"
    : items.some((item) => item.status === "inProgress")
      ? "inProgress"
      : "completed";
  const labels: string[] = [];
  if (items.some((item) => item.type === "command" && item.kind === "read")) {
    labels.push("Прочитаны файлы");
  }
  if (items.some((item) => item.type === "command" && item.kind === "search")) {
    labels.push("Выполнен поиск");
  }
  if (items.some((item) => item.type === "command" && item.kind === "command")) {
    labels.push("Выполнены команды");
  }
  if (items.some((item) => item.type === "fileChange")) labels.push("Отредактированы файлы");
  if (items.some((item) => item.type === "tool")) labels.push("Использованы инструменты");
  return (
    <details className="activity-group">
      <summary>
        <span className="activity-group-icon">
          <ToolIcon />
        </span>
        <span>{labels.join(" · ") || "Выполнены действия"}</span>
        {status === "inProgress" && <span className="spinner small" />}
        {status === "failed" && <span className="activity-group-error">Ошибка</span>}
      </summary>
      <div className="activity-group-content">
        {items.map((item) => (
          <Activity item={item} cwd={cwd} onDownload={onDownload} key={item.id} />
        ))}
      </div>
    </details>
  );
}

function QueuedMessages({
  messages,
  sendingId,
  onSendNow,
  cwd,
  onDownload,
}: {
  messages: QueuedMessage[];
  sendingId: string | null;
  onSendNow(messageId: string): void;
  cwd: string;
  onDownload(path: string): Promise<void>;
}) {
  if (!messages.length) return null;
  return (
    <section className="queued-messages" aria-label="Очередь сообщений">
      {messages.map((message) => (
        <article className="message userMessage queued-message" key={message.id}>
          <div className="message-body">
            {message.text && (
              <MarkdownContent text={message.text} cwd={cwd} onDownload={onDownload} />
            )}
            {(message.images?.length ?? 0) > 0 && <MessageImages images={message.images ?? []} />}
          </div>
          <MessageFooter text={message.text} timestamp={message.createdAt} />
          <div className="queued-message-footer">
            <span>{message.status === "dispatching" ? "Отправляется…" : "В очереди"}</span>
            <button
              disabled={message.status === "dispatching" || sendingId !== null}
              onClick={() => onSendNow(message.id)}
            >
              Отправить сейчас
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}

function MessageImages({ images }: { images: string[] }) {
  return (
    <div className="message-images">
      {images.map((image, index) => (
        <img src={image} alt={`Изображение ${index + 1}`} key={`${index}:${image.slice(-24)}`} />
      ))}
    </div>
  );
}

function MessageFooter({ text, timestamp }: { text: string; timestamp: number | null }) {
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
      {copyState === "copied" && <span role="status">Скопировано</span>}
      {copyState === "failed" && <span role="alert">Не удалось скопировать</span>}
      {timestamp !== null && (
        <time dateTime={new Date(timestamp).toISOString()}>{formatMessageTime(timestamp)}</time>
      )}
      {canCopy && (
        <button type="button" aria-label="Копировать сообщение" onClick={() => void copy()}>
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
  const startedAt = turn.startedAt ?? turn.progress.startedAt;
  if (active) return <ActiveTurnStatus progress={{ ...turn.progress, startedAt }} />;
  if (turn.status === "inProgress" || startedAt === null) return null;
  const duration =
    turn.durationMs ??
    (turn.completedAt === null ? null : Math.max(0, turn.completedAt - startedAt));
  return duration === null ? null : (
    <div className="turn-timing">Работал {formatDuration(duration)}</div>
  );
}

function ActiveTurnStatus({ progress }: { progress?: TurnProgress }) {
  const startedAt = progress?.startedAt ?? null;
  const elapsed = useElapsed(startedAt ?? 0, startedAt !== null);
  const label = progress?.explanation?.trim() || "Codex работает";
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

export function formatMessageTime(timestamp: number): string {
  const value = new Date(timestamp);
  const today = new Date();
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
  if (value.toDateString() === today.toDateString()) return time;
  return `${new Intl.DateTimeFormat(undefined, { day: "2-digit", month: "2-digit", year: "numeric" }).format(value)}, ${time}`;
}

function useElapsed(startedAt: number, active = true): string {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active, startedAt]);
  return formatDuration(Math.max(0, now - startedAt));
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
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
  for (const item of items) {
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
  return (
    <details className="activity-card">
      <summary>
        <span className="activity-icon">{icon}</span>
        <span className="activity-title">{title}</span>
        <span className={`activity-status activity-status-${status}`}>{statusLabel(status)}</span>
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
            .catch((caught: Error) => setError(caught.message))
            .finally(() => setBusy(false));
        }}
      >
        <div className="row-between">
          <div>
            <span className="dialog-eyebrow">Задача</span>
            <h2>Переименовать</h2>
          </div>
          <button type="button" className="icon-button" aria-label="Закрыть" onClick={onClose}>
            <XIcon />
          </button>
        </div>
        <label>
          Название
          <input autoFocus value={value} onChange={(event) => setValue(event.target.value)} />
        </label>
        {error && <div className="error-banner">{error}</div>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Отмена
          </button>
          <button className="primary" disabled={busy || !value.trim()}>
            {busy ? "Сохраняем…" : "Сохранить"}
          </button>
        </div>
      </form>
    </div>
  );
}

function statusLabel(status: string): string {
  return status === "inProgress" ? "выполняется" : status === "failed" ? "ошибка" : "готово";
}
