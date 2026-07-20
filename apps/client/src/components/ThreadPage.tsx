import { type FormEvent, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { useParams } from "react-router-dom";

import type { ActivityItem, SessionSettings } from "@codexnest/protocol";

import { useConnection } from "../connection";
import { AttentionPanel } from "./AttentionPanel";
import { SettingsPicker } from "./SettingsPicker";

export function ThreadPage() {
  const { threadId = "" } = useParams();
  const { api, state, refreshDetail } = useConnection();
  const summary = state.snapshot?.threads.find((thread) => thread.id === threadId);
  const detail = state.details[threadId];
  const [input, setInput] = useState("");
  const [settings, setSettings] = useState<SessionSettings>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
        <h2>Сессия не найдена</h2>
      </div>
    );

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!input.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (summary!.state === "running" && summary!.currentTurnId) {
        await api.steer(threadId, { turnId: summary!.currentTurnId, input });
      } else {
        await api.startTurn(threadId, { input, settings });
      }
      setInput("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось отправить сообщение");
    } finally {
      setBusy(false);
    }
  }

  async function rename() {
    const value = window.prompt("Новое название", summary!.title)?.trim();
    if (value) await api.updateThread(threadId, { name: value });
  }

  return (
    <div className="thread-page">
      <header className="thread-header">
        <div>
          <div className="eyebrow">
            <span className={`status status-${summary.state}`} />
            {stateLabel(summary.state)}
          </div>
          <h1>{summary.title}</h1>
          <div className="path">{summary.cwd}</div>
        </div>
        <div className="header-actions">
          <button onClick={() => void api.updateThread(threadId, { pinned: !summary.pinned })}>
            {summary.pinned ? "Открепить" : "Закрепить"}
          </button>
          <button onClick={() => void rename()}>Переименовать</button>
          <button onClick={() => void api.archive(threadId, !summary.archived)}>
            {summary.archived ? "Вернуть из архива" : "Архивировать"}
          </button>
        </div>
      </header>
      <AttentionPanel requests={attention} />
      <section className="timeline" aria-live="polite">
        {!detail && (
          <div className="center-state">
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
      <form className="composer" onSubmit={submit}>
        {summary.state !== "running" && (
          <SettingsPicker
            models={state.snapshot?.models ?? []}
            value={settings}
            onChange={setSettings}
          />
        )}
        <div className="composer-row">
          <textarea
            rows={2}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={
              summary.state === "running" ? "Направить текущий turn…" : "Сообщение для Codex…"
            }
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter")
                event.currentTarget.form?.requestSubmit();
            }}
          />
          <button className="primary" disabled={busy || !input.trim()}>
            {summary.state === "running" ? "Steer" : "Отправить"}
          </button>
          {summary.state === "running" && summary.currentTurnId && (
            <button
              type="button"
              className="danger"
              onClick={() => void api.interrupt(threadId, summary.currentTurnId!)}
            >
              Стоп
            </button>
          )}
        </div>
        {error && <div className="error-banner">{error}</div>}
      </form>
    </div>
  );
}

function Activity({ item }: { item: ActivityItem }) {
  if (
    item.type === "userMessage" ||
    item.type === "agentMessage" ||
    item.type === "reasoning" ||
    item.type === "plan"
  ) {
    return (
      <article className={`message ${item.type}`}>
        <div className="activity-label">
          {item.type === "userMessage"
            ? "Вы"
            : item.type === "agentMessage"
              ? "Codex"
              : item.type === "reasoning"
                ? "Reasoning"
                : "План"}
        </div>
        <ReactMarkdown>{item.text}</ReactMarkdown>
      </article>
    );
  }
  if (item.type === "command") {
    return (
      <article className="activity-card">
        <div className="activity-label">Команда · {statusLabel(item.status)}</div>
        <pre>
          $ {item.command}\n{item.output}
        </pre>
        {item.exitCode !== null && <small>exit {item.exitCode}</small>}
      </article>
    );
  }
  if (item.type === "fileChange") {
    return (
      <article className="activity-card">
        <div className="activity-label">Изменения файлов · {statusLabel(item.status)}</div>
        {item.path && <div className="path">{item.path}</div>}
        <pre>{item.patch}</pre>
      </article>
    );
  }
  if (item.type === "tool") {
    return (
      <article className="activity-card">
        <div className="activity-label">Инструмент · {statusLabel(item.status)}</div>
        <strong>{item.title}</strong>
        <p>{item.detail}</p>
      </article>
    );
  }
  if (item.type === "error" || item.type === "unsupported") {
    return (
      <article className="error-banner">
        <strong>{item.type === "unsupported" ? "Несовместимое событие" : "Ошибка"}</strong>
        <p>{item.message}</p>
      </article>
    );
  }
  return null;
}

function stateLabel(state: string): string {
  return (
    (
      {
        needsAttention: "Требуется решение",
        running: "Выполняется",
        completed: "Завершено",
        failed: "Ошибка",
        interrupted: "Прервано",
        idle: "Готово",
        unavailable: "Недоступно",
      } as Record<string, string>
    )[state] ?? state
  );
}

function statusLabel(status: string): string {
  return status === "inProgress" ? "выполняется" : status === "failed" ? "ошибка" : "готово";
}
