import { useEffect, useState } from "react";
import { Link, Navigate, Route, Routes, useNavigate } from "react-router-dom";

import type { ConnectionSettings } from "./storage";
import { AttentionPanel } from "./components/AttentionPanel";
import { NewSession } from "./components/NewSession";
import { ProjectDialog } from "./components/ProjectDialog";
import { ThreadPage } from "./components/ThreadPage";
import { useConnection } from "./connection";
import { usePushNotifications } from "./push";
import { groupedThreads } from "./state";
import { clearConnectionSettings } from "./storage";

export function App({
  settings,
  onDisconnected,
}: {
  settings: ConnectionSettings;
  onDisconnected(): void;
}) {
  const { api, state, reconnect } = useConnection();
  const navigate = useNavigate();
  const [drawer, setDrawer] = useState(false);
  const [newSession, setNewSession] = useState(false);
  const [newProject, setNewProject] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem("codexnest.theme") ?? "system");
  usePushNotifications(api, navigate);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("codexnest.theme", theme);
  }, [theme]);

  const snapshot = state.snapshot;
  const attention = snapshot?.attention ?? [];
  return (
    <div className="app-frame">
      <header className="mobile-header">
        <button className="icon-button" onClick={() => setDrawer(true)} aria-label="Открыть меню">
          ☰
        </button>
        <Link to="/" className="brand">
          CodexNest
        </Link>
        <ConnectionDot state={state.network} />
      </header>
      {settings.baseUrl.startsWith("http://") && (
        <div className="http-warning">
          Небезопасное HTTP-подключение: данные доступны перехватчику в LAN.
        </div>
      )}
      <aside className={`sidebar ${drawer ? "open" : ""}`}>
        <div className="sidebar-top">
          <Link to="/" className="brand" onClick={() => setDrawer(false)}>
            <span className="brand-mark small">CN</span>CodexNest
          </Link>
          <button className="icon-button close-drawer" onClick={() => setDrawer(false)}>
            ×
          </button>
        </div>
        <div className="connection-row">
          <ConnectionDot state={state.network} />
          <span>
            {state.network === "connected"
              ? "Подключено"
              : state.network === "connecting"
                ? "Подключаемся…"
                : "Нет связи"}
          </span>
          {state.network !== "connected" && (
            <button className="link-button" onClick={reconnect}>
              Повторить
            </button>
          )}
        </div>
        <button
          className="primary new-session"
          onClick={() => {
            setDrawer(false);
            setNewSession(true);
          }}
        >
          ＋ Новая сессия
        </button>
        <nav className="thread-nav">
          {snapshot &&
            groupedThreads(snapshot.projects, snapshot.threads).map((group) => (
              <section key={group.project?.id ?? "ungrouped"}>
                <div className="project-title">{group.project?.displayName ?? "Без проекта"}</div>
                {group.threads.map((thread) => (
                  <Link
                    className="thread-link"
                    to={`/threads/${encodeURIComponent(thread.id)}`}
                    key={thread.id}
                    onClick={() => setDrawer(false)}
                  >
                    <span className={`status status-${thread.state}`} />
                    <span className="thread-link-copy">
                      <strong>{thread.title}</strong>
                      <small>{thread.preview || thread.cwd}</small>
                    </span>
                    {thread.unread && <span className="unread" />}
                  </Link>
                ))}
              </section>
            ))}
        </nav>
        <div className="sidebar-actions">
          <button onClick={() => setNewProject(true)}>＋ Проект</button>
          <select
            aria-label="Тема"
            value={theme}
            onChange={(event) => setTheme(event.target.value)}
          >
            <option value="system">Системная тема</option>
            <option value="light">Светлая</option>
            <option value="dark">Тёмная</option>
          </select>
          <button
            className="link-button"
            onClick={() => void clearConnectionSettings().then(onDisconnected)}
          >
            Сменить сервер
          </button>
        </div>
      </aside>
      {drawer && (
        <button
          className="drawer-backdrop"
          aria-label="Закрыть меню"
          onClick={() => setDrawer(false)}
        />
      )}
      <main className="content">
        {state.error && (
          <div className="offline-banner">
            {state.error}. Серверные turns продолжат выполняться.
          </div>
        )}
        {!snapshot ? (
          <div className="center-state">
            <div className="spinner" />
            <p>Получаем состояние Codex…</p>
          </div>
        ) : (
          <Routes>
            <Route
              path="/"
              element={
                <Dashboard
                  onNewSession={() => setNewSession(true)}
                  onNewProject={() => setNewProject(true)}
                />
              }
            />
            <Route path="/threads/:threadId" element={<ThreadPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </main>
      {attention.some((item) => !item.threadId) && (
        <div className="global-attention">
          <AttentionPanel requests={attention.filter((item) => !item.threadId)} />
        </div>
      )}
      {newSession && (
        <NewSession projects={snapshot?.projects ?? []} onClose={() => setNewSession(false)} />
      )}
      {newProject && <ProjectDialog onClose={() => setNewProject(false)} />}
    </div>
  );
}

function Dashboard({ onNewSession, onNewProject }: { onNewSession(): void; onNewProject(): void }) {
  const { state } = useConnection();
  const snapshot = state.snapshot!;
  const counts = {
    running: snapshot.threads.filter((thread) => thread.state === "running").length,
    attention: snapshot.threads.filter((thread) => thread.state === "needsAttention").length,
    unread: snapshot.threads.filter((thread) => thread.unread).length,
  };
  return (
    <div className="dashboard page-narrow">
      <div className="page-heading">
        <div>
          <h1>Сессии</h1>
          <p className="muted">Codex на вашем Raspberry Pi</p>
        </div>
        <button className="primary" onClick={onNewSession}>
          Новая сессия
        </button>
      </div>
      <div className="stats">
        <div>
          <strong>{counts.running}</strong>
          <span>выполняются</span>
        </div>
        <div>
          <strong>{counts.attention}</strong>
          <span>ждут решения</span>
        </div>
        <div>
          <strong>{counts.unread}</strong>
          <span>не прочитаны</span>
        </div>
      </div>
      {!snapshot.projects.length && (
        <div className="empty-card">
          <h2>Добавьте первый проект</h2>
          <p>CodexNest запускает новые сессии только в зарегистрированных директориях.</p>
          <button onClick={onNewProject}>Добавить проект</button>
        </div>
      )}
      {snapshot.threads.length > 0 && (
        <div className="recent-list">
          <h2>Недавние</h2>
          {snapshot.threads.slice(0, 8).map((thread) => (
            <Link to={`/threads/${encodeURIComponent(thread.id)}`} key={thread.id}>
              <span className={`status status-${thread.state}`} />
              <span>
                <strong>{thread.title}</strong>
                <small>{new Date(thread.updatedAt).toLocaleString("ru")}</small>
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function ConnectionDot({ state }: { state: "connecting" | "connected" | "offline" }) {
  return <span className={`connection-dot ${state}`} title={state} />;
}
