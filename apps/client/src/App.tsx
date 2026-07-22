import { type RefObject, useEffect, useRef, useState } from "react";
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";

import type {
  CodexRateLimitWindow,
  CodexRateLimitsResponse,
  ThreadSummary,
} from "@codexnest/protocol";

import {
  getBrowserNotificationPermission,
  requestBrowserNotificationPermission,
} from "./browser-notifications";
import type { ConnectionSettings } from "./storage";
import { copyText } from "./clipboard";
import { AttentionPanel } from "./components/AttentionPanel";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BellIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  FolderIcon,
  GaugeIcon,
  MoreIcon,
  PlusIcon,
  SlidersIcon,
} from "./components/Icons";
import { NewSession } from "./components/NewSession";
import { ProjectDialog } from "./components/ProjectDialog";
import {
  SettingsPage,
  type ProjectListDirection,
  type SidebarSide,
} from "./components/SettingsPage";
import { ThreadPage } from "./components/ThreadPage";
import { useConnection } from "./connection";
import { stopPushNotifications, usePushNotifications } from "./push";
import { groupedThreads } from "./state";
import { clearConnectionSettings } from "./storage";
import { useDrawerNavigation } from "./useDrawerNavigation";

const SIDEBAR_SIDE_KEY = "codexnest.sidebarSide";
const PROJECT_LIST_DIRECTION_KEY = "codexnest.projectListDirection";
const NOTIFICATION_PROMPT_DISMISSED_KEY = "codexnest.notificationPromptDismissed";

export function App({
  settings,
  onDisconnected,
}: {
  settings: ConnectionSettings;
  onDisconnected(): void;
}) {
  const { state, reconnect } = useConnection();
  const location = useLocation();
  const navigate = useNavigate();
  const [drawer, setDrawer] = useState(false);
  const [newProject, setNewProject] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem("codexnest.theme") ?? "system");
  const [sidebarSide, setSidebarSide] = useState<SidebarSide>(() =>
    localStorage.getItem(SIDEBAR_SIDE_KEY) === "right" ? "right" : "left",
  );
  const [projectListDirection, setProjectListDirection] = useState<ProjectListDirection>(() =>
    localStorage.getItem(PROJECT_LIST_DIRECTION_KEY) === "top-down" ? "top-down" : "bottom-up",
  );
  const [notificationPrompt, setNotificationPrompt] = useState(
    () =>
      getBrowserNotificationPermission() === "default" &&
      localStorage.getItem(NOTIFICATION_PROMPT_DISMISSED_KEY) !== "true",
  );
  const [notificationRequesting, setNotificationRequesting] = useState(false);
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const {
    dragging: drawerDragging,
    frameRef,
    sidebarRef,
  } = useDrawerNavigation({
    open: drawer,
    routeKey: location.pathname,
    threadActive: /^\/threads\/[^/]+\/?$/.test(location.pathname),
    side: sidebarSide,
    setOpen: setDrawer,
  });
  usePushNotifications(navigate);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("codexnest.theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_SIDE_KEY, sidebarSide);
  }, [sidebarSide]);

  useEffect(() => {
    localStorage.setItem(PROJECT_LIST_DIRECTION_KEY, projectListDirection);
  }, [projectListDirection]);

  async function enableBrowserNotifications() {
    setNotificationRequesting(true);
    setNotificationError(null);
    try {
      const permission = await requestBrowserNotificationPermission();
      if (permission === "granted" || permission === "denied") {
        setNotificationPrompt(false);
      } else {
        setNotificationError("Браузер не выдал разрешение. Попробуйте ещё раз.");
      }
    } catch {
      setNotificationError("Не удалось запросить разрешение у браузера");
    } finally {
      setNotificationRequesting(false);
    }
  }

  function dismissNotificationPrompt() {
    localStorage.setItem(NOTIFICATION_PROMPT_DISMISSED_KEY, "true");
    setNotificationPrompt(false);
  }

  useEffect(() => {
    function closePopupsOutside(event: MouseEvent) {
      if (!(event.target instanceof Node)) return;
      document
        .querySelectorAll<HTMLDetailsElement>("details[data-dismiss-on-outside-click][open]")
        .forEach((popup) => {
          if (!popup.contains(event.target as Node)) popup.open = false;
        });
    }

    document.addEventListener("click", closePopupsOutside);
    return () => document.removeEventListener("click", closePopupsOutside);
  }, []);

  const snapshot = state.snapshot;
  const attention = snapshot?.attention ?? [];
  return (
    <div
      className={`app-frame${drawerDragging ? " drawer-dragging" : ""}`}
      data-sidebar-side={sidebarSide}
      ref={frameRef}
    >
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
        projectListDirection={projectListDirection}
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
                  onSwitchServer={() =>
                    void stopPushNotifications()
                      .catch(() => undefined)
                      .then(clearConnectionSettings)
                      .then(onDisconnected)
                  }
                  theme={theme}
                  onThemeChange={setTheme}
                  sidebarSide={sidebarSide}
                  onSidebarSideChange={setSidebarSide}
                  projectListDirection={projectListDirection}
                  onProjectListDirectionChange={setProjectListDirection}
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
      {notificationPrompt && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal compact"
            role="dialog"
            aria-modal="true"
            aria-labelledby="notification-permission-title"
          >
            <div className="settings-card-heading">
              <span className="settings-card-icon">
                <BellIcon />
              </span>
              <div>
                <h2 id="notification-permission-title">Разрешить уведомления?</h2>
                <p>CodexNest сообщит, когда задача завершится или потребуется ваше решение.</p>
              </div>
            </div>
            {notificationError && (
              <div className="settings-notice danger" role="alert">
                {notificationError}
              </div>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                disabled={notificationRequesting}
                onClick={dismissNotificationPrompt}
              >
                Не сейчас
              </button>
              <button
                type="button"
                className="primary"
                disabled={notificationRequesting}
                onClick={() => void enableBrowserNotifications()}
              >
                {notificationRequesting ? "Запрашиваем…" : "Разрешить уведомления"}
              </button>
            </div>
          </div>
        </div>
      )}
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
  projectListDirection,
}: {
  containerRef: RefObject<HTMLElement | null>;
  drawer: boolean;
  onClose(): void;
  onNewProject(): void;
  projectListDirection: ProjectListDirection;
}) {
  const { api, state } = useConnection();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [showAll, setShowAll] = useState<Set<string>>(() => new Set());
  const [creatingProjectId, setCreatingProjectId] = useState<string | null>(null);
  const [movingProjectId, setMovingProjectId] = useState<string | null>(null);
  const [projectNotice, setProjectNotice] = useState<{
    projectId: string;
    kind: "success" | "error";
    message: string;
  } | null>(null);
  const noticeTimerRef = useRef<number | undefined>(undefined);
  const threadNavRef = useRef<HTMLElement>(null);
  const [rateLimits, setRateLimits] = useState<CodexRateLimitsResponse | null>(null);
  const [rateLimitsLoading, setRateLimitsLoading] = useState(false);
  const [rateLimitsError, setRateLimitsError] = useState(false);
  const [createError, setCreateError] = useState<{ projectId: string; message: string } | null>(
    null,
  );
  const snapshot = state.snapshot;
  const activeThreads = snapshot?.threads.filter((thread) => !thread.archived) ?? [];
  const archivedThreads = snapshot?.threads.filter((thread) => thread.archived) ?? [];
  const groups = groupedThreads(snapshot?.projects ?? [], activeThreads);
  const orderedGroups = projectListDirection === "bottom-up" ? [...groups].reverse() : groups;
  const projectOrderKey = snapshot?.projects.map((project) => project.id).join(":") ?? "";

  useEffect(() => {
    const navigation = threadNavRef.current;
    if (!navigation) return;
    navigation.scrollTop = projectListDirection === "bottom-up" ? navigation.scrollHeight : 0;
  }, [projectListDirection, projectOrderKey, state.snapshotEpoch]);

  useEffect(
    () => () => {
      if (noticeTimerRef.current !== undefined) window.clearTimeout(noticeTimerRef.current);
    },
    [],
  );

  function toggleCollapsed(key: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleShowAll(key: string) {
    setShowAll((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function showProjectNotice(
    projectId: string,
    kind: "success" | "error",
    message: string,
    temporary = false,
  ) {
    if (noticeTimerRef.current !== undefined) window.clearTimeout(noticeTimerRef.current);
    setProjectNotice({ projectId, kind, message });
    if (temporary) {
      noticeTimerRef.current = window.setTimeout(() => setProjectNotice(null), 2_000);
    }
  }

  async function copyProjectPath(projectId: string, path: string, menu: HTMLDetailsElement | null) {
    try {
      await copyText(path);
      menu?.removeAttribute("open");
      showProjectNotice(projectId, "success", "Путь скопирован", true);
    } catch {
      showProjectNotice(projectId, "error", "Не удалось скопировать путь");
    }
  }

  async function moveProject(
    projectId: string,
    direction: "up" | "down",
    menu: HTMLDetailsElement | null,
  ) {
    if (movingProjectId) return;
    setMovingProjectId(projectId);
    setProjectNotice(null);
    try {
      await api.moveProject(projectId, { direction });
      menu?.removeAttribute("open");
    } catch (caught) {
      showProjectNotice(
        projectId,
        "error",
        caught instanceof Error ? caught.message : "Не удалось изменить порядок проектов",
      );
    } finally {
      setMovingProjectId(null);
    }
  }

  async function createProjectThread(projectId: string) {
    if (creatingProjectId) return;
    setCreatingProjectId(projectId);
    setCreateError(null);
    try {
      const result = await api.createProjectThread(projectId);
      onClose();
      navigate(`/threads/${encodeURIComponent(result.thread.id)}`, {
        state: { focusComposer: true },
      });
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
  const archive = archivedThreads.length > 0 && (
    <details className="archive-group">
      <summary>
        Архив
        <span>{archivedThreads.length}</span>
      </summary>
      {archivedThreads.map((thread) => (
        <ThreadLink thread={thread} key={thread.id} onNavigate={onClose} />
      ))}
    </details>
  );

  return (
    <aside className={`sidebar ${drawer ? "open" : ""}`} ref={containerRef}>
      <div className="sidebar-controls">
        <div
          aria-label={`Состояние сервера: ${networkLabel(state.network)}`}
          className="server-status"
          role="status"
        >
          <ConnectionDot state={state.network} />
          <span>{networkLabel(state.network)}</span>
        </div>
        <NavLink className="sidebar-control-action" to="/settings" onClick={onClose}>
          <SlidersIcon />
          Настройки
        </NavLink>
        <button
          aria-busy={rateLimitsLoading}
          aria-label={rateLimitsAriaLabel(rateLimitsText, rateLimitsLoading, rateLimitsError)}
          className="sidebar-control-action codex-limits"
          disabled={rateLimitsLoading}
          onClick={() => void refreshRateLimits()}
        >
          {rateLimitsLoading ? <span className="spinner small" /> : <GaugeIcon />}
          <span>{rateLimitsText}</span>
        </button>
        <button className="sidebar-control-action" onClick={onNewProject}>
          <PlusIcon />
          Добавить проект
        </button>
      </div>
      <nav className={`thread-nav ${projectListDirection}`} aria-label="Задачи" ref={threadNavRef}>
        <div className="project-list">
          {projectListDirection === "bottom-up" && archive}
          {orderedGroups.map((group) => {
            const key = group.project?.id ?? "ungrouped";
            const groupCollapsed = collapsed.has(key);
            const groupShowsAll = showAll.has(key);
            const isBottomUp = projectListDirection === "bottom-up";
            const visible = groupShowsAll ? group.threads : group.threads.slice(0, 5);
            const sessionsId = `project-sessions-${key}`;
            const projectIndex = group.project
              ? (snapshot?.projects.findIndex((project) => project.id === group.project!.id) ?? -1)
              : -1;
            const lastProjectIndex = (snapshot?.projects.length ?? 0) - 1;
            const moveAboveDirection = isBottomUp ? "down" : "up";
            const moveBelowDirection = isBottomUp ? "up" : "down";
            const cannotMoveAbove = projectIndex === (isBottomUp ? lastProjectIndex : 0);
            const cannotMoveBelow = projectIndex === (isBottomUp ? 0 : lastProjectIndex);
            const projectHeader = (
              <div className="project-title">
                <button
                  aria-controls={sessionsId}
                  aria-expanded={!groupCollapsed}
                  className="project-toggle"
                  type="button"
                  onClick={() => toggleCollapsed(key)}
                >
                  {groupCollapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
                  <FolderIcon />
                  <span>{group.project?.displayName ?? "Без проекта"}</span>
                </button>
                {group.project && (
                  <>
                    <details className="project-action-menu" data-dismiss-on-outside-click>
                      <summary
                        aria-label={`Действия с проектом ${group.project.displayName}`}
                        className="project-icon-action"
                      >
                        <MoreIcon />
                      </summary>
                      <div className="project-action-popover">
                        <button
                          type="button"
                          onClick={(event) =>
                            void copyProjectPath(
                              group.project!.id,
                              group.project!.path,
                              event.currentTarget.closest("details"),
                            )
                          }
                        >
                          <CopyIcon /> Копировать путь
                        </button>
                        <button
                          disabled={cannotMoveAbove || movingProjectId !== null}
                          type="button"
                          onClick={(event) =>
                            void moveProject(
                              group.project!.id,
                              moveAboveDirection,
                              event.currentTarget.closest("details"),
                            )
                          }
                        >
                          <ArrowUpIcon /> Переместить выше
                        </button>
                        <button
                          disabled={cannotMoveBelow || movingProjectId !== null}
                          type="button"
                          onClick={(event) =>
                            void moveProject(
                              group.project!.id,
                              moveBelowDirection,
                              event.currentTarget.closest("details"),
                            )
                          }
                        >
                          <ArrowDownIcon /> Переместить ниже
                        </button>
                      </div>
                    </details>
                    <button
                      aria-busy={creatingProjectId === group.project.id}
                      aria-label={`Создать новую сессию в проекте ${group.project.displayName}`}
                      className="project-icon-action"
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
                  </>
                )}
              </div>
            );
            const feedback = (
              <>
                {projectNotice && projectNotice.projectId === group.project?.id && (
                  <div
                    className={`project-action-notice ${projectNotice.kind}`}
                    role={projectNotice.kind === "error" ? "alert" : "status"}
                  >
                    {projectNotice.message}
                  </div>
                )}
                {createError && createError.projectId === group.project?.id && (
                  <div className="project-create-error" role="alert">
                    {createError.message}
                  </div>
                )}
              </>
            );
            const sessions = (
              <div className="project-sessions" hidden={groupCollapsed} id={sessionsId}>
                {visible.map((thread) => (
                  <ThreadLink thread={thread} key={thread.id} onNavigate={onClose} />
                ))}
                {group.threads.length > 5 && (
                  <button className="show-more" onClick={() => toggleShowAll(key)}>
                    {groupShowsAll ? "Показать меньше" : `Показать ещё ${group.threads.length - 5}`}
                  </button>
                )}
                {!group.threads.length && <span className="project-empty">Пока нет задач</span>}
              </div>
            );
            return (
              <section className="project-group" key={key}>
                {projectHeader}
                {feedback}
                {sessions}
              </section>
            );
          })}
          {projectListDirection === "top-down" && archive}
        </div>
      </nav>
    </aside>
  );
}

function ThreadLink({ thread, onNavigate }: { thread: ThreadSummary; onNavigate(): void }) {
  const statusClass =
    thread.state === "completed" && thread.unread
      ? "status-completed-unread"
      : thread.state === "interrupted" && !thread.unread
        ? "status-interrupted-read"
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

function ConnectionDot({ state }: { state: "connecting" | "connected" | "offline" }) {
  return <span aria-hidden="true" className={`connection-dot ${state}`} />;
}

function networkLabel(state: "connecting" | "connected" | "offline"): string {
  return state === "connected"
    ? "Подключено"
    : state === "connecting"
      ? "Подключение…"
      : "Нет связи";
}
