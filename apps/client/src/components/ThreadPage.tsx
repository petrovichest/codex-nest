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
import { useParams } from "react-router-dom";

import type {
  ActivityItem,
  GitChangesSummary,
  QueuedMessage,
  ThreadDetail,
  TurnProgress,
  UpdateThreadSettingsRequest,
} from "@codexnest/protocol";

import { useConnection } from "../connection";
import { AttentionPanel } from "./AttentionPanel";
import { Composer } from "./Composer";
import {
  ArchiveIcon,
  ChevronDownIcon,
  ClockIcon,
  FileIcon,
  MoreIcon,
  PencilIcon,
  PinIcon,
  TerminalIcon,
  ToolIcon,
  XIcon,
} from "./Icons";
import { SessionInspector, type GitChangesView } from "./SessionInspector";
import { WorkspaceHeader } from "./WorkspaceHeader";

export function ThreadPage({ onOpenNavigation }: { onOpenNavigation(): void }) {
  const { threadId = "" } = useParams();
  const { api, state, dispatch, refreshDetail } = useConnection();
  const summary = state.snapshot?.threads.find((thread) => thread.id === threadId);
  const project =
    state.snapshot?.projects.find((candidate) => candidate.id === summary?.projectId) ?? null;
  const detail = state.details[threadId];
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [sendingQueuedId, setSendingQueuedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [attentionJump, setAttentionJump] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialScrollThread = useRef<string | null>(null);
  const followsTail = useRef(true);
  const previousAttentionIds = useRef<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia("(min-width: 1280px)").matches,
  );
  const [gitChangesState, setGitChangesState] = useState<{
    threadId: string;
    value: GitChangesView;
  } | null>(null);
  const gitChangesRequest = useRef(0);
  const previousTurn = useRef({ threadId, turnId: summary?.currentTurnId ?? null });
  const attention = useMemo(
    () => state.snapshot?.attention.filter((item) => item.threadId === threadId) ?? [],
    [state.snapshot?.attention, threadId],
  );

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
  }, [inspectorOpen, loadGitChanges, threadId]);

  useEffect(() => {
    const current = { threadId, turnId: summary?.currentTurnId ?? null };
    const previous = previousTurn.current;
    previousTurn.current = current;
    if (
      inspectorOpen &&
      previous.threadId === threadId &&
      previous.turnId !== null &&
      current.turnId === null
    ) {
      void loadGitChanges();
    }
  }, [inspectorOpen, loadGitChanges, summary?.currentTurnId, threadId]);

  useEffect(() => {
    if (threadId) void refreshDetail(threadId).catch((caught: Error) => setError(caught.message));
  }, [threadId, refreshDetail, summary?.updatedAt, state.snapshotEpoch]);

  useEffect(() => {
    if (
      summary?.unread &&
      detail &&
      ["completed", "failed", "interrupted"].includes(summary.state)
    ) {
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

  if (!summary)
    return (
      <div className="center-state">
        <h2>Задача не найдена</h2>
      </div>
    );

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!input.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (summary!.currentTurnId) {
        await api.enqueue(threadId, input);
      } else {
        await api.startTurn(threadId, { input });
      }
      setInput("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось отправить сообщение");
    } finally {
      setBusy(false);
    }
  }

  async function implementPlan() {
    setBusy(true);
    setError(null);
    let changedMode = false;
    try {
      const thread = await api.updateThreadSettings(threadId, { collaborationMode: "default" });
      changedMode = true;
      dispatch({ type: "thread", thread });
      await api.startTurn(threadId, { input: "Да, реализуй этот план" });
    } catch (caught) {
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

  const togglePin = () => void api.updateThread(threadId, { pinned: !summary.pinned });
  const toggleArchive = () => void api.archive(threadId, !summary.archived);

  async function updateSettings(patch: UpdateThreadSettingsRequest) {
    setSettingsBusy(true);
    setError(null);
    try {
      const thread = await api.updateThreadSettings(threadId, patch);
      dispatch({ type: "thread", thread });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось изменить настройки");
    } finally {
      setSettingsBusy(false);
    }
  }

  const latestPlanId =
    !summary.currentTurnId && summary.settings.collaborationMode === "plan"
      ? findLatestCompletedPlan(detail)
      : null;
  const activeProgress = summary.currentTurnId
    ? detail?.turns.find((turn) => turn.id === summary.currentTurnId)?.progress
    : undefined;

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
          }}
        >
          <section className="timeline" aria-live="polite">
            {!detail && (
              <div className="center-state compact">
                <div className="spinner" />
              </div>
            )}
            {detail?.turns.map((turn) => (
              <div className="turn" key={turn.id}>
                {groupActivities(turn.items).map((entry) =>
                  Array.isArray(entry) ? (
                    <ActivityGroup items={entry} key={entry.map((item) => item.id).join(":")} />
                  ) : (
                    <div key={entry.id}>
                      <Activity item={entry} />
                      {entry.id === latestPlanId && (
                        <button
                          className="implement-plan"
                          disabled={busy}
                          onClick={() => void implementPlan()}
                        >
                          Да, реализуй этот план
                        </button>
                      )}
                    </div>
                  ),
                )}
              </div>
            ))}
            <AttentionPanel requests={attention} />
            <QueuedMessages
              messages={detail?.queuedMessages ?? []}
              sendingId={sendingQueuedId}
              onSendNow={(messageId) => void sendQueuedNow(messageId)}
            />
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
        {summary.currentTurnId && (
          <TurnProgressIndicator key={summary.currentTurnId} progress={activeProgress} />
        )}
        <Composer
          input={input}
          onInput={setInput}
          onSubmit={submit}
          busy={busy}
          running={Boolean(summary.currentTurnId)}
          settings={summary.settings}
          onSettingsChange={(patch) => void updateSettings(patch)}
          settingsBusy={settingsBusy}
          models={state.snapshot?.models ?? []}
          onStop={
            summary.currentTurnId
              ? () => void api.interrupt(threadId, summary.currentTurnId!)
              : undefined
          }
          error={error}
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

export function Activity({ item }: { item: ActivityItem }) {
  if (item.type === "userMessage" || item.type === "agentMessage") {
    return (
      <article className={`message ${item.type}`}>
        <ReactMarkdown>{item.text}</ReactMarkdown>
      </article>
    );
  }
  if (item.type === "reasoning") {
    return (
      <article className="message reasoning">
        <ReactMarkdown>{item.text}</ReactMarkdown>
      </article>
    );
  }
  if (item.type === "plan") {
    return (
      <article className="message plan">
        <div className="activity-label">План</div>
        <ReactMarkdown>{item.text}</ReactMarkdown>
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

function ActivityGroup({ items }: { items: ActivityItem[] }) {
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
          <Activity item={item} key={item.id} />
        ))}
      </div>
    </details>
  );
}

function QueuedMessages({
  messages,
  sendingId,
  onSendNow,
}: {
  messages: QueuedMessage[];
  sendingId: string | null;
  onSendNow(messageId: string): void;
}) {
  if (!messages.length) return null;
  return (
    <section className="queued-messages" aria-label="Очередь сообщений">
      {messages.map((message) => (
        <article className="message userMessage queued-message" key={message.id}>
          <ReactMarkdown>{message.text}</ReactMarkdown>
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

function TurnProgressIndicator({ progress }: { progress?: TurnProgress }) {
  const [fallbackStartedAt] = useState(Date.now);
  const startedAt = progress?.startedAt ?? fallbackStartedAt;
  const elapsed = useElapsed(startedAt);
  const steps = progress?.steps ?? [];
  const currentIndex = steps.findIndex((step) => step.status === "inProgress");
  const firstPending = steps.findIndex((step) => step.status === "pending");
  const stepNumber =
    currentIndex >= 0
      ? currentIndex + 1
      : firstPending >= 0
        ? firstPending + 1
        : Math.max(steps.length, 1);
  const hasDiff = Boolean(
    progress && (progress.filesChanged || progress.additions || progress.deletions),
  );
  return (
    <details className="turn-progress" data-dismiss-on-outside-click>
      <summary>
        <span className="spinner small" />
        <span>{steps.length ? `Шаг ${stepNumber} / ${steps.length}` : "Codex работает…"}</span>
        {hasDiff && (
          <span className="turn-progress-diff">
            Изменено {formatFileCount(progress!.filesChanged)}
            <b className="diff-add">+{progress!.additions}</b>
            <b className="diff-delete">-{progress!.deletions}</b>
          </span>
        )}
        <ChevronDownIcon />
      </summary>
      <div className="turn-progress-popover">
        <div className="turn-progress-time">
          <ClockIcon /> Работает уже {elapsed}
        </div>
        {progress?.explanation && <p>{progress.explanation}</p>}
        {steps.length ? (
          <ol>
            {steps.map((step) => (
              <li className={`progress-step ${step.status}`} key={step.step}>
                <span />
                {step.step}
              </li>
            ))}
          </ol>
        ) : (
          <p>Codex выполняет текущую задачу.</p>
        )}
      </div>
    </details>
  );
}

function useElapsed(startedAt: number): string {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function formatFileCount(count: number): string {
  const modulo100 = count % 100;
  const modulo10 = count % 10;
  const suffix =
    modulo100 >= 11 && modulo100 <= 14
      ? "файлов"
      : modulo10 === 1
        ? "файл"
        : modulo10 >= 2 && modulo10 <= 4
          ? "файла"
          : "файлов";
  return `${count} ${suffix}`;
}

function groupActivities(items: ActivityItem[]): Array<ActivityItem | ActivityItem[]> {
  const result: Array<ActivityItem | ActivityItem[]> = [];
  let group: ActivityItem[] = [];
  const flush = () => {
    if (group.length) result.push(group);
    group = [];
  };
  for (const item of items) {
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

function findLatestCompletedPlan(detail?: ThreadDetail): string | null {
  const turn = detail?.turns.at(-1);
  if (!turn || turn.status === "inProgress") return null;
  return (
    [...turn.items].reverse().find((item) => item.type === "plan" && item.status === "completed")
      ?.id ?? null
  );
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
