import { type RefObject, useEffect, useMemo, useState } from "react";
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";

import type {
  CodexRateLimitWindow,
  CodexRateLimitsResponse,
  ThreadSummary,
} from "@codexnest/protocol";

import type { ConnectionSettings } from "./storage";
import { AttentionPanel } from "./components/AttentionPanel";
import {
  FolderIcon,
  GaugeIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
  SlidersIcon,
  XIcon,
} from "./components/Icons";
import { NewSession } from "./components/NewSession";
import { ProjectDialog } from "./components/ProjectDialog";
import { SettingsPage } from "./components/SettingsPage";
import { ThreadPage } from "./components/ThreadPage";
import { useConnection } from "./connection";
import { usePushNotifications } from "./push";
import { groupedThreads } from "./state";
import { clearConnectionSettings } from "./storage";
import { useDrawerNavigation } from "./useDrawerNavigation";

export function App({
  settings,
  onDisconnected,
}: {
  settings: ConnectionSettings;
  onDisconnected(): void;
}) {
  const { api, state, reconnect } = useConnection();
  const location = useLocation();
  const navigate = useNavigate();
  const [drawer, setDrawer] = useState(false);
  const [newProject, setNewProject] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem("codexnest.theme") ?? "system");
  const {
    dragging: drawerDragging,
    frameRef,
    sidebarRef,
  } = useDrawerNavigation({
    open: drawer,
    routeKey: location.pathname,
    threadActive: /^\/threads\/[^/]+\/?$/.test(location.pathname),
    setOpen: setDrawer,
  });
  usePushNotifications(api, navigate);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("codexnest.theme", theme);
  }, [theme]);

  const snapshot = state.snapshot;
  const attention = snapshot?.attention ?? [];
  return (
    <div className={`app-frame${drawerDragging ? " drawer-dragging" : ""}`} ref={frameRef}>
      {settings.baseUrl.startsWith("http://") && (
        <div className="http-warning">
          Небезопасное HTTP-подключение: данные доступны перехватчику в LAN.
        </div>
      )}
      <Sidebar
        containerRef={sidebarRef}
        drawer={drawer}
        onClose={() => setDrawer(false)}
        onNewProject={() => setNewProject(true)}
        onDisconnected={onDisconnected}
        reconnect={reconnect}
        settings={settings}
      />
      {(drawer || drawerDragging) && (
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
            <Route
              path="/settings"
              element={
                <SettingsPage
                  onOpenNavigation={() => setDrawer(true)}
                  theme={theme}
                  onThemeChange={setTheme}
                />
              }
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
  containerRef,
  drawer,
  onClose,
  onNewProject,
  onDisconnected,
  reconnect,
  settings,
}: {
  containerRef: RefObject<HTMLElement | null>;
  drawer: boolean;
  onClose(): void;
  onNewProject(): void;
  onDisconnected(): void;
  reconnect(): void;
  settings: ConnectionSettings;
}) {
  const { api, state } = useConnection();
  const navigate = useNavigate();
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [creatingProjectId, setCreatingProjectId] = useState<string | null>(null);
  const [rateLimits, setRateLimits] = useState<CodexRateLimitsResponse | null>(null);
  const [rateLimitsLoading, setRateLimitsLoading] = useState(false);
  const [rateLimitsError, setRateLimitsError] = useState(false);
  const [createError, setCreateError] = useState<{ projectId: string; message: string } | null>(
    null,
  );
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

  async function createProjectThread(projectId: string) {
    if (creatingProjectId) return;
    setCreatingProjectId(projectId);
    setCreateError(null);
    try {
      const result = await api.createProjectThread(projectId);
      onClose();
      navigate(`/threads/${encodeURIComponent(result.thread.id)}`);
    } catch (caught) {
      setCreateError({
        projectId,
        message: caught instanceof Error ? caught.message : "Не удалось создать сессию",
      });
    } finally {
      setCreatingProjectId(null);
    }
  }

  async function refreshRateLimits() {
    if (rateLimitsLoading) return;
    setRateLimitsLoading(true);
    setRateLimitsError(false);
    try {
      setRateLimits(await api.readCodexRateLimits());
    } catch {
      setRateLimits(null);
      setRateLimitsError(true);
    } finally {
      setRateLimitsLoading(false);
    }
  }

  const rateLimitsText = rateLimitsLabel(rateLimits, rateLimitsError);

  return (
    <aside className={`sidebar ${drawer ? "open" : ""}`} ref={containerRef}>
      <div className="sidebar-toolbar">
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
        <button className="icon-button close-drawer" aria-label="Закрыть меню" onClick={onClose}>
          <XIcon />
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
                {group.project && (
                  <button
                    aria-busy={creatingProjectId === group.project.id}
                    aria-label={`Создать новую сессию в проекте ${group.project.displayName}`}
                    className="project-new-session"
                    disabled={creatingProjectId !== null}
                    type="button"
                    onClick={() => void createProjectThread(group.project!.id)}
                  >
                    {creatingProjectId === group.project.id ? (
                      <span className="spinner small" />
                    ) : (
                      <PlusIcon />
                    )}
                  </button>
                )}
              </div>
              {createError && createError.projectId === group.project?.id && (
                <div className="project-create-error" role="alert">
                  {createError.message}
                </div>
              )}
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
        <NavLink className="sidebar-footer-action" to="/settings" onClick={onClose}>
          <SlidersIcon />
          Настройки
        </NavLink>
        <button className="sidebar-footer-action" onClick={onNewProject}>
          <PlusIcon />
          Добавить проект
        </button>
        <button
          aria-busy={rateLimitsLoading}
          aria-label={rateLimitsAriaLabel(rateLimitsText, rateLimitsLoading, rateLimitsError)}
          className="sidebar-footer-action codex-limits"
          disabled={rateLimitsLoading}
          onClick={() => void refreshRateLimits()}
        >
          {rateLimitsLoading ? <span className="spinner small" /> : <GaugeIcon />}
          <span>{rateLimitsText}</span>
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
          <button onClick={() => void clearConnectionSettings().then(onDisconnected)}>
            Сменить сервер
          </button>
        </div>
      </div>
    </aside>
  );
}

function ThreadLink({ thread, onNavigate }: { thread: ThreadSummary; onNavigate(): void }) {
  const statusClass =
    thread.state === "completed" && thread.unread
      ? "status-completed-unread"
      : `status-${thread.state}`;
  return (
    <NavLink
      className={({ isActive }) => `thread-link ${isActive ? "active" : ""}`}
      to={`/threads/${encodeURIComponent(thread.id)}`}
      onClick={onNavigate}
    >
      <span className="thread-link-title">{thread.title}</span>
      <span className={`status ${statusClass}`} title={thread.state} />
    </NavLink>
  );
}

function rateLimitsLabel(limits: CodexRateLimitsResponse | null, error: boolean): string {
  if (error) return "Повторить лимиты";
  if (!limits) return "Лимиты Codex";
  const windows = [limits.primary, limits.secondary]
    .filter((window): window is CodexRateLimitWindow => window !== null)
    .map(formatRateLimitWindow);
  return windows.length ? windows.join(" · ") : "Лимиты недоступны";
}

function formatRateLimitWindow(window: CodexRateLimitWindow): string {
  const remaining = Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent)));
  return `${rateLimitDuration(window.windowDurationMins)} ${remaining}%`;
}

function rateLimitDuration(minutes: number | null): string {
  if (minutes === null) return "Лимит";
  if (minutes >= 1_440 && minutes % 1_440 === 0) return `${minutes / 1_440} д`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} ч`;
  return `${minutes} мин`;
}

function rateLimitsAriaLabel(text: string, loading: boolean, error: boolean): string {
  if (loading) return "Обновляем лимиты Codex";
  if (error) return "Повторить обновление лимитов Codex";
  return text === "Лимиты Codex" ? "Показать лимиты Codex" : `Обновить лимиты Codex: ${text}`;
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
