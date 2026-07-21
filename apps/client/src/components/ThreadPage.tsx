import { type FormEvent, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { useParams } from "react-router-dom";

import type { ActivityItem, UpdateThreadSettingsRequest } from "@codexnest/protocol";

import { useConnection } from "../connection";
import { AttentionPanel } from "./AttentionPanel";
import { Composer } from "./Composer";
import {
  ArchiveIcon,
  FileIcon,
  MoreIcon,
  PencilIcon,
  PinIcon,
  TerminalIcon,
  ToolIcon,
  XIcon,
} from "./Icons";
import { SessionInspector } from "./SessionInspector";
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
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia("(min-width: 1280px)").matches,
  );
  const attention = useMemo(
    () => state.snapshot?.attention.filter((item) => item.threadId === threadId) ?? [],
    [state.snapshot?.attention, threadId],
  );

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
        await api.steer(threadId, { turnId: summary!.currentTurnId, input });
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

  return (
    <div className="thread-workspace">
      <div className="conversation-pane">
        <WorkspaceHeader
          title={summary.title}
          subtitle={project?.displayName ?? summary.cwd}
          onOpenNavigation={onOpenNavigation}
          onToggleInspector={() => setInspectorOpen((value) => !value)}
          actions={
            <details className="thread-action-menu">
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
        <div className="conversation-scroll">
          <AttentionPanel requests={attention} />
          <section className="timeline" aria-live="polite">
            {!detail && (
              <div className="center-state compact">
                <div className="spinner" />
              </div>
            )}
            {detail?.turns.map((turn) => (
              <div className="turn" key={turn.id}>
                {turn.items.map((item) => (
                  <Activity item={item} key={item.id} />
                ))}
                {turn.status === "inProgress" && (
                  <div className="working">
                    <div className="spinner small" />
                    Codex работает…
                  </div>
                )}
              </div>
            ))}
          </section>
        </div>
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
        connection={connectionLabel(state.network, state.snapshot?.connection.state)}
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
  if (item.type === "reasoning" || item.type === "plan") {
    return (
      <article className={`message ${item.type}`}>
        <div className="activity-label">{item.type === "reasoning" ? "Ход работы" : "План"}</div>
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

function connectionLabel(network: string, appServer?: string): string {
  if (network !== "connected") return "Нет связи";
  return appServer === "ready" ? "Локальный сервер готов" : "Codex недоступен";
}

function statusLabel(status: string): string {
  return status === "inProgress" ? "выполняется" : status === "failed" ? "ошибка" : "готово";
}
