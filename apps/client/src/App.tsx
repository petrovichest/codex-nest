import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router";

import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import type {
  AppUpdateStatus,
  CodexRateLimitWindow,
  CodexRateLimitsResponse,
  MoveProjectRequest,
  Project,
  ThreadSummary,
  TranscriptionConfigResponse,
  UiLanguage,
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
  GripVerticalIcon,
  MoreIcon,
  NewTaskIcon,
  PlusIcon,
  SlidersIcon,
  TrashIcon,
} from "./components/Icons";
import { NewSession } from "./components/NewSession";
import { ProjectDialog } from "./components/ProjectDialog";
import {
  SettingsPage,
  type ProjectListDirection,
  type SidebarSide,
} from "./components/SettingsPage";
import { WorkspaceHeader } from "./components/WorkspaceHeader";
import { useConnection } from "./connection";
import { localizeKnownServerText, useI18n, type Translate } from "./i18n";
import { stopPushNotifications, usePushNotifications } from "./push";
import { groupedThreads } from "./state";
import { clearConnectionSettings } from "./storage";
import { threadStatusClasses } from "./thread-status";
import { useDrawerNavigation } from "./useDrawerNavigation";

const SIDEBAR_SIDE_KEY = "codexnest.sidebarSide";
const PROJECT_LIST_DIRECTION_KEY = "codexnest.projectListDirection";
const LAYOUT_DEFAULTS_VERSION_KEY = "codexnest.layoutDefaultsVersion";
const LAYOUT_DEFAULTS_VERSION = "1";
const NOTIFICATION_PROMPT_DISMISSED_KEY = "codexnest.notificationPromptDismissed";
const PROJECT_DRAG_START_DISTANCE = 6;
const PROJECT_DRAG_SCROLL_EDGE = 48;
const PROJECT_DRAG_SCROLL_SPEED = 12;
const THREAD_PREVIEW_LIMIT = 5;
const SIDEBAR_TREE_STATE_KEY_PREFIX = "codexnest.sidebarTree.v1:";

type ListExpansion = number | "all";

type SidebarTreeState = {
  collapsedProjectIds: Set<string>;
  projectListExpansions: Map<string, ListExpansion>;
};

type ProjectDragGesture = {
  active: boolean;
  clientY: number;
  direction: ProjectListDirection;
  displayProjectIds: string[];
  element: HTMLElement;
  frameId: number | null;
  insertionIndex: number;
  pointerId: number;
  projectId: string;
  startX: number;
  startY: number;
};

type ProjectDragView = {
  insertionIndex: number;
  projectId: string;
};

export function App({
  settings,
  onDisconnected,
}: {
  settings: ConnectionSettings;
  onDisconnected(): void;
}) {
  const { api, state, reconnect } = useConnection();
  const { language, setLanguage, t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const sessionWorkspace =
    location.pathname === "/new" || /^\/threads\/[^/]+\/?$/.test(location.pathname);
  const newSessionWorkspaceId = (location.state as { newSessionWorkspaceId?: unknown } | null)
    ?.newSessionWorkspaceId;
  const sessionWorkspaceKey =
    typeof newSessionWorkspaceId === "string"
      ? `new:${newSessionWorkspaceId}`
      : location.pathname === "/new"
        ? `new:direct:${location.search}`
        : "threads";
  const [drawer, setDrawer] = useState(false);
  const [newProject, setNewProject] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem("codexnest.theme") ?? "system");
  const [initialLayout] = useState(readLayoutPreferences);
  const [sidebarSide, setSidebarSide] = useState<SidebarSide>(initialLayout.sidebarSide);
  const [projectListDirection, setProjectListDirection] = useState<ProjectListDirection>(
    initialLayout.projectListDirection,
  );
  const [notificationPrompt, setNotificationPrompt] = useState(
    () =>
      getBrowserNotificationPermission() === "default" &&
      localStorage.getItem(NOTIFICATION_PROMPT_DISMISSED_KEY) !== "true",
  );
  const [notificationRequesting, setNotificationRequesting] = useState(false);
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [transcriptionConfig, setTranscriptionConfig] =
    useState<TranscriptionConfigResponse | null>(null);
  const [transcriptionConfigError, setTranscriptionConfigError] = useState<string | null>(null);
  const [appUpdateStatus, setAppUpdateStatus] = useState<AppUpdateStatus | null>(null);
  const [installedApkVersion, setInstalledApkVersion] = useState<string | null>(null);
  const appUpdateCheckAttemptedRef = useRef(false);
  const previousNetworkRef = useRef<typeof state.network | null>(null);
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
  usePushNotifications(navigate, language);
  const localizationRef = useRef({ language, t });
  localizationRef.current = { language, t };
  const acceptAppUpdateStatus = useCallback((next: AppUpdateStatus) => {
    setAppUpdateStatus((current) =>
      appUpdateStatusTimestamp(next) >= appUpdateStatusTimestamp(current) ? next : current,
    );
  }, []);

  useEffect(() => {
    const serverLanguage = state.snapshot?.uiLanguage;
    if (serverLanguage === "en" || serverLanguage === "ru") setLanguage(serverLanguage);
  }, [setLanguage, state.snapshot?.uiLanguage]);

  useEffect(() => {
    const previous = previousNetworkRef.current;
    previousNetworkRef.current = state.network;
    if (state.network !== "connected" || previous === "connected") return;

    let active = true;
    const accept = (status: AppUpdateStatus) => {
      if (active) acceptAppUpdateStatus(status);
    };
    if (!appUpdateCheckAttemptedRef.current) {
      appUpdateCheckAttemptedRef.current = true;
      void api
        .checkAppUpdate()
        .then(accept)
        .catch(() =>
          api
            .readAppSettings()
            .then(accept)
            .catch(() => undefined),
        );
    } else {
      void api
        .readAppSettings()
        .then(accept)
        .catch(() => undefined);
    }
    return () => {
      active = false;
    };
  }, [acceptAppUpdateStatus, api, state.network]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let active = true;
    void CapacitorApp.getInfo()
      .then((info) => {
        if (active) setInstalledApkVersion(info.version);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

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

  useEffect(() => {
    let cancelled = false;
    setTranscriptionConfigError(null);
    void api
      .readTranscriptionConfig()
      .then((config) => {
        if (cancelled) return;
        setTranscriptionConfig(config);
        localStorage.removeItem("codexnest.transcriptionProvider");
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setTranscriptionConfig(null);
        const localization = localizationRef.current;
        setTranscriptionConfigError(
          caught instanceof Error
            ? (localizeKnownServerText(localization.language, caught.message) ?? caught.message)
            : localization.t("Не удалось загрузить конфигурацию"),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  async function enableBrowserNotifications() {
    setNotificationRequesting(true);
    setNotificationError(null);
    try {
      const permission = await requestBrowserNotificationPermission();
      if (permission === "granted" || permission === "denied") {
        setNotificationPrompt(false);
      } else {
        setNotificationError(t("Браузер не выдал разрешение. Попробуйте ещё раз."));
      }
    } catch {
      setNotificationError(t("Не удалось запросить разрешение у браузера"));
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
  const openingThreadWithoutSnapshot =
    !snapshot && /^\/threads\/[^/]+\/?$/u.test(location.pathname);
  const attention = snapshot?.attention ?? [];
  const updateAvailable =
    appUpdateStatus?.updateAvailable === true ||
    (appUpdateStatus?.supported === true &&
      isRollingVersion(appUpdateStatus.latestVersion) &&
      installedApkVersion !== null &&
      installedApkVersion !== appUpdateStatus.latestVersion);
  return (
    <div
      className={`app-frame${drawerDragging ? " drawer-dragging" : ""}`}
      data-sidebar-side={sidebarSide}
      ref={frameRef}
    >
      {settings.baseUrl.startsWith("http://") && (
        <div className="http-warning">
          {t("Небезопасное HTTP-подключение: данные доступны перехватчику в LAN.")}
        </div>
      )}
      <Sidebar
        key={settings.baseUrl}
        containerRef={sidebarRef}
        drawer={drawer}
        onClose={() => setDrawer(false)}
        onNewProject={() => setNewProject(true)}
        projectListDirection={projectListDirection}
        serverBaseUrl={settings.baseUrl}
        updateAvailable={updateAvailable}
      />
      {(drawer || drawerDragging) && (
        <button
          className="drawer-backdrop"
          aria-label={t("Закрыть меню")}
          onClick={() => setDrawer(false)}
        />
      )}
      <main className="content">
        {state.error && (
          <div className="offline-banner">
            <span>
              {t("{{error}}. Серверные задачи продолжат выполняться.", {
                error: localizeKnownServerText(language, state.error) ?? state.error,
              })}
            </span>
            <button onClick={reconnect}>{t("Повторить")}</button>
          </div>
        )}
        {!snapshot && !openingThreadWithoutSnapshot ? (
          <div className="center-state">
            <div className="spinner" />
            <p>{t("Получаем состояние Codex…")}</p>
          </div>
        ) : sessionWorkspace ? (
          <NewSession
            key={sessionWorkspaceKey}
            projects={snapshot?.projects ?? []}
            transcriptionProvider={activeTranscriptionProvider(transcriptionConfig)}
            transcriptionConfig={transcriptionConfig}
            onOpenNavigation={() => setDrawer(true)}
          />
        ) : (
          <Routes>
            <Route
              path="/"
              element={
                <HomeRoute
                  threads={snapshot?.threads ?? []}
                  onOpenNavigation={() => setDrawer(true)}
                />
              }
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
                  transcriptionConfig={transcriptionConfig}
                  transcriptionConfigError={transcriptionConfigError}
                  onTranscriptionConfigChange={setTranscriptionConfig}
                  onAppUpdateStatusChange={acceptAppUpdateStatus}
                />
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </main>
      {attention.some((item) => !item.threadId) && (
        <div className="global-attention">
          <AttentionPanel
            requests={attention.filter((item) => !item.threadId)}
            transcriptionConfig={transcriptionConfig}
            transcriptionProvider={activeTranscriptionProvider(transcriptionConfig)}
          />
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
                <h2 id="notification-permission-title">{t("Разрешить уведомления?")}</h2>
                <p>
                  {t("CodexNest сообщит, когда задача завершится или потребуется ваше решение.")}
                </p>
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
                {t("Не сейчас")}
              </button>
              <button
                type="button"
                className="primary"
                disabled={notificationRequesting}
                onClick={() => void enableBrowserNotifications()}
              >
                {notificationRequesting ? t("Запрашиваем…") : t("Разрешить уведомления")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function activeTranscriptionProvider(
  config: TranscriptionConfigResponse | null,
): "local" | "openai" | null {
  return config?.provider && config.providers.includes(config.provider) ? config.provider : null;
}

function readLayoutPreferences(): {
  sidebarSide: SidebarSide;
  projectListDirection: ProjectListDirection;
} {
  if (localStorage.getItem(LAYOUT_DEFAULTS_VERSION_KEY) !== LAYOUT_DEFAULTS_VERSION) {
    localStorage.setItem(SIDEBAR_SIDE_KEY, "left");
    localStorage.setItem(PROJECT_LIST_DIRECTION_KEY, "top-down");
    localStorage.setItem(LAYOUT_DEFAULTS_VERSION_KEY, LAYOUT_DEFAULTS_VERSION);
  }
  return {
    sidebarSide: localStorage.getItem(SIDEBAR_SIDE_KEY) === "right" ? "right" : "left",
    projectListDirection:
      localStorage.getItem(PROJECT_LIST_DIRECTION_KEY) === "bottom-up" ? "bottom-up" : "top-down",
  };
}

function emptySidebarTreeState(): SidebarTreeState {
  return {
    collapsedProjectIds: new Set(),
    projectListExpansions: new Map(),
  };
}

function sidebarTreeStateStorageKey(serverBaseUrl: string): string {
  const normalizedBaseUrl = serverBaseUrl.replace(/\/+$/u, "");
  return `${SIDEBAR_TREE_STATE_KEY_PREFIX}${encodeURIComponent(normalizedBaseUrl)}`;
}

function readSidebarTreeState(serverBaseUrl: string): SidebarTreeState {
  try {
    const serialized = localStorage.getItem(sidebarTreeStateStorageKey(serverBaseUrl));
    if (!serialized) return emptySidebarTreeState();
    const parsed: unknown = JSON.parse(serialized);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return emptySidebarTreeState();
    }
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1) return emptySidebarTreeState();
    const collapsedProjectIds = readStringSet(record.collapsedProjectIds);
    let projectListExpansions: Map<string, ListExpansion> | null;
    if (record.projectListExpansions === undefined) {
      const expandedProjectListIds = readStringSet(record.expandedProjectListIds);
      projectListExpansions = expandedProjectListIds
        ? new Map([...expandedProjectListIds].map((id) => [id, "all" as const]))
        : null;
    } else {
      projectListExpansions = readListExpansions(record.projectListExpansions);
    }
    if (!collapsedProjectIds || !projectListExpansions) return emptySidebarTreeState();
    return {
      collapsedProjectIds,
      projectListExpansions,
    };
  } catch {
    return emptySidebarTreeState();
  }
}

function readStringSet(value: unknown): Set<string> | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return null;
  return new Set(value);
}

function readListExpansions(value: unknown): Map<string, ListExpansion> | null {
  if (
    !Array.isArray(value) ||
    value.some(
      (item) =>
        !Array.isArray(item) ||
        item.length !== 2 ||
        typeof item[0] !== "string" ||
        (item[1] !== "all" &&
          (typeof item[1] !== "number" ||
            !Number.isInteger(item[1]) ||
            item[1] <= THREAD_PREVIEW_LIMIT)),
    )
  ) {
    return null;
  }
  return new Map(value as Array<[string, ListExpansion]>);
}

function writeSidebarTreeState(serverBaseUrl: string, state: SidebarTreeState): void {
  try {
    localStorage.setItem(
      sidebarTreeStateStorageKey(serverBaseUrl),
      JSON.stringify({
        version: 1,
        collapsedProjectIds: [...state.collapsedProjectIds].sort(),
        projectListExpansions: [...state.projectListExpansions].sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      }),
    );
  } catch {
    return;
  }
}

function toggleSidebarTreeEntry(
  state: SidebarTreeState,
  field: "collapsedProjectIds",
  id: string,
): SidebarTreeState {
  const values = new Set(state[field]);
  if (values.has(id)) values.delete(id);
  else values.add(id);
  return { ...state, [field]: values };
}

function pruneSidebarTreeState(state: SidebarTreeState, projectIds: Set<string>): SidebarTreeState {
  projectIds.add("ungrouped");
  const collapsedProjectIds = retainSidebarTreeEntries(state.collapsedProjectIds, projectIds);
  const projectListExpansions = retainSidebarTreeMap(state.projectListExpansions, projectIds);
  if (
    collapsedProjectIds.size === state.collapsedProjectIds.size &&
    projectListExpansions.size === state.projectListExpansions.size
  ) {
    return state;
  }
  return {
    collapsedProjectIds,
    projectListExpansions,
  };
}

function retainSidebarTreeEntries(values: Set<string>, validIds: Set<string>): Set<string> {
  return new Set([...values].filter((id) => validIds.has(id)));
}

function retainSidebarTreeMap(
  values: Map<string, ListExpansion>,
  validIds: Set<string>,
): Map<string, ListExpansion> {
  if ([...values.keys()].every((id) => validIds.has(id))) return values;
  return new Map([...values].filter(([id]) => validIds.has(id)));
}

function toggleListExpansion(
  values: ReadonlyMap<string, ListExpansion>,
  id: string,
  total: number,
  initial: number,
): Map<string, ListExpansion> {
  const next = new Map(values);
  const expansion = next.get(id);
  const visible = expansion === "all" ? total : (expansion ?? initial);
  if (expansion === "all" || visible >= total) {
    next.delete(id);
  } else if (visible + THREAD_PREVIEW_LIMIT >= total) {
    next.set(id, "all");
  } else {
    next.set(id, visible + THREAD_PREVIEW_LIMIT);
  }
  return next;
}

function HomeRoute({
  threads,
  onOpenNavigation,
}: {
  threads: ThreadSummary[];
  onOpenNavigation(): void;
}) {
  const { t } = useI18n();
  const latest = [...threads]
    .filter((thread) => !thread.archived && thread.relation.kind === "session")
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (latest) return <Navigate to={`/threads/${encodeURIComponent(latest.id)}`} replace />;
  return (
    <div className="thread-workspace">
      <div className="conversation-pane">
        <WorkspaceHeader title={t("Нет открытых сессий")} onOpenNavigation={onOpenNavigation} />
        <div className="new-session-empty">
          <span className="new-session-glyph">
            <NewTaskIcon />
          </span>
          <h2>{t("Создайте сессию в проекте")}</h2>
          <p>{t("Откройте список проектов и нажмите + рядом с нужным проектом.")}</p>
          <button type="button" onClick={onOpenNavigation}>
            {t("Открыть проекты")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Sidebar({
  containerRef,
  drawer,
  onClose,
  onNewProject,
  projectListDirection,
  serverBaseUrl,
  updateAvailable,
}: {
  containerRef: RefObject<HTMLElement | null>;
  drawer: boolean;
  onClose(): void;
  onNewProject(): void;
  projectListDirection: ProjectListDirection;
  serverBaseUrl: string;
  updateAvailable: boolean;
}) {
  const { api, state, dispatch } = useConnection();
  const { language, t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarTree, setSidebarTree] = useState<SidebarTreeState>(() =>
    readSidebarTreeState(serverBaseUrl),
  );
  const [branchHistoryExpansions, setBranchHistoryExpansions] = useState<
    Map<string, ListExpansion>
  >(() => new Map());
  const [movingProjectId, setMovingProjectId] = useState<string | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [projectDrag, setProjectDrag] = useState<ProjectDragView | null>(null);
  const [projectNotice, setProjectNotice] = useState<{
    projectId: string;
    kind: "success" | "error";
    message: string;
  } | null>(null);
  const projectDragRef = useRef<ProjectDragGesture | null>(null);
  const noticeTimerRef = useRef<number | undefined>(undefined);
  const threadNavRef = useRef<HTMLElement>(null);
  const [rateLimits, setRateLimits] = useState<CodexRateLimitsResponse | null>(null);
  const [rateLimitsLoading, setRateLimitsLoading] = useState(false);
  const [rateLimitsError, setRateLimitsError] = useState(false);
  const snapshot = state.snapshot;
  const snapshotReady = snapshot !== null;
  const allThreads = snapshot?.threads ?? [];
  const roots = topLevelThreads(allThreads);
  const activeRoots = roots.filter((thread) => !thread.archived);
  const archivedRoots = roots.filter((thread) => thread.archived);
  const childrenByParent = childThreadsByParent(allThreads);
  const groups = groupedThreads(snapshot?.projects ?? [], activeRoots);
  const orderedGroups = projectListDirection === "bottom-up" ? [...groups].reverse() : groups;
  const displayedProjectIds = orderedGroups.flatMap((group) =>
    group.project ? [group.project.id] : [],
  );
  const projectOrderKey = snapshot?.projects.map((project) => project.id).join(":") ?? "";

  useEffect(() => {
    writeSidebarTreeState(serverBaseUrl, sidebarTree);
  }, [serverBaseUrl, sidebarTree]);

  useEffect(() => {
    if (!snapshot) return;
    setSidebarTree((current) =>
      pruneSidebarTreeState(current, new Set(snapshot.projects.map((project) => project.id))),
    );
    const threadIds = new Set(snapshot.threads.map((thread) => thread.id));
    setBranchHistoryExpansions((current) => retainSidebarTreeMap(current, threadIds));
  }, [snapshot]);

  useEffect(() => {
    if (!snapshotReady) return;
    const navigation = threadNavRef.current;
    if (!navigation) return;
    navigation.scrollTop = projectListDirection === "bottom-up" ? navigation.scrollHeight : 0;
  }, [projectListDirection, snapshotReady]);

  useEffect(
    () => () => {
      if (noticeTimerRef.current !== undefined) window.clearTimeout(noticeTimerRef.current);
      const gesture = projectDragRef.current;
      if (gesture?.frameId !== null && gesture?.frameId !== undefined) {
        window.cancelAnimationFrame(gesture.frameId);
      }
      projectDragRef.current = null;
    },
    [],
  );

  useEffect(() => {
    function cancelWithEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      const gesture = projectDragRef.current;
      if (!gesture) return;
      if (gesture.frameId !== null) window.cancelAnimationFrame(gesture.frameId);
      if (gesture.element.hasPointerCapture?.(gesture.pointerId)) {
        gesture.element.releasePointerCapture(gesture.pointerId);
      }
      projectDragRef.current = null;
      setProjectDrag(null);
    }

    window.addEventListener("keydown", cancelWithEscape);
    return () => window.removeEventListener("keydown", cancelWithEscape);
  }, []);

  useEffect(() => {
    const gesture = projectDragRef.current;
    if (!gesture) return;
    if (gesture.frameId !== null) window.cancelAnimationFrame(gesture.frameId);
    if (gesture.element.hasPointerCapture?.(gesture.pointerId)) {
      gesture.element.releasePointerCapture(gesture.pointerId);
    }
    projectDragRef.current = null;
    setProjectDrag(null);
  }, [projectOrderKey]);

  function toggleCollapsed(key: string) {
    setSidebarTree((current) => toggleSidebarTreeEntry(current, "collapsedProjectIds", key));
  }

  function toggleProjectList(key: string, total: number) {
    setSidebarTree((current) => ({
      ...current,
      projectListExpansions: toggleListExpansion(
        current.projectListExpansions,
        key,
        total,
        THREAD_PREVIEW_LIMIT,
      ),
    }));
  }

  function toggleBranchHistory(threadId: string, total: number) {
    setBranchHistoryExpansions((current) => toggleListExpansion(current, threadId, total, 0));
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
      showProjectNotice(projectId, "success", t("Путь скопирован"), true);
    } catch {
      showProjectNotice(projectId, "error", t("Не удалось скопировать путь"));
    }
  }

  async function moveProject(
    projectId: string,
    move: MoveProjectRequest,
    menu: HTMLDetailsElement | null,
  ) {
    if (movingProjectId || deletingProjectId) return;
    setMovingProjectId(projectId);
    setProjectNotice(null);
    try {
      await api.moveProject(projectId, move);
      menu?.removeAttribute("open");
    } catch (caught) {
      showProjectNotice(
        projectId,
        "error",
        caught instanceof Error
          ? (localizeKnownServerText(language, caught.message) ?? caught.message)
          : t("Не удалось изменить порядок проектов"),
      );
    } finally {
      setMovingProjectId(null);
    }
  }

  async function deleteProject(
    project: Project,
    projectThreads: ThreadSummary[],
    menu: HTMLDetailsElement | null,
  ) {
    if (deletingProjectId) return;
    if (
      projectThreads.some(
        (thread) =>
          thread.state === "running" ||
          thread.state === "queued" ||
          thread.state === "needsAttention" ||
          thread.queuedMessageCount > 0,
      )
    ) {
      menu?.removeAttribute("open");
      showProjectNotice(
        project.id,
        "error",
        t(
          "Нельзя удалить проект, пока его сессии выполняются, ждут решения или содержат сообщения в очереди",
        ),
      );
      return;
    }
    if (
      !window.confirm(
        t(
          "Удалить проект «{{project}}» из Codex Nest? Проект и его сессии исчезнут из приложения, но папка и история сохранятся.",
          { project: project.displayName },
        ),
      )
    ) {
      return;
    }
    setDeletingProjectId(project.id);
    setProjectNotice(null);
    try {
      await api.deleteProject(project.id);
      menu?.removeAttribute("open");
      dispatch({
        type: "project.remove",
        projectId: project.id,
        threadIds: projectThreads.map((thread) => thread.id),
      });
      if (
        projectThreads.some(
          (thread) => location.pathname === `/threads/${encodeURIComponent(thread.id)}`,
        )
      ) {
        onClose();
        navigate("/", { replace: true });
      }
    } catch (caught) {
      showProjectNotice(
        project.id,
        "error",
        caught instanceof Error
          ? (localizeKnownServerText(language, caught.message) ?? caught.message)
          : t("Не удалось удалить проект"),
      );
    } finally {
      setDeletingProjectId(null);
    }
  }

  function projectInsertionIndex(gesture: ProjectDragGesture): number {
    const navigation = threadNavRef.current;
    if (!navigation) return gesture.insertionIndex;
    const groups = Array.from(
      navigation.querySelectorAll<HTMLElement>(".project-group[data-project-id]"),
    ).filter((group) => group.dataset.projectId !== gesture.projectId);
    const insertionIndex = groups.findIndex((group) => {
      const header = group.querySelector<HTMLElement>(".project-title");
      if (!header) return false;
      const bounds = header.getBoundingClientRect();
      return gesture.clientY < bounds.top + bounds.height / 2;
    });
    return insertionIndex < 0 ? groups.length : insertionIndex;
  }

  function updateProjectDragTarget(gesture: ProjectDragGesture) {
    const insertionIndex = projectInsertionIndex(gesture);
    if (insertionIndex === gesture.insertionIndex) return;
    gesture.insertionIndex = insertionIndex;
    setProjectDrag({ projectId: gesture.projectId, insertionIndex });
  }

  function scheduleProjectDragFrame(gesture: ProjectDragGesture) {
    if (gesture.frameId !== null) return;
    gesture.frameId = window.requestAnimationFrame(() => {
      gesture.frameId = null;
      if (projectDragRef.current !== gesture || !gesture.active) return;
      updateProjectDragTarget(gesture);

      const navigation = threadNavRef.current;
      if (!navigation) return;
      const bounds = navigation.getBoundingClientRect();
      if (bounds.height <= 0) return;
      const topPressure = Math.max(
        0,
        Math.min(
          1,
          (bounds.top + PROJECT_DRAG_SCROLL_EDGE - gesture.clientY) / PROJECT_DRAG_SCROLL_EDGE,
        ),
      );
      const bottomPressure = Math.max(
        0,
        Math.min(
          1,
          (gesture.clientY - (bounds.bottom - PROJECT_DRAG_SCROLL_EDGE)) / PROJECT_DRAG_SCROLL_EDGE,
        ),
      );
      const scrollDelta = Math.round(PROJECT_DRAG_SCROLL_SPEED * (bottomPressure - topPressure));
      if (!scrollDelta) return;
      const previousScrollTop = navigation.scrollTop;
      navigation.scrollTop += scrollDelta;
      if (navigation.scrollTop === previousScrollTop) return;
      updateProjectDragTarget(gesture);
      scheduleProjectDragFrame(gesture);
    });
  }

  function beginProjectDrag(event: ReactPointerEvent<HTMLElement>, projectId: string) {
    if (movingProjectId || deletingProjectId || !event.isPrimary || event.button !== 0) return;
    const displayIndex = displayedProjectIds.indexOf(projectId);
    if (displayIndex < 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    projectDragRef.current = {
      active: false,
      clientY: event.clientY,
      direction: projectListDirection,
      displayProjectIds: displayedProjectIds,
      element: event.currentTarget,
      frameId: null,
      insertionIndex: displayIndex,
      pointerId: event.pointerId,
      projectId,
      startX: event.clientX,
      startY: event.clientY,
    };
    setProjectNotice(null);
  }

  function moveProjectDrag(event: ReactPointerEvent<HTMLElement>) {
    const gesture = projectDragRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gesture.clientY = event.clientY;
    if (!gesture.active) {
      const distance = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY);
      if (distance < PROJECT_DRAG_START_DISTANCE) return;
      gesture.active = true;
      setProjectDrag({
        projectId: gesture.projectId,
        insertionIndex: gesture.insertionIndex,
      });
    }
    event.preventDefault();
    updateProjectDragTarget(gesture);
    scheduleProjectDragFrame(gesture);
  }

  function clearProjectDrag(event: ReactPointerEvent<HTMLElement>) {
    const gesture = projectDragRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return null;
    if (gesture.frameId !== null) window.cancelAnimationFrame(gesture.frameId);
    if (event.currentTarget.hasPointerCapture?.(gesture.pointerId)) {
      event.currentTarget.releasePointerCapture(gesture.pointerId);
    }
    projectDragRef.current = null;
    setProjectDrag(null);
    return gesture;
  }

  function cancelProjectDrag(event: ReactPointerEvent<HTMLElement>) {
    clearProjectDrag(event);
  }

  function finishProjectDrag(event: ReactPointerEvent<HTMLElement>) {
    const gesture = clearProjectDrag(event);
    if (!gesture?.active) return;
    const remainingIds = gesture.displayProjectIds.filter((id) => id !== gesture.projectId);
    const desiredDisplayIds = [...remainingIds];
    desiredDisplayIds.splice(gesture.insertionIndex, 0, gesture.projectId);
    if (desiredDisplayIds.every((id, index) => id === gesture.displayProjectIds[index])) return;
    const desiredServerIds =
      gesture.direction === "bottom-up" ? [...desiredDisplayIds].reverse() : desiredDisplayIds;
    const targetIndex = desiredServerIds.indexOf(gesture.projectId);
    if (targetIndex < 0) return;
    void moveProject(gesture.projectId, { targetIndex }, null);
  }

  function openNewSession(projectId: string) {
    onClose();
    navigate(`/new?${new URLSearchParams({ projectId })}`, {
      state: {
        newSessionProjectId: projectId,
        newSessionWorkspaceId:
          globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
      },
    });
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

  const rateLimitsText = rateLimitsLabel(rateLimits, rateLimitsError, language, t);
  const projectDragTargets = projectDrag
    ? displayedProjectIds.filter((projectId) => projectId !== projectDrag.projectId)
    : [];
  const dropBeforeProjectId = projectDrag
    ? (projectDragTargets[projectDrag.insertionIndex] ?? null)
    : null;
  const dropAfterProjectId =
    projectDrag && dropBeforeProjectId === null ? (projectDragTargets.at(-1) ?? null) : null;
  const archive = archivedRoots.length > 0 && (
    <details className="archive-group">
      <summary>
        {t("Архив")}
        <span>{archivedRoots.length}</span>
      </summary>
      {archivedRoots.map((thread) => (
        <ThreadBranch
          branchHistoryExpansions={branchHistoryExpansions}
          thread={thread}
          childrenByParent={childrenByParent}
          key={thread.id}
          onNavigate={onClose}
          onToggleHistory={toggleBranchHistory}
        />
      ))}
    </details>
  );

  return (
    <aside className={`sidebar ${drawer ? "open" : ""}`} ref={containerRef}>
      <div className="sidebar-controls">
        <div className="server-status">
          <div
            aria-label={t("Состояние сервера: {{state}}", {
              state: networkLabel(state.network, t),
            })}
            className="server-connection"
            role="status"
          >
            <ConnectionDot state={state.network} />
            <span>{networkLabel(state.network, t)}</span>
          </div>
          {updateAvailable && (
            <NavLink
              aria-label={t("Доступно обновление CodexNest")}
              className="app-update-indicator"
              onClick={onClose}
              title={t("Доступно обновление CodexNest")}
              to="/settings"
            >
              <ArrowDownIcon />
            </NavLink>
          )}
        </div>
        <NavLink className="sidebar-control-action" to="/settings" onClick={onClose}>
          <SlidersIcon />
          {t("Настройки")}
        </NavLink>
        <button
          aria-busy={rateLimitsLoading}
          aria-label={rateLimitsAriaLabel(rateLimitsText, rateLimitsLoading, rateLimitsError, t)}
          className="sidebar-control-action codex-limits"
          disabled={rateLimitsLoading}
          onClick={() => void refreshRateLimits()}
        >
          {rateLimitsLoading ? <span className="spinner small" /> : <GaugeIcon />}
          <span>{rateLimitsText}</span>
        </button>
        <button className="sidebar-control-action" onClick={onNewProject}>
          <PlusIcon />
          {t("Добавить проект")}
        </button>
      </div>
      <nav
        className={`thread-nav ${projectListDirection}`}
        aria-label={t("Задачи")}
        ref={threadNavRef}
      >
        <div className={`project-list${projectDrag ? " project-list-dragging" : ""}`}>
          {projectListDirection === "bottom-up" && archive}
          {orderedGroups.map((group) => {
            const key = group.project?.id ?? "ungrouped";
            const groupCollapsed = sidebarTree.collapsedProjectIds.has(key);
            const projectListExpansion = sidebarTree.projectListExpansions.get(key);
            const projectListLimit =
              projectListExpansion === "all"
                ? group.threads.length
                : (projectListExpansion ?? THREAD_PREVIEW_LIMIT);
            const groupShowsAll =
              group.threads.length > THREAD_PREVIEW_LIMIT &&
              projectListLimit >= group.threads.length;
            const isBottomUp = projectListDirection === "bottom-up";
            const visible = group.threads.slice(0, projectListLimit);
            const projectThreads = group.project
              ? (snapshot?.threads.filter((thread) => thread.projectId === group.project!.id) ?? [])
              : [];
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
                  <span>{group.project?.displayName ?? t("Без проекта")}</span>
                </button>
                {group.project && (
                  <>
                    <span
                      aria-hidden="true"
                      className="project-drag-handle"
                      data-project-drag-handle
                      onLostPointerCapture={cancelProjectDrag}
                      onPointerCancel={cancelProjectDrag}
                      onPointerDown={(event) => beginProjectDrag(event, group.project!.id)}
                      onPointerMove={moveProjectDrag}
                      onPointerUp={finishProjectDrag}
                      title={t("Перетащить проект {{project}}", {
                        project: group.project.displayName,
                      })}
                    >
                      <GripVerticalIcon />
                    </span>
                    <details className="project-action-menu" data-dismiss-on-outside-click>
                      <summary
                        aria-label={t("Действия с проектом {{project}}", {
                          project: group.project.displayName,
                        })}
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
                          <CopyIcon /> {t("Копировать путь")}
                        </button>
                        <button
                          disabled={
                            cannotMoveAbove ||
                            movingProjectId !== null ||
                            deletingProjectId !== null
                          }
                          type="button"
                          onClick={(event) =>
                            void moveProject(
                              group.project!.id,
                              { direction: moveAboveDirection },
                              event.currentTarget.closest("details"),
                            )
                          }
                        >
                          <ArrowUpIcon /> {t("Переместить выше")}
                        </button>
                        <button
                          disabled={
                            cannotMoveBelow ||
                            movingProjectId !== null ||
                            deletingProjectId !== null
                          }
                          type="button"
                          onClick={(event) =>
                            void moveProject(
                              group.project!.id,
                              { direction: moveBelowDirection },
                              event.currentTarget.closest("details"),
                            )
                          }
                        >
                          <ArrowDownIcon /> {t("Переместить ниже")}
                        </button>
                        <button
                          className="danger"
                          disabled={deletingProjectId !== null}
                          type="button"
                          onClick={(event) =>
                            void deleteProject(
                              group.project!,
                              projectThreads,
                              event.currentTarget.closest("details"),
                            )
                          }
                        >
                          <TrashIcon />{" "}
                          {deletingProjectId === group.project.id
                            ? t("Удаляем…")
                            : t("Удалить проект")}
                        </button>
                      </div>
                    </details>
                    <button
                      aria-label={t("Создать новую сессию в проекте {{project}}", {
                        project: group.project.displayName,
                      })}
                      className="project-icon-action"
                      disabled={deletingProjectId !== null}
                      type="button"
                      onClick={() => openNewSession(group.project!.id)}
                    >
                      <PlusIcon />
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
              </>
            );
            const sessions = (
              <div className="project-sessions" hidden={groupCollapsed} id={sessionsId}>
                {visible.map((thread) => (
                  <ThreadBranch
                    branchHistoryExpansions={branchHistoryExpansions}
                    thread={thread}
                    childrenByParent={childrenByParent}
                    key={thread.id}
                    onNavigate={onClose}
                    onToggleHistory={toggleBranchHistory}
                  />
                ))}
                {group.threads.length > THREAD_PREVIEW_LIMIT && (
                  <button
                    className="show-more"
                    onClick={() => toggleProjectList(key, group.threads.length)}
                  >
                    {groupShowsAll
                      ? t("Показать меньше")
                      : t("Показать ещё {{count}}", {
                          count: Math.min(
                            THREAD_PREVIEW_LIMIT,
                            group.threads.length - visible.length,
                          ),
                        })}
                  </button>
                )}
                {!group.threads.length && (
                  <span className="project-empty">{t("Пока нет задач")}</span>
                )}
              </div>
            );
            const projectGroupClasses = [
              "project-group",
              group.project?.id === projectDrag?.projectId ? "project-group-dragging" : "",
              group.project?.id === dropBeforeProjectId ? "project-drop-before" : "",
              group.project?.id === dropAfterProjectId ? "project-drop-after" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <section
                className={projectGroupClasses}
                data-project-id={group.project?.id}
                key={key}
              >
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

function ThreadBranch({
  thread,
  childrenByParent,
  branchHistoryExpansions,
  onNavigate,
  onToggleHistory,
}: {
  thread: ThreadSummary;
  childrenByParent: Map<string, ThreadSummary[]>;
  branchHistoryExpansions: ReadonlyMap<string, ListExpansion>;
  onNavigate(): void;
  onToggleHistory(threadId: string, total: number): void;
}) {
  const { t } = useI18n();
  const children = childrenByParent.get(thread.id) ?? [];
  const activeChildren = children.filter((child) => child.state === "running");
  const historyChildren = children.filter((child) => child.state !== "running");
  const historyExpansion = branchHistoryExpansions.get(thread.id);
  const historyLimit =
    historyExpansion === "all" ? historyChildren.length : (historyExpansion ?? 0);
  const showsAllHistory = historyChildren.length > 0 && historyLimit >= historyChildren.length;
  const visibleChildren = [...activeChildren, ...historyChildren.slice(0, historyLimit)];

  return (
    <div className="thread-branch">
      <div className="thread-branch-row">
        <span className="thread-branch-spacer" />
        <ThreadLink thread={thread} onNavigate={onNavigate} />
      </div>
      {children.length > 0 && (
        <div className="thread-branch-children">
          {visibleChildren.map((child) => (
            <ThreadBranch
              branchHistoryExpansions={branchHistoryExpansions}
              thread={child}
              childrenByParent={childrenByParent}
              key={child.id}
              onNavigate={onNavigate}
              onToggleHistory={onToggleHistory}
            />
          ))}
          {historyChildren.length > 0 && (
            <button
              className="show-more"
              type="button"
              onClick={() => onToggleHistory(thread.id, historyChildren.length)}
            >
              {showsAllHistory
                ? t("Показать меньше")
                : t("Показать ещё {{count}}", {
                    count: Math.min(THREAD_PREVIEW_LIMIT, historyChildren.length - historyLimit),
                  })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ThreadLink({ thread, onNavigate }: { thread: ThreadSummary; onNavigate(): void }) {
  const { language } = useI18n();
  const title = localizeKnownServerText(language, thread.title) ?? thread.title;
  const agentName =
    thread.relation.kind === "subagent"
      ? thread.relation.nickname?.trim() || thread.relation.role?.trim() || null
      : null;
  return (
    <NavLink
      className={({ isActive }) => `thread-link ${isActive ? "active" : ""}`}
      to={`/threads/${encodeURIComponent(thread.id)}`}
      onClick={onNavigate}
    >
      <span className="thread-link-title">{agentName ? `${agentName} · ${title}` : title}</span>
      <span className={threadStatusClasses(thread)} title={thread.state} />
    </NavLink>
  );
}

function topLevelThreads(threads: ThreadSummary[]): ThreadSummary[] {
  return threads.filter((thread) => thread.relation.kind === "session");
}

function childThreadsByParent(threads: ThreadSummary[]): Map<string, ThreadSummary[]> {
  const result = new Map<string, ThreadSummary[]>();
  for (const thread of threads) {
    if (thread.relation.kind !== "subagent") continue;
    const children = result.get(thread.relation.parentThreadId) ?? [];
    children.push(thread);
    result.set(thread.relation.parentThreadId, children);
  }
  return result;
}

function rateLimitsLabel(
  limits: CodexRateLimitsResponse | null,
  error: boolean,
  language: UiLanguage,
  t: Translate,
): string {
  if (error) return t("Повторить лимиты");
  if (!limits) return t("Лимиты Codex");
  const windows = [limits.primary, limits.secondary]
    .filter((window): window is CodexRateLimitWindow => window !== null)
    .map((window) => formatRateLimitWindow(window, language, t));
  return windows.length ? windows.join(" · ") : t("Лимиты недоступны");
}

function formatRateLimitWindow(
  window: CodexRateLimitWindow,
  language: UiLanguage,
  t: Translate,
): string {
  const remaining = Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent)));
  const reset =
    window.resetsAt === null
      ? rateLimitDuration(window.windowDurationMins, t)
      : new Intl.DateTimeFormat(language === "ru" ? "ru-RU" : "en-US", {
          day: "2-digit",
          month: "2-digit",
        }).format(new Date(window.resetsAt));
  return `${reset} ${remaining}%`;
}

function rateLimitDuration(minutes: number | null, t: Translate): string {
  if (minutes === null) return t("Лимит");
  if (minutes >= 1_440 && minutes % 1_440 === 0) {
    return t("{{count}} д", { count: minutes / 1_440 });
  }
  if (minutes >= 60 && minutes % 60 === 0) {
    return t("{{count}} ч", { count: minutes / 60 });
  }
  return t("{{count}} мин", { count: minutes });
}

function rateLimitsAriaLabel(text: string, loading: boolean, error: boolean, t: Translate): string {
  if (loading) return t("Обновляем лимиты Codex");
  if (error) return t("Повторить обновление лимитов Codex");
  return text === t("Лимиты Codex")
    ? t("Показать лимиты Codex")
    : t("Обновить лимиты Codex: {{text}}", { text });
}

function ConnectionDot({ state }: { state: "connecting" | "connected" | "offline" }) {
  return <span aria-hidden="true" className={`connection-dot ${state}`} />;
}

function networkLabel(state: "connecting" | "connected" | "offline", t: Translate): string {
  return state === "connected"
    ? t("Подключено")
    : state === "connecting"
      ? t("Подключение…")
      : t("Нет связи");
}

function appUpdateStatusTimestamp(status: AppUpdateStatus | null): number {
  if (!status) return 0;
  const timestamp = Date.parse(status.updatedAt ?? status.checkedAt ?? "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isRollingVersion(version: string | null): version is string {
  return version !== null && /^\d+\.\d+\.\d+-[0-9a-f]{7}$/.test(version);
}
