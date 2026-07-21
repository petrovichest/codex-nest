import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, NavLink, Route, Routes, useNavigate } from "react-router-dom";

import type { ThreadSummary } from "@codexnest/protocol";

import type { ConnectionSettings } from "./storage";
import { AttentionPanel } from "./components/AttentionPanel";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  FolderIcon,
  NewTaskIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
  XIcon,
} from "./components/Icons";
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
      {settings.baseUrl.startsWith("http://") && (
        <div className="http-warning">
          Небезопасное HTTP-подключение: данные доступны перехватчику в LAN.
        </div>
      )}
      <Sidebar
        drawer={drawer}
        onClose={() => setDrawer(false)}
        onNewProject={() => setNewProject(true)}
        onDisconnected={onDisconnected}
        reconnect={reconnect}
        settings={settings}
        theme={theme}
        onThemeChange={setTheme}
      />
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
            <span>{state.error}. Серверные задачи продолжат выполняться.</span>
            <button onClick={reconnect}>Повторить</button>
          </div>
        )}
        {!snapshot ? (
          <div className="center-state">
            <div className="spinner" />
            <p>Получаем состояние Codex…</p>
          </div>
        ) : (
          <Routes>
            <Route path="/" element={<HomeRedirect threads={snapshot.threads} />} />
            <Route
              path="/new"
              element={
                <NewSession
                  projects={snapshot.projects}
                  onOpenNavigation={() => setDrawer(true)}
                  onNewProject={() => setNewProject(true)}
                />
              }
            />
            <Route
              path="/threads/:threadId"
              element={<ThreadPage onOpenNavigation={() => setDrawer(true)} />}
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </main>
      {attention.some((item) => !item.threadId) && (
        <div className="global-attention">
          <AttentionPanel requests={attention.filter((item) => !item.threadId)} />
        </div>
      )}
      {newProject && <ProjectDialog onClose={() => setNewProject(false)} />}
    </div>
  );
}

function HomeRedirect({ threads }: { threads: ThreadSummary[] }) {
  const latest = [...threads]
    .filter((thread) => !thread.archived)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return latest ? (
    <Navigate to={`/threads/${encodeURIComponent(latest.id)}`} replace />
  ) : (
    <Navigate to="/new" replace />
  );
}

function Sidebar({
  drawer,
  onClose,
  onNewProject,
  onDisconnected,
  reconnect,
  settings,
  theme,
  onThemeChange,
}: {
  drawer: boolean;
  onClose(): void;
  onNewProject(): void;
  onDisconnected(): void;
  reconnect(): void;
  settings: ConnectionSettings;
  theme: string;
  onThemeChange(theme: string): void;
}) {
  const { state } = useConnection();
  const navigate = useNavigate();
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const snapshot = state.snapshot;
  const normalizedSearch = search.trim().toLocaleLowerCase("ru");
  const activeThreads = snapshot?.threads.filter((thread) => !thread.archived) ?? [];
  const archivedThreads = snapshot?.threads.filter((thread) => thread.archived) ?? [];
  const groups = useMemo(
    () =>
      groupedThreads(snapshot?.projects ?? [], activeThreads)
        .map((group) => ({
          ...group,
          threads: filterThreads(group.threads, normalizedSearch),
        }))
        .filter((group) => group.threads.length > 0 || (!normalizedSearch && group.project)),
    [activeThreads, normalizedSearch, snapshot?.projects],
  );
  const filteredArchive = filterThreads(archivedThreads, normalizedSearch);

  function toggleGroup(key: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <aside className={`sidebar ${drawer ? "open" : ""}`}>
      <div className="sidebar-history">
        <button className="icon-button" aria-label="Назад" onClick={() => navigate(-1)}>
          <ArrowLeftIcon />
        </button>
        <button className="icon-button" aria-label="Вперёд" onClick={() => navigate(1)}>
          <ArrowRightIcon />
        </button>
        <button className="icon-button close-drawer" aria-label="Закрыть меню" onClick={onClose}>
          <XIcon />
        </button>
      </div>
      <div className="sidebar-brand-row">
        <Link to="/" className="brand" onClick={onClose}>
          CodexNest
          <ChevronDownIcon />
        </Link>
        <button
          className={`icon-button ${searchOpen ? "active" : ""}`}
          aria-label="Поиск по задачам"
          onClick={() => {
            setSearchOpen((value) => !value);
            if (searchOpen) setSearch("");
          }}
        >
          <SearchIcon />
        </button>
      </div>
      {searchOpen && (
        <div className="sidebar-search">
          <SearchIcon />
          <input
            autoFocus
            aria-label="Поиск по задачам"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Найти задачу"
          />
        </div>
      )}
      <NavLink className="new-task-link" to="/new" onClick={onClose}>
        <NewTaskIcon />
        Новая задача
      </NavLink>
      <nav className="thread-nav" aria-label="Задачи">
        {groups.map((group) => {
          const key = group.project?.id ?? "ungrouped";
          const showAll = expanded.has(key) || Boolean(normalizedSearch);
          const visible = showAll ? group.threads : group.threads.slice(0, 5);
          return (
            <section className="project-group" key={key}>
              <div className="project-title">
                <FolderIcon />
                <span>{group.project?.displayName ?? "Без проекта"}</span>
              </div>
              {visible.map((thread) => (
                <ThreadLink thread={thread} key={thread.id} onNavigate={onClose} />
              ))}
              {!normalizedSearch && group.threads.length > 5 && (
                <button className="show-more" onClick={() => toggleGroup(key)}>
                  {showAll ? "Показать меньше" : `Показать ещё ${group.threads.length - 5}`}
                </button>
              )}
              {!group.threads.length && !normalizedSearch && (
                <span className="project-empty">Пока нет задач</span>
              )}
            </section>
          );
        })}
        {filteredArchive.length > 0 && (
          <details className="archive-group" open={Boolean(normalizedSearch)}>
            <summary>
              Архив
              <span>{filteredArchive.length}</span>
            </summary>
            {filteredArchive.map((thread) => (
              <ThreadLink thread={thread} key={thread.id} onNavigate={onClose} />
            ))}
          </details>
        )}
        {normalizedSearch && groups.length === 0 && filteredArchive.length === 0 && (
          <div className="sidebar-empty-search">Ничего не найдено</div>
        )}
      </nav>
      <div className="sidebar-footer">
        <button className="sidebar-footer-action" onClick={onNewProject}>
          <PlusIcon />
          Добавить проект
        </button>
        <div className="server-card">
          <div className="server-avatar">
            <ServerIcon />
          </div>
          <div className="server-copy">
            <strong>{serverName(settings.baseUrl)}</strong>
            <span>
              <ConnectionDot state={state.network} />
              {networkLabel(state.network)}
            </span>
          </div>
          {state.network !== "connected" && (
            <button className="server-retry" onClick={reconnect}>
              Повторить
            </button>
          )}
        </div>
        <div className="sidebar-preferences">
          <select
            aria-label="Тема"
            value={theme}
            onChange={(event) => onThemeChange(event.target.value)}
          >
            <option value="system">Системная тема</option>
            <option value="light">Светлая тема</option>
            <option value="dark">Тёмная тема</option>
          </select>
          <button onClick={() => void clearConnectionSettings().then(onDisconnected)}>
            Сменить сервер
          </button>
        </div>
      </div>
    </aside>
  );
}

function ThreadLink({ thread, onNavigate }: { thread: ThreadSummary; onNavigate(): void }) {
  return (
    <NavLink
      className={({ isActive }) => `thread-link ${isActive ? "active" : ""}`}
      to={`/threads/${encodeURIComponent(thread.id)}`}
      onClick={onNavigate}
    >
      <span className="thread-link-title">{thread.title}</span>
      {thread.unread && <span className="unread" aria-label="Не прочитано" />}
      <span className={`status status-${thread.state}`} title={thread.state} />
    </NavLink>
  );
}

function filterThreads(threads: ThreadSummary[], search: string): ThreadSummary[] {
  if (!search) return threads;
  return threads.filter((thread) =>
    [thread.title, thread.preview, thread.cwd].some((value) =>
      value.toLocaleLowerCase("ru").includes(search),
    ),
  );
}

function ConnectionDot({ state }: { state: "connecting" | "connected" | "offline" }) {
  return <span className={`connection-dot ${state}`} title={state} />;
}

function networkLabel(state: "connecting" | "connected" | "offline"): string {
  return state === "connected"
    ? "Подключено"
    : state === "connecting"
      ? "Подключение…"
      : "Нет связи";
}

function serverName(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "CodexNest server";
  }
}
