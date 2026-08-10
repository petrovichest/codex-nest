import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";

import type {
  AppSnapshot,
  AppUpdateStatus,
  Project,
  ThreadDraft,
  ThreadSummary,
  UpdateThreadDraftRequest,
} from "@codexnest/protocol";

import { App } from "./App";
import { I18nProvider } from "./i18n";

const connection = vi.hoisted(() => vi.fn());
const manualNavigationIntent = vi.hoisted(() => vi.fn());
const saveLocalDraft = vi.hoisted(() =>
  vi.fn(
    async (
      _settings: unknown,
      threadId: string,
      value: UpdateThreadDraftRequest,
      updatedAt = Date.now(),
    ) => ({
      key: threadId,
      connectionKey: "test",
      threadId,
      value,
      updatedAt,
    }),
  ),
);
const capacitor = vi.hoisted(() => ({
  addListener: vi.fn(),
  appStateHandler: null as ((state: { isActive: boolean }) => void) | null,
  backHandler: null as (() => void) | null,
  getInfo: vi.fn(),
  getPlatform: vi.fn(() => "web"),
  isNativePlatform: vi.fn(() => false),
  removeListener: vi.fn(),
}));

vi.mock("./connection", () => ({ useConnection: connection }));
vi.mock("./offline-store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  saveLocalDraft,
}));
vi.mock("./push", () => ({
  acknowledgePendingThread: vi.fn().mockResolvedValue(undefined),
  releaseActiveThread: vi.fn().mockResolvedValue(undefined),
  stopPushNotifications: vi.fn().mockResolvedValue(undefined),
  usePushNotifications: vi.fn(() => manualNavigationIntent),
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: capacitor.getPlatform,
    isNativePlatform: capacitor.isNativePlatform,
  },
}));
vi.mock("@capacitor/app", () => ({
  App: { addListener: capacitor.addListener, getInfo: capacitor.getInfo },
}));

const baseThread: ThreadSummary = {
  id: "newer",
  relation: { kind: "session", sessionId: "session" },
  projectId: "project",
  title: "Новая задача в истории",
  preview: "",
  cwd: "/work/project",
  state: "idle",
  unread: false,
  unseen: false,
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 20,
  currentTurnId: null,
  queuedMessageCount: 0,
  settings: { collaborationMode: "default" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "matchMedia",
    vi
      .fn()
      .mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  );
  capacitor.appStateHandler = null;
  capacitor.backHandler = null;
  capacitor.getPlatform.mockReturnValue("web");
  capacitor.isNativePlatform.mockReturnValue(false);
  capacitor.getInfo.mockResolvedValue({
    name: "CodexNest",
    id: "com.codexnest.app",
    version: "0.1.4",
    build: "2",
  });
  capacitor.removeListener.mockResolvedValue(undefined);
  capacitor.addListener.mockImplementation(async (event: string, listener: () => void) => {
    if (event === "appStateChange") {
      capacitor.appStateHandler = listener as unknown as (state: { isActive: boolean }) => void;
    } else if (event === "backButton") {
      capacitor.backHandler = listener;
    }
    return { remove: capacitor.removeListener };
  });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: vi.fn(() => false),
  });
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App routing and navigation", () => {
  it("offers browser notifications and requests native permission from the action", async () => {
    const requestPermission = vi.fn().mockResolvedValue("granted");
    vi.stubGlobal("Notification", { permission: "default", requestPermission });
    mockConnection(snapshot([baseThread]));

    renderApp("/threads/newer");

    const prompt = screen.getByRole("dialog", { name: "Разрешить уведомления?" });
    expect(prompt).toBeInTheDocument();
    expect(requestPermission).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseDown(prompt.parentElement!);
    expect(screen.getByRole("dialog", { name: "Разрешить уведомления?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Разрешить уведомления" }));

    await waitFor(() => expect(requestPermission).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Разрешить уведомления?" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("does not repeat a dismissed browser notification offer", () => {
    vi.stubGlobal("Notification", { permission: "default", requestPermission: vi.fn() });
    mockConnection(snapshot([baseThread]));

    const view = renderApp("/threads/newer");
    fireEvent.click(screen.getByRole("button", { name: "Не сейчас" }));
    view.unmount();
    renderApp("/threads/newer");

    expect(
      screen.queryByRole("dialog", { name: "Разрешить уведомления?" }),
    ).not.toBeInTheDocument();
  });

  it("opens the most recently updated non-archived task from the root route", async () => {
    const older = { ...baseThread, id: "older", title: "Старая задача", updatedAt: 10 };
    mockConnection(snapshot([older, baseThread]));

    renderApp("/");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Новая задача в истории" }),
    ).toBeInTheDocument();
  });

  it("isolates the workspace state when switching sessions from the sidebar", async () => {
    const other = { ...baseThread, id: "other", title: "Другая задача", updatedAt: 10 };
    mockConnection(snapshot([baseThread, other]));
    renderApp("/threads/newer");
    const context = connection.mock.results.at(-1)?.value;
    context.forceRefreshDetail.mockRejectedValueOnce(new Error("Ошибка старой сессии"));

    fireEvent.click(screen.getByRole("button", { name: "Принудительно обновить сессию" }));
    expect(await screen.findByText("Ошибка старой сессии")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Другая задача" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Другая задача" })).toBeVisible();
    expect(screen.queryByText("Ошибка старой сессии")).not.toBeInTheDocument();
  });

  it.each([
    ["desktop", false],
    ["mobile", true],
  ] as const)(
    "focuses the composer when opening another sidebar session in the %s layout",
    async (_layout, mobile) => {
      const other = { ...baseThread, id: "other", title: "Другая задача", updatedAt: 10 };
      mockConnection(snapshot([baseThread, other]));
      if (mobile) mockMobileViewport();
      renderApp("/threads/newer");

      fireEvent.click(screen.getByRole("link", { name: "Другая задача" }));

      expect(await screen.findByRole("heading", { level: 1, name: "Другая задача" })).toBeVisible();
      expect(await screen.findByRole("textbox", { name: "Сообщение для Codex" })).toHaveFocus();
    },
  );

  it("shows project-only session creation when only archived tasks exist", async () => {
    mockConnection(snapshot([{ ...baseThread, archived: true }]));

    renderApp("/");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Нет открытых сессий" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Создайте сессию в проекте")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Сообщение для Codex" })).not.toBeInTheDocument();
  });

  it("does not open the new-session editor without a project action", async () => {
    mockConnection(snapshot([]));

    renderApp("/new");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Нет открытых сессий" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Сообщение для Codex" })).not.toBeInTheDocument();
  });

  it("removes the sidebar toolbar and keeps the project session action", () => {
    mockConnection(snapshot([baseThread]));

    renderApp("/threads/newer");

    expect(screen.queryByRole("button", { name: "Назад" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Вперёд" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Новая задача" })).not.toBeInTheDocument();
    expect(screen.queryByText("CodexNest")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Поиск по задачам" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Закрыть меню" })).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Создать новую сессию в проекте Проект" }),
    ).toBeInTheDocument();
  });

  it("defaults to projects and orders the display switch above the project list", () => {
    mockConnection(snapshot([baseThread]));

    const view = renderApp("/threads/newer");
    const controls = view.container.querySelector(".sidebar-controls");
    const modeSwitch = screen.getByRole("group", { name: "Режим списка сессий" });

    expect(controls).not.toBeNull();
    expect(Array.from(controls!.children).map((element) => element.textContent?.trim())).toEqual([
      "Подключено",
      "Настройки",
      "Лимиты Codex",
      "Добавить проект",
    ]);
    expect(controls?.nextElementSibling).toBe(modeSwitch);
    expect(modeSwitch.nextElementSibling).toHaveClass("thread-nav");
    expect(screen.getByRole("button", { name: "Проекты" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Активные" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(view.container.querySelector(".project-list")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Проект" })).toBeInTheDocument();
  });

  it("switches modes, persists globally, keeps project collapse state, and falls back from invalid storage", async () => {
    mockConnection(snapshot([{ ...baseThread, state: "running" }]));

    const firstView = renderApp("/threads/newer");
    fireEvent.click(screen.getByRole("button", { name: "Проект" }));
    expect(screen.getByRole("button", { name: "Проект" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    fireEvent.click(screen.getByRole("button", { name: "Активные" }));
    await waitFor(() => expect(localStorage.getItem("codexnest.sessionListMode")).toBe("active"));
    expect(screen.queryByRole("button", { name: "Проект" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Проекты" }));
    expect(screen.getByRole("button", { name: "Проект" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: "Активные" }));
    firstView.unmount();

    const restoredView = renderApp("/threads/newer");
    expect(screen.getByRole("button", { name: "Активные" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    restoredView.unmount();

    localStorage.setItem("codexnest.sessionListMode", "unknown");
    renderApp("/threads/newer");
    expect(screen.getByRole("button", { name: "Проекты" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(localStorage.getItem("codexnest.sessionListMode")).toBe("projects"));
  });

  it("renders a flat unlimited cross-project active feed in recency order", () => {
    localStorage.setItem("codexnest.sessionListMode", "active");
    const secondProject = testProject("second-project", "Второй");
    const threads = (
      [
        {
          ...baseThread,
          id: "attention-newest",
          title: "Внимание 100",
          projectId: null,
          state: "needsAttention",
          updatedAt: 100,
        },
        {
          ...baseThread,
          id: "unread-missing-project",
          title: "Результат 90",
          projectId: "missing-project",
          state: "completed",
          unread: true,
          updatedAt: 90,
        },
        {
          ...baseThread,
          id: "failed-unread",
          title: "Ошибка 85",
          state: "failed",
          unread: true,
          updatedAt: 85,
        },
        {
          ...baseThread,
          id: "attention-80",
          title: "Внимание 80",
          state: "needsAttention",
          updatedAt: 80,
        },
        {
          ...baseThread,
          id: "attention-70",
          title: "Внимание 70",
          projectId: secondProject.id,
          state: "needsAttention",
          updatedAt: 70,
        },
        {
          ...baseThread,
          id: "interrupted-unread",
          title: "Прервана 65",
          state: "interrupted",
          unread: true,
          updatedAt: 65,
        },
        {
          ...baseThread,
          id: "attention-60",
          title: "Внимание 60",
          state: "needsAttention",
          updatedAt: 60,
        },
        {
          ...baseThread,
          id: "running",
          title: "Запущена 30",
          projectId: secondProject.id,
          state: "running",
          updatedAt: 30,
        },
        {
          ...baseThread,
          id: "queued-message",
          title: "Очередь 10",
          state: "idle",
          queuedMessageCount: 1,
          updatedAt: 10,
        },
      ] satisfies ThreadSummary[]
    ).map((thread): ThreadSummary => ({
      ...thread,
      relation: { kind: "session", sessionId: `${thread.id}-session` },
    }));
    mockConnection(snapshot(threads, [defaultProject(), secondProject]));

    const view = renderApp("/threads/running");
    const activeList = view.container.querySelector(".active-session-list") as HTMLElement;
    const rootTitles = Array.from(
      activeList.querySelectorAll(
        ":scope > .thread-branch > .thread-branch-row .thread-link-title",
      ),
    ).map((element) => element.textContent);
    const projectLabels = Array.from(
      activeList.querySelectorAll(
        ":scope > .thread-branch > .thread-branch-row .thread-link-project",
      ),
    ).map((element) => element.textContent);

    expect(rootTitles).toEqual([
      "Внимание 100",
      "Результат 90",
      "Ошибка 85",
      "Внимание 80",
      "Внимание 70",
      "Прервана 65",
      "Внимание 60",
      "Запущена 30",
      "Очередь 10",
    ]);
    expect(projectLabels).toEqual([
      "Без проекта",
      "Без проекта",
      "Проект",
      "Проект",
      "Второй",
      "Проект",
      "Проект",
      "Второй",
      "Проект",
    ]);
    expect(activeList.querySelectorAll(":scope > .thread-branch")).toHaveLength(9);
    expect(activeList.querySelector(".show-more")).toBeNull();
  });

  it("includes only eligible non-archived roots in active mode", () => {
    localStorage.setItem("codexnest.sessionListMode", "active");
    const threads = (
      [
        { ...baseThread, id: "eligible", title: "Выполняется", state: "running" },
        {
          ...baseThread,
          id: "queued-defensively",
          title: "Есть очередь",
          state: "idle",
          queuedMessageCount: 2,
        },
        { ...baseThread, id: "gray", title: "Обычная история", state: "idle" },
        { ...baseThread, id: "finished-error", title: "Законченная ошибка", state: "failed" },
        {
          ...baseThread,
          id: "archived-active",
          title: "Активная в архиве",
          state: "running",
          archived: true,
        },
      ] satisfies ThreadSummary[]
    ).map((thread): ThreadSummary => ({
      ...thread,
      relation: { kind: "session", sessionId: `${thread.id}-session` },
    }));
    mockConnection(snapshot(threads));

    const view = renderApp("/threads/eligible");

    expect(screen.getByRole("link", { name: /Выполняется/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Есть очередь/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Обычная история/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Законченная ошибка/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Активная в архиве/ })).not.toBeInTheDocument();
    expect(view.container.querySelector(".project-title")).toBeNull();
    expect(view.container.querySelector(".project-action-menu")).toBeNull();
    expect(view.container.querySelector(".archive-group")).toBeNull();
  });

  it("shows a localized empty active feed", () => {
    localStorage.setItem("codexnest.sessionListMode", "active");
    mockConnection(snapshot([baseThread]));

    renderApp("/threads/newer");

    expect(screen.getByText("Нет активных сессий")).toBeInTheDocument();
  });

  it("shows only eligible nested children in active mode with root-only project labels", () => {
    localStorage.setItem("codexnest.sessionListMode", "active");
    const root = { ...baseThread, state: "running" } satisfies ThreadSummary;
    const child = (
      id: string,
      title: string,
      overrides: Partial<ThreadSummary>,
    ): ThreadSummary => ({
      ...baseThread,
      id,
      title,
      ...overrides,
      relation: {
        kind: "subagent",
        sessionId: `${id}-session`,
        parentThreadId: root.id,
        nickname: id,
        role: "worker",
      },
    });
    const children = [
      child("queued-child", "Очередь 20", { state: "queued", updatedAt: 20 }),
      child("message-child", "Сообщение 10", {
        state: "idle",
        queuedMessageCount: 1,
        updatedAt: 10,
      }),
      child("attention-child", "Внимание 100", {
        state: "needsAttention",
        updatedAt: 100,
      }),
      child("unread-child", "Результат 90", {
        state: "completed",
        unread: true,
        updatedAt: 90,
      }),
      child("failed-child", "Ошибка 80", {
        state: "failed",
        unread: true,
        updatedAt: 80,
      }),
      child("interrupted-child", "Прервана 70", {
        state: "interrupted",
        unread: true,
        updatedAt: 70,
      }),
      child("history-child", "Серая история", { state: "idle", updatedAt: 110 }),
      child("archived-child", "Архивный субагент", {
        state: "running",
        archived: true,
        updatedAt: 120,
      }),
    ];
    mockConnection(snapshot([...children, root]));

    const view = renderApp("/threads/newer");
    const rootBranch = screen
      .getByRole("link", { name: /Новая задача в истории/ })
      .closest(".thread-branch") as HTMLElement;
    const nested = rootBranch.querySelector(":scope > .thread-branch-children") as HTMLElement;
    const nestedTitles = Array.from(
      nested.querySelectorAll(":scope > .thread-branch > .thread-branch-row .thread-link-title"),
    ).map((element) => element.textContent);

    expect(nestedTitles).toEqual([
      "attention-child · Внимание 100",
      "queued-child · Очередь 20",
      "message-child · Сообщение 10",
    ]);
    expect(screen.queryByRole("link", { name: /Результат 90/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Ошибка 80/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Прервана 70/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Серая история/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Архивный субагент/ })).not.toBeInTheDocument();
    expect(
      view.container.querySelectorAll(".active-session-list .thread-link-project"),
    ).toHaveLength(1);
    expect(view.container.querySelector(".active-session-list .show-more")).toBeNull();
  });

  it.each([
    ["connected", "Подключено"],
    ["connecting", "Подключение…"],
    ["offline", "Нет связи"],
  ] as const)("renders the %s server state as only a dot and label", (network, label) => {
    mockConnection(snapshot([baseThread]), network);

    renderApp("/threads/newer");
    const status = screen.getByRole("status", { name: `Состояние сервера: ${label}` });
    const dot = status.querySelector(".connection-dot");

    expect(status).toHaveTextContent(label);
    expect(status.children).toHaveLength(2);
    expect(dot).toHaveClass(network);
    expect(status.querySelector("svg")).toBeNull();
    expect(screen.queryByText("pi.local")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Повторить" })).not.toBeInTheDocument();
  });

  it("checks for an update once after connecting and opens settings from the icon", async () => {
    const api = mockConnection(snapshot([baseThread]));
    api.checkAppUpdate.mockResolvedValue(
      appUpdateStatus({
        latestVersion: "0.1.4-abcdef0",
        updateAvailable: true,
        checkedAt: "2026-07-25T12:00:00Z",
        updatedAt: "2026-07-25T12:00:00Z",
      }),
    );

    renderApp("/threads/newer");

    const indicator = await screen.findByRole("link", {
      name: "Доступно обновление CodexNest",
    });
    expect(api.checkAppUpdate).toHaveBeenCalledOnce();
    expect(indicator).toHaveTextContent("");
    expect(indicator).toHaveAttribute("href", "/settings?section=maintenance");

    fireEvent.click(indicator);
    expect(await screen.findByRole("heading", { level: 1, name: "Настройки" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Обслуживание" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("heading", { name: "Обновление CodexNest" })).toBeVisible();
  });

  it("shows the same icon when only the installed rolling APK is outdated", async () => {
    capacitor.isNativePlatform.mockReturnValue(true);
    capacitor.getInfo.mockResolvedValue({
      name: "CodexNest",
      id: "com.codexnest.app",
      version: "0.1.4-1111111",
      build: "1000001",
    });
    const api = mockConnection(snapshot([baseThread]));
    api.checkAppUpdate.mockResolvedValue(
      appUpdateStatus({
        currentVersion: "0.1.4-abcdef0",
        latestVersion: "0.1.4-abcdef0",
        updateAvailable: false,
        checkedAt: "2026-07-25T12:00:00Z",
        updatedAt: "2026-07-25T12:00:00Z",
      }),
    );

    renderApp("/threads/newer");

    expect(
      await screen.findByRole("link", { name: "Доступно обновление CodexNest" }),
    ).toBeInTheDocument();
    expect(capacitor.getInfo).toHaveBeenCalledOnce();
  });

  it("keeps update-check failures out of the connection status", async () => {
    const api = mockConnection(snapshot([baseThread]));
    api.checkAppUpdate.mockRejectedValue(new Error("GitHub unavailable"));
    api.readAppSettings.mockRejectedValue(new Error("status unavailable"));

    renderApp("/threads/newer");

    await waitFor(() => expect(api.readAppSettings).toHaveBeenCalledOnce());
    expect(
      screen.getByRole("status", { name: "Состояние сервера: Подключено" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Доступно обновление CodexNest" }),
    ).not.toBeInTheDocument();
  });

  it("loads and refreshes both Codex limits only when clicked", async () => {
    const api = mockConnection(snapshot([baseThread]));
    const primaryReset = Date.UTC(2026, 6, 28, 12, 30);
    const secondaryReset = Date.UTC(2026, 7, 3, 8);
    api.readCodexRateLimits
      .mockResolvedValueOnce({
        primary: { usedPercent: 20.4, windowDurationMins: 300, resetsAt: primaryReset },
        secondary: {
          usedPercent: 38.2,
          windowDurationMins: 10_080,
          resetsAt: secondaryReset,
        },
      })
      .mockResolvedValueOnce({
        primary: { usedPercent: 100.5, windowDurationMins: 300, resetsAt: null },
        secondary: null,
      });
    const formatter = new Intl.DateTimeFormat("ru-RU", {
      day: "2-digit",
      month: "2-digit",
    });

    renderApp("/threads/newer");
    expect(api.readCodexRateLimits).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Показать лимиты Codex" }));
    expect(
      await screen.findByText(
        `${formatter.format(primaryReset)} 80% · ${formatter.format(secondaryReset)} 62%`,
      ),
    ).toBeInTheDocument();
    expect(api.readCodexRateLimits).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Обновить лимиты Codex/ }));
    expect(await screen.findByText("5 ч 0%")).toBeInTheDocument();
    expect(api.readCodexRateLimits).toHaveBeenCalledTimes(2);
  });

  it("blocks concurrent limit refreshes and offers a retry after failure", async () => {
    const api = mockConnection(snapshot([baseThread]));
    let rejectRequest: ((error: Error) => void) | undefined;
    api.readCodexRateLimits.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectRequest = reject;
        }),
    );

    renderApp("/threads/newer");
    const button = screen.getByRole("button", { name: "Показать лимиты Codex" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(api.readCodexRateLimits).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Обновляем лимиты Codex" })).toBeDisabled();

    rejectRequest?.(new Error("Недоступно"));
    expect(
      await screen.findByRole("button", { name: "Повторить обновление лимитов Codex" }),
    ).toHaveTextContent("Повторить лимиты");
  });

  it("formats the Codex limit reset date in English when English is selected", async () => {
    localStorage.setItem("codexnest.uiLanguage", "en");
    const englishSnapshot = { ...snapshot([baseThread]), uiLanguage: "en" as const };
    const api = mockConnection(englishSnapshot);
    const reset = Date.UTC(2026, 6, 28, 12, 30);
    api.readCodexRateLimits.mockResolvedValue({
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: reset },
      secondary: null,
    });

    render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/threads/newer"]}>
          <App
            settings={{ baseUrl: "https://pi.local", token: "secret" }}
            onDisconnected={() => undefined}
          />
        </MemoryRouter>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show Codex limits" }));
    const formatted = new Intl.DateTimeFormat("en-US", {
      day: "2-digit",
      month: "2-digit",
    }).format(reset);
    expect(await screen.findByText(`${formatted} 75%`)).toBeInTheDocument();
  });

  it("pulses unseen outcomes and dims acknowledged sessions", () => {
    const threads: ThreadSummary[] = [
      { ...baseThread, id: "completed-read", title: "Прочитана", state: "completed" },
      {
        ...baseThread,
        id: "completed-seen",
        title: "Ответ просмотрен",
        state: "completed",
        unread: true,
      },
      {
        ...baseThread,
        id: "completed-unread",
        title: "Новый результат",
        state: "completed",
        unread: true,
        unseen: true,
      },
      {
        ...baseThread,
        id: "failed",
        title: "Ошибка",
        state: "failed",
        unread: true,
        unseen: true,
      },
      {
        ...baseThread,
        id: "interrupted-unread",
        title: "Прервана",
        state: "interrupted",
        unread: true,
        unseen: true,
      },
      {
        ...baseThread,
        id: "interrupted-read",
        title: "Прерывание прочитано",
        state: "interrupted",
      },
      { ...baseThread, id: "running", title: "Выполняется", state: "running" },
      { ...baseThread, id: "attention", title: "Нужно внимание", state: "needsAttention" },
    ];
    mockConnection(snapshot(threads));
    const { container } = renderApp("/threads/running");
    fireEvent.click(screen.getByRole("button", { name: /Показать ещё/ }));

    expect(statusFor("Прочитана")).toHaveClass("status-completed");
    expect(statusFor("Ответ просмотрен")).toHaveClass("status-completed-unread");
    expect(statusFor("Ответ просмотрен")).not.toHaveClass("status-unseen", "status-pulsing");
    expect(statusFor("Новый результат")).toHaveClass(
      "status-completed-unread",
      "status-unseen",
      "status-pulsing",
    );
    expect(statusFor("Ошибка")).toHaveClass("status-failed", "status-unseen");
    expect(statusFor("Ошибка")).not.toHaveClass("status-pulsing");
    expect(statusFor("Прервана")).toHaveClass("status-interrupted", "status-unseen");
    expect(statusFor("Прервана")).not.toHaveClass("status-pulsing");
    expect(statusFor("Прерывание прочитано")).toHaveClass("status-interrupted-read");
    expect(statusFor("Выполняется")).toHaveClass("status-running");
    expect(statusFor("Выполняется")).not.toHaveClass("status-pulsing");
    expect(statusFor("Нужно внимание")).toHaveClass("status-needsAttention", "status-pulsing");
    expect(container.querySelectorAll(".thread-link .status")).toHaveLength(8);
    expect(container.querySelector(".unread")).toBeNull();
  });

  it("restores and persists the theme from the settings page", async () => {
    localStorage.setItem("codexnest.theme", "dark");
    mockConnection(snapshot([baseThread]));

    renderApp("/settings");
    const theme = await screen.findByRole("combobox", { name: "Тема" });
    expect(theme).toHaveValue("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.resolvedTheme).toBe("dark");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute(
      "content",
      "#171817",
    );

    fireEvent.change(theme, { target: { value: "light" } });
    await waitFor(() => expect(localStorage.getItem("codexnest.theme")).toBe("light"));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.resolvedTheme).toBe("light");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute(
      "content",
      "#FFFFFF",
    );
  });

  it("keeps settings inside the app's single main landmark", () => {
    mockConnection(snapshot([baseThread]));

    const view = renderApp("/settings");
    const settingsRegion = screen.getByRole("region", { name: "Настройки" });

    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(settingsRegion).toHaveClass("settings-scroll");
    expect(view.container.querySelector("main .settings-scroll")).toBe(settingsRegion);
  });

  it("reacts to system theme changes and updates browser chrome", () => {
    let onChange: (() => void) | undefined;
    const colorScheme = {
      matches: false,
      addEventListener: vi.fn((_type: string, listener: () => void) => {
        onChange = listener;
      }),
      removeEventListener: vi.fn(),
    };
    vi.mocked(window.matchMedia).mockReturnValue(colorScheme as unknown as MediaQueryList);
    mockConnection(snapshot([baseThread]));

    renderApp("/settings");
    expect(document.documentElement.dataset.theme).toBe("system");
    expect(document.documentElement.dataset.resolvedTheme).toBe("light");

    colorScheme.matches = true;
    act(() => onChange?.());

    expect(document.documentElement.dataset.resolvedTheme).toBe("dark");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute(
      "content",
      "#171817",
    );
  });

  it("uses conventional interface defaults on a new device", async () => {
    mockConnection(snapshot([baseThread]));

    const view = renderApp("/settings");
    const frame = view.container.querySelector(".app-frame");
    const navigation = view.container.querySelector(".thread-nav");

    expect(await screen.findByRole("combobox", { name: "Тема" })).toHaveValue("system");
    expect(screen.getByRole("combobox", { name: "Боковая панель" })).toHaveValue("left");
    expect(screen.getByRole("combobox", { name: "Порядок проектов" })).toHaveValue("top-down");
    expect(frame).toHaveAttribute("data-sidebar-side", "left");
    expect(navigation).toHaveClass("top-down");
    expect(localStorage.getItem("codexnest.layoutDefaultsVersion")).toBe("1");
  });

  it("resets the old layout once and preserves later user choices", async () => {
    localStorage.setItem("codexnest.sidebarSide", "right");
    localStorage.setItem("codexnest.projectListDirection", "bottom-up");
    mockConnection(snapshot([baseThread]));

    const migrated = renderApp("/settings");
    expect(await screen.findByRole("combobox", { name: "Боковая панель" })).toHaveValue("left");
    expect(screen.getByRole("combobox", { name: "Порядок проектов" })).toHaveValue("top-down");
    expect(localStorage.getItem("codexnest.layoutDefaultsVersion")).toBe("1");
    migrated.unmount();

    localStorage.setItem("codexnest.sidebarSide", "right");
    localStorage.setItem("codexnest.projectListDirection", "bottom-up");
    const restored = renderApp("/settings");
    expect(await screen.findByRole("combobox", { name: "Боковая панель" })).toHaveValue("right");
    expect(screen.getByRole("combobox", { name: "Порядок проектов" })).toHaveValue("bottom-up");
    expect(restored.container.querySelector(".app-frame")).toHaveAttribute(
      "data-sidebar-side",
      "right",
    );
  });

  it("restores and persists the sidebar side from the settings page", async () => {
    localStorage.setItem("codexnest.layoutDefaultsVersion", "1");
    localStorage.setItem("codexnest.sidebarSide", "right");
    mockConnection(snapshot([baseThread]));

    const view = renderApp("/settings");
    const frame = view.container.querySelector(".app-frame");
    const side = await screen.findByRole("combobox", { name: "Боковая панель" });
    expect(side).toHaveValue("right");
    expect(frame).toHaveAttribute("data-sidebar-side", "right");

    fireEvent.change(side, { target: { value: "left" } });
    await waitFor(() => expect(localStorage.getItem("codexnest.sidebarSide")).toBe("left"));
    expect(frame).toHaveAttribute("data-sidebar-side", "left");
  });

  it("uses the global speech provider and removes the legacy device preference", async () => {
    localStorage.setItem("codexnest.transcriptionProvider", "openai");
    const api = mockConnection(snapshot([baseThread]));
    api.readTranscriptionConfig.mockResolvedValue({
      providers: ["local", "openai"],
      provider: "local",
      localUrl: "http://127.0.0.1:8178/inference",
      openAiApiKeyConfigured: true,
      openAiModel: "gpt-4o-transcribe",
      language: "ru",
      refineLocal: true,
      refinementModel: "gpt-5.6-luna",
      maxRecordingSeconds: 300,
      maxUploadBytes: 24 * 1024 * 1024,
    });

    renderApp("/settings");
    const provider = await screen.findByRole("combobox", {
      name: "Провайдер распознавания речи",
    });
    await waitFor(() => expect(provider).toHaveValue("local"));
    await waitFor(() => expect(localStorage.getItem("codexnest.transcriptionProvider")).toBeNull());
    expect(api.readTranscriptionConfig).toHaveBeenCalledOnce();
  });

  it("restores the project flow and scrolls to the bottom when bottom-up is selected", async () => {
    localStorage.setItem("codexnest.layoutDefaultsVersion", "1");
    localStorage.setItem("codexnest.projectListDirection", "top-down");
    mockConnection(snapshot([baseThread]));

    const view = renderApp("/settings");
    const navigation = view.container.querySelector(".thread-nav") as HTMLElement;
    Object.defineProperty(navigation, "scrollHeight", { configurable: true, value: 480 });
    const direction = await screen.findByRole("combobox", { name: "Порядок проектов" });
    expect(direction).toHaveValue("top-down");
    expect(navigation).toHaveClass("top-down");

    fireEvent.change(direction, { target: { value: "bottom-up" } });
    await waitFor(() =>
      expect(localStorage.getItem("codexnest.projectListDirection")).toBe("bottom-up"),
    );
    expect(navigation).toHaveClass("bottom-up");
    expect(navigation.scrollTop).toBe(480);
  });

  it("preserves the project-list scroll position across background snapshot updates", () => {
    mockConnection(snapshot([baseThread]));
    const view = renderApp("/threads/newer");
    const navigation = view.container.querySelector(".thread-nav") as HTMLElement;
    navigation.scrollTop = 240;
    const context = connection.mock.results.at(-1)?.value;
    context.state.snapshotEpoch += 1;
    context.state.snapshot = { ...context.state.snapshot, sequence: 2 };

    view.rerender(
      <MemoryRouter initialEntries={["/threads/newer"]}>
        <App
          settings={{ baseUrl: "https://pi.local", token: "secret" }}
          onDisconnected={() => undefined}
        />
      </MemoryRouter>,
    );

    expect(navigation.scrollTop).toBe(240);
  });

  it("reverses only project order while sessions still expand top-down", () => {
    localStorage.setItem("codexnest.layoutDefaultsVersion", "1");
    localStorage.setItem("codexnest.projectListDirection", "bottom-up");
    const threads: ThreadSummary[] = [
      { ...baseThread, id: "fresh", title: "Свежая", updatedAt: 60 },
      { ...baseThread, id: "second", title: "Вторая", updatedAt: 50 },
      { ...baseThread, id: "third", title: "Третья", updatedAt: 40 },
      { ...baseThread, id: "fourth", title: "Четвёртая", updatedAt: 30 },
      { ...baseThread, id: "fifth", title: "Пятая", updatedAt: 20 },
      { ...baseThread, id: "old", title: "Старая", updatedAt: 10 },
    ];
    const secondProject: Project = {
      id: "second-project",
      displayName: "Второй",
      path: "/work/second",
      createdAt: "2026-01-02",
      updatedAt: "2026-01-02",
    };
    mockConnection(snapshot(threads, [defaultProject(), secondProject]));

    const view = renderApp("/threads/fresh");
    expect(
      Array.from(view.container.querySelectorAll(".project-toggle")).map(
        (item) => item.textContent,
      ),
    ).toEqual(["Второй", "Проект"]);
    const projectGroup = screen
      .getByRole("button", { name: "Проект" })
      .closest(".project-group") as HTMLElement;
    const sessions = projectGroup.querySelector(".project-sessions") as HTMLElement;
    const sessionTitles = () =>
      Array.from(sessions.querySelectorAll(".thread-link-title")).map((item) => item.textContent);

    expect(Array.from(projectGroup.children).map((item) => item.className)).toEqual([
      "project-title",
      "project-sessions",
    ]);
    expect(sessionTitles()).toEqual(["Свежая", "Вторая", "Третья", "Четвёртая", "Пятая"]);
    expect(sessions.lastElementChild).toHaveClass("show-more");

    fireEvent.click(within(sessions).getByRole("button", { name: "Показать ещё 1" }));
    expect(sessionTitles()).toEqual(["Свежая", "Вторая", "Третья", "Четвёртая", "Пятая", "Старая"]);
    expect(sessions.lastElementChild).toHaveTextContent("Показать меньше");
  });

  it("reveals project sessions five at a time", () => {
    const threads = Array.from({ length: 12 }, (_, index): ThreadSummary => ({
      ...baseThread,
      id: `root-${index + 1}`,
      title: `Сессия ${index + 1}`,
      updatedAt: 100 - index,
      relation: { kind: "session", sessionId: `root-session-${index + 1}` },
    }));
    mockConnection(snapshot(threads));

    const view = renderApp("/threads/root-1");
    const sessions = view.container.querySelector(".project-sessions") as HTMLElement;
    const directBranches = () => sessions.querySelectorAll(":scope > .thread-branch");

    expect(directBranches()).toHaveLength(5);
    fireEvent.click(within(sessions).getByRole("button", { name: "Показать ещё 5" }));
    expect(directBranches()).toHaveLength(10);
    fireEvent.click(within(sessions).getByRole("button", { name: "Показать ещё 2" }));
    expect(directBranches()).toHaveLength(12);
    fireEvent.click(within(sessions).getByRole("button", { name: "Показать меньше" }));
    expect(directBranches()).toHaveLength(5);
  });

  it("always shows every non-gray and queued project session", () => {
    const gray = Array.from({ length: 5 }, (_, index): ThreadSummary => ({
      ...baseThread,
      id: `gray-${index + 1}`,
      title: `Серая ${index + 1}`,
      updatedAt: 100 - index,
      relation: { kind: "session", sessionId: `gray-session-${index + 1}` },
    }));
    const highlighted = (
      [
        { ...baseThread, id: "running-1", title: "Выполняется 1", state: "running" },
        { ...baseThread, id: "queued-1", title: "В очереди 1", state: "queued" },
        { ...baseThread, id: "attention-1", title: "Нужно решение", state: "needsAttention" },
        {
          ...baseThread,
          id: "completed-unread",
          title: "Непрочитанная завершённая",
          state: "completed",
          unread: true,
        },
        {
          ...baseThread,
          id: "failed-1",
          title: "Неподтверждённая ошибка",
          state: "failed",
          unread: true,
        },
        {
          ...baseThread,
          id: "interrupted-unread",
          title: "Непрочитанная прерванная",
          state: "interrupted",
          unread: true,
        },
        { ...baseThread, id: "running-2", title: "Выполняется 2", state: "running" },
        { ...baseThread, id: "queued-2", title: "В очереди 2", state: "queued" },
      ] satisfies ThreadSummary[]
    ).map((thread, index): ThreadSummary => ({
      ...thread,
      updatedAt: 90 - index,
      relation: { kind: "session", sessionId: `highlighted-session-${index + 1}` },
    }));
    mockConnection(snapshot([...gray, ...highlighted]));

    const view = renderApp("/threads/running-1");
    const sessions = view.container.querySelector(".project-sessions") as HTMLElement;
    const directBranches = () => sessions.querySelectorAll(":scope > .thread-branch");

    expect(directBranches()).toHaveLength(8);
    highlighted.forEach((thread) =>
      expect(screen.getByRole("link", { name: thread.title })).toBeInTheDocument(),
    );
    gray.forEach((thread) =>
      expect(screen.queryByRole("link", { name: thread.title })).not.toBeInTheDocument(),
    );

    fireEvent.click(within(sessions).getByRole("button", { name: "Показать ещё 5" }));
    expect(directBranches()).toHaveLength(13);
    fireEvent.click(within(sessions).getByRole("button", { name: "Показать меньше" }));
    expect(directBranches()).toHaveLength(8);
  });

  it("counts always-visible sessions toward the five-session preview", () => {
    const gray = Array.from({ length: 5 }, (_, index): ThreadSummary => ({
      ...baseThread,
      id: `preview-gray-${index + 1}`,
      title: `Обычная ${index + 1}`,
      updatedAt: 100 - index,
      relation: { kind: "session", sessionId: `preview-gray-session-${index + 1}` },
    }));
    const highlighted = (
      [
        { ...baseThread, id: "preview-running", title: "Старая выполняющаяся", state: "running" },
        { ...baseThread, id: "preview-queued", title: "Старая в очереди", state: "queued" },
        {
          ...baseThread,
          id: "preview-unread",
          title: "Старая непрочитанная",
          state: "completed",
          unread: true,
        },
      ] satisfies ThreadSummary[]
    ).map((thread, index): ThreadSummary => ({
      ...thread,
      updatedAt: 50 - index,
      relation: { kind: "session", sessionId: `preview-highlighted-session-${index + 1}` },
    }));
    mockConnection(snapshot([...gray, ...highlighted]));

    const view = renderApp("/threads/preview-running");
    const sessions = view.container.querySelector(".project-sessions") as HTMLElement;
    const titles = () =>
      Array.from(sessions.querySelectorAll(".thread-link-title")).map((item) => item.textContent);

    expect(titles()).toEqual([
      "Обычная 1",
      "Обычная 2",
      "Старая выполняющаяся",
      "Старая в очереди",
      "Старая непрочитанная",
    ]);
    expect(within(sessions).getByRole("button", { name: "Показать ещё 3" })).toBeInTheDocument();
  });

  it("always shows running children and keeps history behind the button", () => {
    const running: ThreadSummary = {
      ...baseThread,
      id: "running-child",
      title: "Проверить тесты",
      state: "running",
      updatedAt: 30,
      relation: {
        kind: "subagent",
        sessionId: "running-child-session",
        parentThreadId: baseThread.id,
        nickname: "tester",
        role: "worker",
      },
    };
    const completed: ThreadSummary = {
      ...running,
      id: "completed-child",
      title: "Старый отчёт",
      state: "completed",
      updatedAt: 29,
      relation: {
        kind: "subagent",
        sessionId: "completed-child-session",
        parentThreadId: baseThread.id,
        nickname: "historian",
        role: "worker",
      },
    };
    mockConnection(snapshot([running, completed, baseThread]));

    const view = renderApp("/threads/newer");

    const childLink = screen.getByRole("link", { name: /tester · Проверить тесты/ });
    expect(childLink.closest(".thread-branch-children")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /historian · Старый отчёт/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /субагентов/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Показать ещё 1" }));
    expect(screen.getByRole("link", { name: /historian · Старый отчёт/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Показать меньше" }));
    expect(screen.queryByRole("link", { name: /historian · Старый отчёт/ })).toBeNull();
    expect(view.container.querySelectorAll(".project-sessions > .thread-branch")).toHaveLength(1);
  });

  it("reveals each always-open subagent branch independently", () => {
    const activeChildren = Array.from({ length: 6 }, (_, index): ThreadSummary => ({
      ...baseThread,
      id: `active-child-${index + 1}`,
      title: `Активный ${index + 1}`,
      state: "running",
      updatedAt: 100 - index,
      relation: {
        kind: "subagent",
        sessionId: `active-child-session-${index + 1}`,
        parentThreadId: baseThread.id,
        nickname: `agent-${index + 1}`,
        role: "worker",
      },
    }));
    const historyChildren = Array.from({ length: 6 }, (_, index): ThreadSummary => ({
      ...activeChildren[index]!,
      id: `history-child-${index + 1}`,
      title: `История ${index + 1}`,
      state: "completed",
      updatedAt: 90 - index,
      relation: {
        kind: "subagent",
        sessionId: `history-child-session-${index + 1}`,
        parentThreadId: baseThread.id,
        nickname: `history-${index + 1}`,
        role: "worker",
      },
    }));
    const grandchildren = Array.from({ length: 6 }, (_, index): ThreadSummary => ({
      ...baseThread,
      id: `grandchild-${index + 1}`,
      title: `Вложенный ${index + 1}`,
      updatedAt: 80 - index,
      relation: {
        kind: "subagent",
        sessionId: `grandchild-session-${index + 1}`,
        parentThreadId: activeChildren[0]!.id,
        nickname: `nested-${index + 1}`,
        role: "worker",
      },
    }));
    mockConnection(snapshot([...activeChildren, ...historyChildren, ...grandchildren, baseThread]));

    const view = renderApp("/threads/newer");

    const rootChildren = view.container.querySelector(
      ".project-sessions > .thread-branch > .thread-branch-children",
    ) as HTMLElement;
    const directBranches = () =>
      Array.from(rootChildren.children).filter((element) =>
        element.classList.contains("thread-branch"),
      );
    expect(directBranches()).toHaveLength(6);
    expect(rootChildren.querySelector(":scope > .show-more")).toHaveTextContent("Показать ещё 5");

    const firstChildLink = within(rootChildren).getByRole("link", {
      name: /agent-1 · Активный 1/,
    });
    const firstChildBranch = firstChildLink.closest(".thread-branch") as HTMLElement;

    const nestedChildren = firstChildBranch.querySelector(
      ":scope > .thread-branch-children",
    ) as HTMLElement;
    const nestedBranches = () =>
      Array.from(nestedChildren.children).filter((element) =>
        element.classList.contains("thread-branch"),
      );
    expect(nestedBranches()).toHaveLength(0);

    fireEvent.click(rootChildren.querySelector(":scope > .show-more") as HTMLButtonElement);
    expect(directBranches()).toHaveLength(11);
    expect(nestedBranches()).toHaveLength(0);

    fireEvent.click(nestedChildren.querySelector(":scope > .show-more") as HTMLButtonElement);
    expect(nestedBranches()).toHaveLength(5);

    fireEvent.click(rootChildren.querySelector(":scope > .show-more") as HTMLButtonElement);
    expect(directBranches()).toHaveLength(12);
    expect(rootChildren.lastElementChild).toHaveTextContent("Показать меньше");
    expect(nestedBranches()).toHaveLength(5);

    fireEvent.click(rootChildren.querySelector(":scope > .show-more") as HTMLButtonElement);
    expect(directBranches()).toHaveLength(6);
    expect(nestedBranches()).toHaveLength(5);
  });

  it("restores collapsed projects and resets expanded project and branch lists", () => {
    const rootSiblings = Array.from({ length: 5 }, (_, index): ThreadSummary => ({
      ...baseThread,
      id: `root-${index + 1}`,
      title: `Корневая ${index + 1}`,
      updatedAt: 19 - index,
      relation: { kind: "session", sessionId: `root-session-${index + 1}` },
    }));
    const children = Array.from({ length: 6 }, (_, index): ThreadSummary => ({
      ...baseThread,
      id: `persisted-child-${index + 1}`,
      title: `Сохранённый субагент ${index + 1}`,
      updatedAt: 100 - index,
      relation: {
        kind: "subagent",
        sessionId: `persisted-child-session-${index + 1}`,
        parentThreadId: baseThread.id,
        nickname: `saved-${index + 1}`,
        role: "worker",
      },
    }));
    mockConnection(snapshot([baseThread, ...rootSiblings, ...children]));

    const firstView = renderApp("/threads/newer");
    const firstProjectSessions = firstView.container.querySelector(
      ".project-sessions",
    ) as HTMLElement;
    fireEvent.click(within(firstProjectSessions).getByRole("button", { name: "Показать ещё 1" }));
    const firstRootBranch = screen
      .getByRole("link", { name: "Новая задача в истории" })
      .closest(".thread-branch") as HTMLElement;
    const firstChildren = firstRootBranch.querySelector(
      ":scope > .thread-branch-children",
    ) as HTMLElement;
    fireEvent.click(within(firstChildren).getByRole("button", { name: "Показать ещё 5" }));
    expect(firstChildren.querySelectorAll(":scope > .thread-branch")).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Проект" }));
    firstView.unmount();

    const secondView = renderApp("/threads/newer");
    const projectToggle = screen.getByRole("button", { name: "Проект" });
    expect(projectToggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(projectToggle);
    const restoredProjectSessions = secondView.container.querySelector(
      ".project-sessions",
    ) as HTMLElement;
    expect(restoredProjectSessions.querySelectorAll(":scope > .thread-branch")).toHaveLength(5);
    expect(
      within(restoredProjectSessions).getByRole("button", { name: "Показать ещё 1" }),
    ).toBeInTheDocument();
    const restoredRootBranch = screen
      .getByRole("link", { name: "Новая задача в истории" })
      .closest(".thread-branch") as HTMLElement;
    expect(
      restoredRootBranch.querySelectorAll(":scope > .thread-branch-children > .thread-branch"),
    ).toHaveLength(0);
    expect(
      within(restoredRootBranch).getByRole("button", { name: "Показать ещё 5" }),
    ).toBeInTheDocument();
  });

  it("keeps sidebar tree state isolated by server", () => {
    mockConnection(snapshot([baseThread]));

    const firstView = renderApp("/threads/newer");
    fireEvent.click(screen.getByRole("button", { name: "Проект" }));
    firstView.unmount();

    const otherServerView = renderApp("/threads/newer", () => undefined, "https://other.local");
    expect(screen.getByRole("button", { name: "Проект" })).toHaveAttribute("aria-expanded", "true");
    otherServerView.unmount();

    renderApp("/threads/newer");
    expect(screen.getByRole("button", { name: "Проект" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("ignores previously persisted project list expansion", async () => {
    const storageKey = "codexnest.sidebarTree.v1:https%3A%2F%2Fpi.local";
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 1,
        collapsedProjectIds: [],
        projectListExpansions: [["project", "all"]],
      }),
    );
    const threads = Array.from({ length: 6 }, (_, index): ThreadSummary => ({
      ...baseThread,
      id: `legacy-root-${index + 1}`,
      title: `Старая сессия ${index + 1}`,
      updatedAt: 100 - index,
      relation: { kind: "session", sessionId: `legacy-root-session-${index + 1}` },
    }));
    mockConnection(snapshot(threads));

    const view = renderApp("/threads/legacy-root-1");
    expect(view.container.querySelectorAll(".project-sessions > .thread-branch")).toHaveLength(5);
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(storageKey) ?? "{}")).toEqual({
        version: 1,
        collapsedProjectIds: [],
      }),
    );
  });

  it("discards invalid and stale sidebar tree state", async () => {
    const storageKey = "codexnest.sidebarTree.v1:https%3A%2F%2Fpi.local";
    localStorage.setItem(storageKey, "{invalid");
    mockConnection(snapshot([baseThread]));

    const invalidView = renderApp("/threads/newer");
    expect(screen.getByRole("button", { name: "Проект" })).toHaveAttribute("aria-expanded", "true");
    invalidView.unmount();

    localStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 1,
        collapsedProjectIds: ["missing-project"],
        expandedProjectListIds: ["missing-project"],
        openBranchIds: ["missing-thread"],
        expandedBranchListIds: ["missing-thread"],
      }),
    );
    renderApp("/threads/newer");

    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(storageKey) ?? "{}")).toEqual({
        version: 1,
        collapsedProjectIds: [],
      }),
    );
  });

  it("resets expanded project lists when the Android app returns to the foreground", async () => {
    capacitor.isNativePlatform.mockReturnValue(true);
    const threads = Array.from({ length: 12 }, (_, index): ThreadSummary => ({
      ...baseThread,
      id: `native-root-${index + 1}`,
      title: `Android сессия ${index + 1}`,
      updatedAt: 100 - index,
      relation: { kind: "session", sessionId: `native-session-${index + 1}` },
    }));
    mockConnection(snapshot(threads));

    const view = renderApp("/threads/native-root-1");
    const sessions = view.container.querySelector(".project-sessions") as HTMLElement;
    const directBranches = () => sessions.querySelectorAll(":scope > .thread-branch");
    fireEvent.click(within(sessions).getByRole("button", { name: "Показать ещё 5" }));
    expect(directBranches()).toHaveLength(10);
    await waitFor(() => expect(capacitor.appStateHandler).not.toBeNull());

    act(() => capacitor.appStateHandler?.({ isActive: false }));
    expect(directBranches()).toHaveLength(10);
    act(() => capacitor.appStateHandler?.({ isActive: true }));
    expect(directBranches()).toHaveLength(5);

    view.unmount();
    await waitFor(() => expect(capacitor.removeListener).toHaveBeenCalledOnce());
  });

  it("resets expanded project lists when the browser becomes visible", () => {
    const threads = Array.from({ length: 12 }, (_, index): ThreadSummary => ({
      ...baseThread,
      id: `browser-root-${index + 1}`,
      title: `Браузерная сессия ${index + 1}`,
      updatedAt: 100 - index,
      relation: { kind: "session", sessionId: `browser-session-${index + 1}` },
    }));
    mockConnection(snapshot(threads));

    const view = renderApp("/threads/browser-root-1");
    const sessions = view.container.querySelector(".project-sessions") as HTMLElement;
    const directBranches = () => sessions.querySelectorAll(":scope > .thread-branch");
    fireEvent.click(within(sessions).getByRole("button", { name: "Показать ещё 5" }));
    expect(directBranches()).toHaveLength(10);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    fireEvent(document, new Event("visibilitychange"));
    expect(directBranches()).toHaveLength(10);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    fireEvent(document, new Event("visibilitychange"));
    expect(directBranches()).toHaveLength(5);
  });

  it("keeps a selected non-running child behind the history button", () => {
    const child: ThreadSummary = {
      ...baseThread,
      id: "child",
      title: "Нужно решение",
      state: "needsAttention",
      updatedAt: 30,
      relation: {
        kind: "subagent",
        sessionId: "child-session",
        parentThreadId: baseThread.id,
        nickname: "reviewer",
        role: "worker",
      },
    };
    mockConnection(snapshot([child, baseThread]));

    renderApp("/threads/child");

    expect(screen.queryByRole("link", { name: /reviewer · Нужно решение/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Показать ещё 1" })).toBeInTheDocument();
  });

  it("collapses project sessions without toggling from project actions", () => {
    mockConnection(snapshot([baseThread]));

    renderApp("/threads/newer");
    const toggle = screen.getByRole("button", { name: "Проект" });
    const projectTitle = toggle.closest(".project-title") as HTMLElement;
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(projectTitle.children[1]).toHaveClass("project-drag-handle");
    expect(projectTitle.children[2]).toHaveClass("project-action-menu");
    expect(projectTitle.children[3]).toHaveAccessibleName("Создать новую сессию в проекте Проект");

    fireEvent.click(screen.getByLabelText("Действия с проектом Проект"));
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "Создать новую сессию в проекте Проект" }));
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "Новая задача в истории" })).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByRole("link", { name: "Новая задача в истории" })).toBeInTheDocument();
  });

  it("closes popups when clicking anywhere outside them", () => {
    mockConnection(snapshot([baseThread]));

    renderApp("/threads/newer");
    const projectMenu = screen
      .getByLabelText("Действия с проектом Проект")
      .closest("details") as HTMLDetailsElement;
    const threadMenu = screen
      .getByLabelText("Действия с задачей")
      .closest("details") as HTMLDetailsElement;

    fireEvent.click(projectMenu.querySelector("summary")!);
    expect(projectMenu.open).toBe(true);

    fireEvent.click(threadMenu.querySelector("summary")!);
    expect(projectMenu.open).toBe(false);
    expect(threadMenu.open).toBe(true);

    fireEvent.click(screen.getByRole("heading", { level: 1, name: "Новая задача в истории" }));
    expect(threadMenu.open).toBe(false);
  });

  it("copies a project path and reports clipboard fallback failures", async () => {
    const writeText = vi.mocked(navigator.clipboard.writeText);
    mockConnection(snapshot([baseThread]));

    renderApp("/threads/newer");
    fireEvent.click(screen.getByLabelText("Действия с проектом Проект"));
    fireEvent.click(screen.getByRole("button", { name: "Копировать путь" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("/work/project"));
    expect(await screen.findByText("Путь скопирован")).toHaveAttribute("role", "status");

    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    vi.mocked(document.execCommand).mockReturnValue(true);
    fireEvent.click(screen.getByLabelText("Действия с проектом Проект"));
    fireEvent.click(screen.getByRole("button", { name: "Копировать путь" }));
    await waitFor(() => expect(document.execCommand).toHaveBeenCalledWith("copy"));

    vi.mocked(document.execCommand).mockReturnValue(false);
    fireEvent.click(screen.getByLabelText("Действия с проектом Проект"));
    fireEvent.click(screen.getByRole("button", { name: "Копировать путь" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось скопировать путь");
  });

  it("removes a project after confirmation and hides all of its sessions locally", async () => {
    const api = mockConnection(
      snapshot([baseThread, { ...baseThread, id: "archived", title: "Архивная", archived: true }]),
    );
    api.deleteProject.mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    renderApp("/threads/newer");
    fireEvent.click(screen.getByLabelText("Действия с проектом Проект"));
    fireEvent.click(screen.getByRole("button", { name: "Удалить проект" }));

    expect(confirm).toHaveBeenCalledWith(
      "Удалить проект «Проект» из Codex Nest? Проект и его сессии исчезнут из приложения, но папка и история сохранятся.",
    );
    await waitFor(() => expect(api.deleteProject).toHaveBeenCalledWith("project"));
    expect(api.dispatch).toHaveBeenCalledWith({
      type: "project.remove",
      projectId: "project",
      threadIds: ["newer", "archived"],
    });
    confirm.mockRestore();
  });

  it("cancels project removal without calling the API", () => {
    const api = mockConnection(snapshot([baseThread]));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    renderApp("/threads/newer");
    fireEvent.click(screen.getByLabelText("Действия с проектом Проект"));
    fireEvent.click(screen.getByRole("button", { name: "Удалить проект" }));

    expect(confirm).toHaveBeenCalledOnce();
    expect(api.deleteProject).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("blocks project removal while a session is active", async () => {
    const api = mockConnection(
      snapshot([{ ...baseThread, state: "running", currentTurnId: "turn" }]),
    );
    const confirm = vi.spyOn(window, "confirm");

    renderApp("/threads/newer");
    fireEvent.click(screen.getByLabelText("Действия с проектом Проект"));
    fireEvent.click(screen.getByRole("button", { name: "Удалить проект" }));

    expect(confirm).not.toHaveBeenCalled();
    expect(api.deleteProject).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Нельзя удалить проект, пока его сессии выполняются, ждут решения или содержат сообщения в очереди",
    );
    confirm.mockRestore();
  });

  it("shows a project-scoped error when removal fails", async () => {
    const api = mockConnection(snapshot([baseThread]));
    api.deleteProject.mockRejectedValue(new Error("Сервер недоступен"));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    renderApp("/threads/newer");
    const projectGroup = screen
      .getByLabelText("Действия с проектом Проект")
      .closest(".project-group") as HTMLElement;
    fireEvent.click(within(projectGroup).getByLabelText("Действия с проектом Проект"));
    fireEvent.click(within(projectGroup).getByRole("button", { name: "Удалить проект" }));

    expect(await within(projectGroup).findByRole("alert")).toHaveTextContent("Сервер недоступен");
    confirm.mockRestore();
  });

  it("moves projects with boundary actions disabled", async () => {
    const secondProject: Project = {
      id: "second",
      displayName: "Второй",
      path: "/work/second",
      createdAt: "2026-01-02",
      updatedAt: "2026-01-02",
    };
    const appSnapshot = snapshot([baseThread], [defaultProject(), secondProject]);
    const api = mockConnection(appSnapshot);
    api.moveProject.mockResolvedValue([secondProject, defaultProject()]);

    renderApp("/threads/newer");
    const actions = screen.getByLabelText("Действия с проектом Проект");
    const projectGroup = actions.closest(".project-group") as HTMLElement | null;
    expect(projectGroup).not.toBeNull();
    fireEvent.click(actions);
    const moveDown = within(projectGroup!).getByRole("button", { name: "Переместить ниже" });
    expect(within(projectGroup!).getByRole("button", { name: "Переместить выше" })).toBeDisabled();
    expect(moveDown).toBeEnabled();
    fireEvent.click(moveDown);

    await waitFor(() =>
      expect(api.moveProject).toHaveBeenCalledWith("project", { direction: "down" }),
    );
  });

  it("drags a project to a server target index with one pointer request", async () => {
    const secondProject = testProject("second", "Второй");
    const thirdProject = testProject("third", "Третий");
    const projects = [defaultProject(), secondProject, thirdProject];
    const api = mockConnection(snapshot([baseThread], projects));
    api.moveProject.mockResolvedValue([secondProject, thirdProject, defaultProject()]);

    const view = renderApp("/threads/newer");
    setProjectDragBounds(view.container, [80, 120, 160]);
    const handle = screen.getByTitle("Перетащить проект Проект");

    fireProjectPointer(handle, "pointerdown", { clientX: 12, clientY: 90, pointerId: 1 });
    fireProjectPointer(handle, "pointermove", { clientX: 12, clientY: 180, pointerId: 1 });

    expect(api.moveProject).not.toHaveBeenCalled();
    expect(view.container.querySelector(".project-list")).toHaveClass("project-list-dragging");
    expect(screen.getByRole("button", { name: "Третий" }).closest(".project-group")).toHaveClass(
      "project-drop-after",
    );

    fireProjectPointer(handle, "pointerup", { clientX: 12, clientY: 180, pointerId: 1 });

    await waitFor(() =>
      expect(api.moveProject).toHaveBeenCalledWith("project", { targetIndex: 2 }),
    );
    expect(api.moveProject).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector(".project-list")).not.toHaveClass("project-list-dragging");
  });

  it("drags a project after holding its title with one finger for one second", () => {
    vi.useFakeTimers();
    try {
      const secondProject = testProject("second", "Второй");
      const thirdProject = testProject("third", "Третий");
      const projects = [defaultProject(), secondProject, thirdProject];
      const api = mockConnection(snapshot([baseThread], projects));
      api.moveProject.mockResolvedValue([secondProject, thirdProject, defaultProject()]);

      const view = renderApp("/threads/newer");
      setProjectDragBounds(view.container, [80, 120, 160]);
      const toggle = screen.getByRole("button", { name: "Проект" });

      fireEvent.touchStart(toggle, {
        touches: [{ clientX: 12, clientY: 90, identifier: 7 }],
      });
      expect(fireEvent.contextMenu(toggle)).toBe(false);
      act(() => vi.advanceTimersByTime(999));

      expect(view.container.querySelector(".project-list")).not.toHaveClass(
        "project-list-dragging",
      );

      act(() => vi.advanceTimersByTime(1));

      expect(view.container.querySelector(".project-list")).toHaveClass("project-list-dragging");
      fireEvent.touchMove(window, {
        touches: [{ clientX: 12, clientY: 180, identifier: 7 }],
      });
      expect(screen.getByRole("button", { name: "Третий" }).closest(".project-group")).toHaveClass(
        "project-drop-after",
      );

      fireEvent.touchEnd(window, {
        changedTouches: [{ clientX: 12, clientY: 180, identifier: 7 }],
        touches: [],
      });

      expect(api.moveProject).toHaveBeenCalledWith("project", { targetIndex: 2 });
      expect(api.moveProject).toHaveBeenCalledTimes(1);
      expect(view.container.querySelector(".project-list")).not.toHaveClass(
        "project-list-dragging",
      );

      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps short project-title touches as taps and cancels a hold when scrolling starts", () => {
    vi.useFakeTimers();
    try {
      const secondProject = testProject("second", "Второй");
      const api = mockConnection(snapshot([baseThread], [defaultProject(), secondProject]));

      const view = renderApp("/threads/newer");
      setProjectDragBounds(view.container, [80, 120]);
      const toggle = screen.getByRole("button", { name: "Проект" });

      fireEvent.touchStart(toggle, {
        touches: [{ clientX: 12, clientY: 90, identifier: 8 }],
      });
      act(() => vi.advanceTimersByTime(999));
      fireEvent.touchEnd(window, {
        changedTouches: [{ clientX: 12, clientY: 90, identifier: 8 }],
        touches: [],
      });
      fireEvent.click(toggle);

      expect(toggle).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "true");

      fireEvent.touchStart(toggle, {
        touches: [{ clientX: 12, clientY: 90, identifier: 9 }],
      });
      expect(
        fireEvent.touchMove(window, {
          touches: [{ clientX: 12, clientY: 100, identifier: 9 }],
        }),
      ).toBe(true);
      act(() => vi.advanceTimersByTime(1_000));

      expect(api.moveProject).not.toHaveBeenCalled();
      expect(view.container.querySelector(".project-list")).not.toHaveClass(
        "project-list-dragging",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("consumes a long project-title hold without reordering at the original position", () => {
    vi.useFakeTimers();
    try {
      const secondProject = testProject("second", "Второй");
      const api = mockConnection(snapshot([baseThread], [defaultProject(), secondProject]));

      const view = renderApp("/threads/newer");
      setProjectDragBounds(view.container, [80, 120]);
      const toggle = screen.getByRole("button", { name: "Проект" });

      fireEvent.touchStart(toggle, {
        touches: [{ clientX: 12, clientY: 90, identifier: 10 }],
      });
      act(() => vi.advanceTimersByTime(1_000));
      fireEvent.touchEnd(window, {
        changedTouches: [{ clientX: 12, clientY: 90, identifier: 10 }],
        touches: [],
      });
      fireEvent.click(toggle);

      expect(api.moveProject).not.toHaveBeenCalled();
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(view.container.querySelector(".project-list")).not.toHaveClass(
        "project-list-dragging",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a project-title hold for multitouch and touch cancellation", () => {
    vi.useFakeTimers();
    try {
      const secondProject = testProject("second", "Второй");
      const api = mockConnection(snapshot([baseThread], [defaultProject(), secondProject]));

      const view = renderApp("/threads/newer");
      setProjectDragBounds(view.container, [80, 120]);
      const toggle = screen.getByRole("button", { name: "Проект" });

      fireEvent.touchStart(toggle, {
        touches: [{ clientX: 12, clientY: 90, identifier: 11 }],
      });
      fireEvent.touchStart(window, {
        touches: [
          { clientX: 12, clientY: 90, identifier: 11 },
          { clientX: 30, clientY: 90, identifier: 12 },
        ],
      });
      act(() => vi.advanceTimersByTime(1_000));

      expect(view.container.querySelector(".project-list")).not.toHaveClass(
        "project-list-dragging",
      );

      fireEvent.touchStart(toggle, {
        touches: [{ clientX: 12, clientY: 90, identifier: 13 }],
      });
      act(() => vi.advanceTimersByTime(1_000));
      expect(view.container.querySelector(".project-list")).toHaveClass("project-list-dragging");

      fireEvent.touchCancel(window, {
        changedTouches: [{ clientX: 12, clientY: 90, identifier: 13 }],
        touches: [],
      });

      expect(api.moveProject).not.toHaveBeenCalled();
      expect(view.container.querySelector(".project-list")).not.toHaveClass(
        "project-list-dragging",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps touch dragging in a bottom-up list back to server order", async () => {
    localStorage.setItem("codexnest.layoutDefaultsVersion", "1");
    localStorage.setItem("codexnest.projectListDirection", "bottom-up");
    const secondProject = testProject("second", "Второй");
    const thirdProject = testProject("third", "Третий");
    const api = mockConnection(
      snapshot([baseThread], [defaultProject(), secondProject, thirdProject]),
    );
    api.moveProject.mockResolvedValue([defaultProject(), thirdProject, secondProject]);

    const view = renderApp("/threads/newer");
    setProjectDragBounds(view.container, [80, 120, 160]);
    const handle = screen.getByTitle("Перетащить проект Третий");

    fireProjectPointer(handle, "pointerdown", {
      clientX: 12,
      clientY: 90,
      pointerId: 2,
      pointerType: "touch",
    });
    fireProjectPointer(handle, "pointermove", {
      clientX: 12,
      clientY: 140,
      pointerId: 2,
      pointerType: "touch",
    });
    fireProjectPointer(handle, "pointerup", {
      clientX: 12,
      clientY: 140,
      pointerId: 2,
      pointerType: "touch",
    });

    await waitFor(() => expect(api.moveProject).toHaveBeenCalledWith("third", { targetIndex: 1 }));
    expect(api.moveProject).toHaveBeenCalledTimes(1);
  });

  it("does not reorder for a short or cancelled project drag", () => {
    const secondProject = testProject("second", "Второй");
    const api = mockConnection(snapshot([baseThread], [defaultProject(), secondProject]));

    const view = renderApp("/threads/newer");
    setProjectDragBounds(view.container, [80, 120]);
    const handle = screen.getByTitle("Перетащить проект Проект");

    fireProjectPointer(handle, "pointerdown", { clientX: 12, clientY: 90, pointerId: 3 });
    fireProjectPointer(handle, "pointermove", { clientX: 12, clientY: 94, pointerId: 3 });
    fireProjectPointer(handle, "pointerup", { clientX: 12, clientY: 94, pointerId: 3 });

    fireProjectPointer(handle, "pointerdown", { clientX: 12, clientY: 90, pointerId: 6 });
    fireProjectPointer(handle, "pointermove", { clientX: 12, clientY: 110, pointerId: 6 });
    fireProjectPointer(handle, "pointerup", { clientX: 12, clientY: 110, pointerId: 6 });

    fireProjectPointer(handle, "pointerdown", { clientX: 12, clientY: 90, pointerId: 4 });
    fireProjectPointer(handle, "pointermove", { clientX: 12, clientY: 140, pointerId: 4 });
    fireProjectPointer(handle, "pointercancel", { clientX: 12, clientY: 140, pointerId: 4 });

    fireProjectPointer(handle, "pointerdown", { clientX: 12, clientY: 90, pointerId: 5 });
    fireProjectPointer(handle, "pointermove", { clientX: 12, clientY: 140, pointerId: 5 });
    fireEvent.keyDown(window, { key: "Escape" });

    expect(api.moveProject).not.toHaveBeenCalled();
    expect(view.container.querySelector(".project-list")).not.toHaveClass("project-list-dragging");
  });

  it("auto-scrolls the project list while dragging near its edge", async () => {
    const secondProject = testProject("second", "Второй");
    const thirdProject = testProject("third", "Третий");
    mockConnection(snapshot([baseThread], [defaultProject(), secondProject, thirdProject]));

    const view = renderApp("/threads/newer");
    setProjectDragBounds(view.container, [60, 100, 140], { top: 0, height: 180 });
    const navigation = view.container.querySelector(".thread-nav") as HTMLElement;
    const handle = screen.getByTitle("Перетащить проект Проект");

    fireProjectPointer(handle, "pointerdown", { clientX: 12, clientY: 70, pointerId: 5 });
    fireProjectPointer(handle, "pointermove", { clientX: 12, clientY: 176, pointerId: 5 });

    await waitFor(() => expect(navigation.scrollTop).toBeGreaterThan(0));
    fireProjectPointer(handle, "pointercancel", { clientX: 12, clientY: 176, pointerId: 5 });
  });

  it("shows a project-scoped error when reordering fails", async () => {
    const secondProject: Project = {
      id: "second",
      displayName: "Второй",
      path: "/work/second",
      createdAt: "2026-01-02",
      updatedAt: "2026-01-02",
    };
    const api = mockConnection(snapshot([baseThread], [defaultProject(), secondProject]));
    api.moveProject.mockRejectedValue(new Error("Сервер недоступен"));

    renderApp("/threads/newer");
    const projectGroup = screen
      .getByLabelText("Действия с проектом Проект")
      .closest(".project-group") as HTMLElement;
    fireEvent.click(within(projectGroup).getByLabelText("Действия с проектом Проект"));
    fireEvent.click(within(projectGroup).getByRole("button", { name: "Переместить ниже" }));

    expect(await within(projectGroup).findByRole("alert")).toHaveTextContent("Сервер недоступен");
  });
  it("opens a project-scoped editor without waiting for session creation", async () => {
    const secondProject = testProject("second", "Второй");
    const api = mockConnection(snapshot([baseThread], [defaultProject(), secondProject]));
    api.createProjectThread.mockReturnValue(new Promise(() => undefined));

    renderApp("/threads/newer");
    fireEvent.click(screen.getByRole("button", { name: "Создать новую сессию в проекте Второй" }));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Новая задача" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Проект" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Отправить" })).toBeDisabled();
    await waitFor(() => expect(api.createProjectThread).toHaveBeenCalledWith("second"));
  });

  it("does not activate a created thread after navigating away from its preparation", async () => {
    const creation = deferred<{ thread: ThreadSummary }>();
    const abandonedProject = testProject("abandoned-project", "Отменяемый");
    const api = mockConnection(snapshot([baseThread], [defaultProject(), abandonedProject]));
    api.createProjectThread.mockReturnValue(creation.promise);

    renderApp("/threads/newer");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Создать новую сессию в проекте Отменяемый",
      }),
    );
    await waitFor(() => expect(api.createProjectThread).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("link", { name: "Новая задача в истории" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Новая задача в истории" }),
    ).toBeInTheDocument();

    creation.resolve({ thread: { ...baseThread, id: "abandoned", title: "Оставленная задача" } });
    await act(async () => Promise.resolve());

    expect(api.dispatch).not.toHaveBeenCalledWith({
      type: "thread",
      thread: expect.objectContaining({ id: "abandoned" }),
    });
    expect(screen.queryByText("Оставленная задача")).not.toBeInTheDocument();
  });

  it("lets a second new-session route supersede the first preparation", async () => {
    const firstCreation = deferred<{ thread: ThreadSummary }>();
    const secondCreation = deferred<{ thread: ThreadSummary }>();
    const firstProject = testProject("first-project", "Первый");
    const secondProject = testProject("second-project", "Второй");
    const api = mockConnection(
      snapshot([baseThread], [defaultProject(), firstProject, secondProject]),
    );
    api.createProjectThread.mockImplementation((projectId: string) =>
      projectId === "first-project" ? firstCreation.promise : secondCreation.promise,
    );

    renderApp("/threads/newer");
    fireEvent.click(screen.getByRole("button", { name: "Создать новую сессию в проекте Первый" }));
    await waitFor(() => expect(api.createProjectThread).toHaveBeenCalledWith("first-project"));
    fireEvent.click(screen.getByRole("button", { name: "Создать новую сессию в проекте Второй" }));
    await waitFor(() => expect(api.createProjectThread).toHaveBeenCalledWith("second-project"));

    secondCreation.resolve({
      thread: {
        ...baseThread,
        id: "second-created",
        projectId: "second-project",
        title: "Вторая задача",
      },
    });
    await waitFor(() =>
      expect(api.dispatch).toHaveBeenCalledWith({
        type: "thread",
        thread: expect.objectContaining({ id: "second-created" }),
      }),
    );
    firstCreation.resolve({
      thread: { ...baseThread, id: "first-abandoned", title: "Первая задача" },
    });
    await act(async () => Promise.resolve());

    expect(api.dispatch).not.toHaveBeenCalledWith({
      type: "thread",
      thread: expect.objectContaining({ id: "first-abandoned" }),
    });
  });

  it("keeps the same focused textarea, caret, draft, and empty greeting after creation resolves", async () => {
    const creation = deferred<{ thread: ThreadSummary }>();
    const api = mockConnection(snapshot([baseThread]));
    api.createProjectThread.mockReturnValue(creation.promise);

    renderApp("/threads/newer");
    fireEvent.click(screen.getByRole("button", { name: "Создать новую сессию в проекте Проект" }));

    const textarea = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "Сообщение для Codex",
    });
    fireEvent.change(textarea, { target: { value: "Сохрани редактор целиком" } });
    textarea.focus();
    textarea.setSelectionRange(7, 15);

    expect(screen.getByRole("heading", { name: "Что поручим Codex?" })).toBeInTheDocument();
    expect(screen.getByText("Введите сообщение или добавьте контекст.")).toBeInTheDocument();
    expect(screen.queryByText(/Готовим сессию|Получаем состояние/)).not.toBeInTheDocument();
    await waitFor(() => expect(api.createProjectThread).toHaveBeenCalledOnce());

    creation.resolve({ thread: { ...baseThread, id: "created", title: "Новая задача" } });

    await waitFor(() => expect(api.updateThreadDraft).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(api.dispatch).toHaveBeenCalledWith({
        type: "thread",
        thread: expect.objectContaining({ id: "created" }),
      }),
    );
    expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).toBe(textarea);
    expect(textarea).toHaveFocus();
    expect(textarea.selectionStart).toBe(7);
    expect(textarea.selectionEnd).toBe(15);
    expect(textarea).toHaveValue("Сохрани редактор целиком");
    expect(screen.getByRole("heading", { name: "Что поручим Codex?" })).toBeInTheDocument();
    expect(screen.getByText("Введите сообщение или добавьте контекст.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Действия с задачей")).not.toBeInTheDocument();
    expect(api.updateThreadSettings).not.toHaveBeenCalled();
  });

  it("keeps pending controls open and applies only a user-changed settings patch", async () => {
    const creation = deferred<{ thread: ThreadSummary }>();
    const appSnapshot = snapshot([baseThread]);
    appSnapshot.models = [
      {
        id: "gpt",
        displayName: "GPT",
        description: "",
        isDefault: true,
        reasoningEfforts: [{ value: "high", description: null, isDefault: true }],
        serviceTiers: [{ id: "fast", displayName: "Fast" }],
        supportsPersonality: true,
      },
    ];
    appSnapshot.defaultReasoningEffort = "high";
    appSnapshot.taskDefaults = { serviceTier: "fast", personality: "friendly" };
    const api = mockConnection(appSnapshot);
    api.createProjectThread.mockReturnValue(creation.promise);

    renderApp("/threads/newer");
    fireEvent.click(screen.getByRole("button", { name: "Создать новую сессию в проекте Проект" }));
    await waitFor(() => expect(api.createProjectThread).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("button", { name: "Модель и уровень рассуждений" }));
    expect(screen.getByRole("dialog", { name: "Настройки модели" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Выключить режим планирования" }));
    expect(api.updateThreadSettings).not.toHaveBeenCalled();

    creation.resolve({
      thread: {
        ...baseThread,
        id: "created",
        title: "Новая задача",
        settings: {
          collaborationMode: "plan",
          reasoningEffort: "high",
          serviceTier: "fast",
          personality: "friendly",
        },
      },
    });

    await waitFor(() =>
      expect(api.updateThreadSettings).toHaveBeenCalledWith("created", {
        collaborationMode: "default",
      }),
    );
    await waitFor(() =>
      expect(api.dispatch).toHaveBeenCalledWith({
        type: "thread",
        thread: expect.objectContaining({ id: "created" }),
      }),
    );
    expect(screen.getByRole("dialog", { name: "Настройки модели" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(api.updateThreadSettings).toHaveBeenCalledOnce();
  });

  it("does not null-clear task defaults after a collaboration-only edit with stale metadata", async () => {
    const creation = deferred<{ thread: ThreadSummary }>();
    const appSnapshot = snapshot([baseThread]);
    appSnapshot.models = [
      {
        id: "gpt",
        displayName: "GPT",
        description: "",
        isDefault: true,
        reasoningEfforts: [{ value: "high", description: null, isDefault: true }],
        serviceTiers: [],
        supportsPersonality: false,
      },
    ];
    appSnapshot.defaultReasoningEffort = "high";
    appSnapshot.taskDefaults = { serviceTier: "fast", personality: "friendly" };
    const api = mockConnection(appSnapshot);
    api.createProjectThread.mockReturnValue(creation.promise);

    renderApp("/threads/newer");
    fireEvent.click(screen.getByRole("button", { name: "Создать новую сессию в проекте Проект" }));
    await waitFor(() => expect(api.createProjectThread).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Выключить режим планирования" }));

    creation.resolve({
      thread: {
        ...baseThread,
        id: "created",
        title: "Новая задача",
        settings: {
          collaborationMode: "plan",
          reasoningEffort: "high",
          serviceTier: "fast",
          personality: "friendly",
        },
      },
    });

    await waitFor(() =>
      expect(api.updateThreadSettings).toHaveBeenCalledWith("created", {
        collaborationMode: "default",
      }),
    );
    expect(api.updateThreadSettings).toHaveBeenCalledOnce();
  });

  it("skips settings RPC when pending Plan mode returns to the created default", async () => {
    const creation = deferred<{ thread: ThreadSummary }>();
    const appSnapshot = snapshot([baseThread]);
    appSnapshot.models = [
      {
        id: "gpt",
        displayName: "GPT",
        description: "",
        isDefault: true,
        reasoningEfforts: [{ value: "high", description: null, isDefault: true }],
        serviceTiers: [{ id: "fast", displayName: "Fast" }],
        supportsPersonality: true,
      },
    ];
    appSnapshot.defaultReasoningEffort = "high";
    appSnapshot.taskDefaults = { serviceTier: "fast", personality: "friendly" };
    const api = mockConnection(appSnapshot);
    api.createProjectThread.mockReturnValue(creation.promise);

    renderApp("/threads/newer");
    fireEvent.click(screen.getByRole("button", { name: "Создать новую сессию в проекте Проект" }));
    await waitFor(() => expect(api.createProjectThread).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Выключить режим планирования" }));
    fireEvent.click(screen.getByRole("button", { name: "Включить режим планирования" }));

    creation.resolve({
      thread: {
        ...baseThread,
        id: "created",
        title: "Новая задача",
        settings: {
          collaborationMode: "plan",
          reasoningEffort: "high",
          serviceTier: "fast",
          personality: "friendly",
        },
      },
    });
    await waitFor(() =>
      expect(api.dispatch).toHaveBeenCalledWith({
        type: "thread",
        thread: expect.objectContaining({ id: "created" }),
      }),
    );

    expect(api.updateThreadSettings).not.toHaveBeenCalled();
  });

  it("submits once through the in-flight creation request and transfers its optimistic message", async () => {
    const creation = deferred<{ thread: ThreadSummary }>();
    const api = mockConnection(snapshot([baseThread]));
    api.createProjectThread.mockReturnValue(creation.promise);

    renderApp("/threads/newer");
    fireEvent.click(screen.getByRole("button", { name: "Создать новую сессию в проекте Проект" }));
    const textarea = await screen.findByRole("textbox", { name: "Сообщение для Codex" });
    await waitFor(() => expect(api.createProjectThread).toHaveBeenCalledOnce());
    fireEvent.change(textarea, { target: { value: "Отправь без ожидания" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    expect(screen.getByText("Отправь без ожидания")).toBeInTheDocument();
    expect(textarea).toHaveValue("");
    expect(api.createProjectThread).toHaveBeenCalledOnce();

    creation.resolve({ thread: { ...baseThread, id: "created", title: "Новая задача" } });

    await waitFor(() =>
      expect(api.sendReliable).toHaveBeenCalledWith(
        "created",
        expect.objectContaining({ input: "Отправь без ожидания" }),
      ),
    );
    expect(api.createProjectThread).toHaveBeenCalledOnce();
    expect(api.sendReliable).toHaveBeenCalledOnce();
    expect(api.updateThreadDraft).not.toHaveBeenCalled();
    expect(api.dispatch).toHaveBeenCalledWith({
      type: "optimistic.add",
      message: expect.objectContaining({
        threadId: "created",
        text: "Отправь без ожидания",
      }),
    });
  });

  it("uses the activated thread when sending before the handoff rerenders", async () => {
    const creation = deferred<{ thread: ThreadSummary }>();
    const api = mockConnection(snapshot([baseThread]));
    api.createProjectThread.mockReturnValue(creation.promise);

    renderApp("/threads/newer");
    fireEvent.click(screen.getByRole("button", { name: "Создать новую сессию в проекте Проект" }));
    const textarea = await screen.findByRole("textbox", { name: "Сообщение для Codex" });
    await waitFor(() => expect(api.createProjectThread).toHaveBeenCalledOnce());
    fireEvent.change(textarea, { target: { value: "Отправь на границе создания" } });

    let submittedDuringHandoff = false;
    api.dispatch.mockImplementation((action: { type: string; thread?: ThreadSummary }) => {
      if (!submittedDuringHandoff && action.type === "thread" && action.thread?.id === "created") {
        submittedDuringHandoff = true;
        fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
      }
    });

    creation.resolve({ thread: { ...baseThread, id: "created", title: "Новая задача" } });

    await waitFor(() =>
      expect(api.sendReliable).toHaveBeenCalledWith(
        "created",
        expect.objectContaining({ input: "Отправь на границе создания" }),
      ),
    );
    expect(submittedDuringHandoff).toBe(true);
    expect(api.sendReliable.mock.calls.some(([id]) => id === "")).toBe(false);
    expect(api.dispatch).toHaveBeenCalledWith({
      type: "optimistic.add",
      message: expect.objectContaining({
        threadId: "created",
        text: "Отправь на границе создания",
      }),
    });
  });

  it("reapplies a newer draft when a stale transfer clear fails after early send", async () => {
    const creation = deferred<{ thread: ThreadSummary }>();
    const stalePut = deferred<ThreadDraft | null>();
    const clearPut = deferred<ThreadDraft | null>();
    const api = mockConnection(snapshot([baseThread]));
    let putCount = 0;
    api.createProjectThread.mockReturnValue(creation.promise);
    api.updateThreadDraft.mockImplementation(
      (_threadId: string, draft: UpdateThreadDraftRequest) => {
        putCount += 1;
        if (putCount === 1) return stalePut.promise;
        if (putCount === 2) return clearPut.promise;
        return Promise.resolve({ ...draft, updatedAt: Date.now() });
      },
    );

    renderApp("/threads/newer");
    fireEvent.click(screen.getByRole("button", { name: "Создать новую сессию в проекте Проект" }));
    const textarea = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "Сообщение для Codex",
    });
    fireEvent.change(textarea, { target: { value: "Черновик A" } });
    creation.resolve({ thread: { ...baseThread, id: "created", title: "Новая задача" } });

    await waitFor(() =>
      expect(api.updateThreadDraft).toHaveBeenNthCalledWith(
        1,
        "created",
        expect.objectContaining({ input: "Черновик A" }),
        { retry: true },
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() => expect(api.sendReliable).toHaveBeenCalledOnce());

    stalePut.resolve({
      input: "Черновик A",
      images: [],
      goalMode: false,
      annotations: [],
      updatedAt: 1,
    });
    await waitFor(() =>
      expect(api.updateThreadDraft).toHaveBeenNthCalledWith(
        2,
        "created",
        { input: "", images: [], goalMode: false, annotations: [] },
        { retry: true },
      ),
    );

    fireEvent.change(textarea, { target: { value: "Черновик B" } });
    clearPut.reject(new Error("Clear failed"));

    await waitFor(() =>
      expect(api.updateThreadDraft).toHaveBeenLastCalledWith(
        "created",
        expect.objectContaining({ input: "Черновик B" }),
        { keepalive: false },
      ),
    );
    expect(saveLocalDraft).toHaveBeenLastCalledWith(
      api.settings,
      "created",
      expect.objectContaining({ input: "Черновик B" }),
      expect.any(Number),
    );
    expect(api.sendReliable).toHaveBeenCalledOnce();
    expect(api.updateThreadDraft).toHaveBeenCalledTimes(3);
  });

  it("retries an empty clear when a stale transfer clear fails without a newer draft", async () => {
    const creation = deferred<{ thread: ThreadSummary }>();
    const stalePut = deferred<ThreadDraft | null>();
    const clearPut = deferred<ThreadDraft | null>();
    const api = mockConnection(snapshot([baseThread]));
    let putCount = 0;
    api.createProjectThread.mockReturnValue(creation.promise);
    api.updateThreadDraft.mockImplementation(
      (_threadId: string, draft: UpdateThreadDraftRequest) => {
        putCount += 1;
        if (putCount === 1) return stalePut.promise;
        if (putCount === 2) return clearPut.promise;
        return Promise.resolve({ ...draft, updatedAt: Date.now() });
      },
    );

    renderApp("/threads/newer");
    fireEvent.click(screen.getByRole("button", { name: "Создать новую сессию в проекте Проект" }));
    const textarea = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "Сообщение для Codex",
    });
    fireEvent.change(textarea, { target: { value: "Черновик A" } });
    creation.resolve({ thread: { ...baseThread, id: "created", title: "Новая задача" } });

    await waitFor(() => expect(api.updateThreadDraft).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() => expect(api.sendReliable).toHaveBeenCalledOnce());
    stalePut.resolve({
      input: "Черновик A",
      images: [],
      goalMode: false,
      annotations: [],
      updatedAt: 1,
    });
    await waitFor(() => expect(api.updateThreadDraft).toHaveBeenCalledTimes(2));
    clearPut.reject(new Error("Clear failed"));

    await waitFor(() =>
      expect(api.updateThreadDraft).toHaveBeenLastCalledWith(
        "created",
        { input: "", images: [], goalMode: false, annotations: [] },
        { keepalive: false },
      ),
    );
    expect(saveLocalDraft).toHaveBeenLastCalledWith(
      api.settings,
      "created",
      { input: "", images: [], goalMode: false, annotations: [] },
      expect.any(Number),
    );
    expect(textarea).toHaveValue("");
    expect(api.sendReliable).toHaveBeenCalledOnce();
    expect(api.updateThreadDraft).toHaveBeenCalledTimes(3);
  });

  it("waits for an in-flight image read before sending an early submission", async () => {
    const creation = deferred<{ thread: ThreadSummary }>();
    const imageRead = deferred<string>();
    class PendingFileReader {
      result: string | ArrayBuffer | null = null;
      error: DOMException | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      readAsDataURL(): void {
        void imageRead.promise.then((result) => {
          this.result = result;
          this.onload?.();
        });
      }
    }
    vi.stubGlobal("FileReader", PendingFileReader);
    const api = mockConnection(snapshot([baseThread]));
    api.createProjectThread.mockReturnValue(creation.promise);

    const view = renderApp("/threads/newer");
    fireEvent.click(screen.getByRole("button", { name: "Создать новую сессию в проекте Проект" }));
    const textarea = await screen.findByRole("textbox", { name: "Сообщение для Codex" });
    await waitFor(() => expect(api.createProjectThread).toHaveBeenCalledOnce());
    fireEvent.change(textarea, { target: { value: "Проверь изображение" } });
    fireEvent.change(view.container.querySelector('input[type="file"]')!, {
      target: { files: [new File(["image"], "screen.png", { type: "image/png" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    creation.resolve({ thread: { ...baseThread, id: "created", title: "Новая задача" } });

    await waitFor(() => expect(api.createProjectThread).toHaveBeenCalledOnce());
    expect(api.sendReliable).not.toHaveBeenCalled();
    imageRead.resolve("data:image/png;base64,aW1hZ2U=");

    await waitFor(() =>
      expect(api.sendReliable).toHaveBeenCalledWith(
        "created",
        expect.objectContaining({
          input: "Проверь изображение",
          images: ["data:image/png;base64,aW1hZ2U="],
        }),
      ),
    );
  });

  it("merges concurrent delayed image reads into one early submission in selection order", async () => {
    const creation = deferred<{ thread: ThreadSummary }>();
    const reads = [deferred<string>(), deferred<string>()];
    let readIndex = 0;
    class PendingFileReader {
      result: string | ArrayBuffer | null = null;
      error: DOMException | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      readAsDataURL(): void {
        const read = reads[readIndex++]!;
        void read.promise.then((result) => {
          this.result = result;
          this.onload?.();
        });
      }
    }
    vi.stubGlobal("FileReader", PendingFileReader);
    const api = mockConnection(snapshot([baseThread]));
    api.createProjectThread.mockReturnValue(creation.promise);

    const view = renderApp("/threads/newer");
    fireEvent.click(screen.getByRole("button", { name: "Создать новую сессию в проекте Проект" }));
    const textarea = await screen.findByRole("textbox", { name: "Сообщение для Codex" });
    const fileInput = view.container.querySelector('input[type="file"]')!;
    await waitFor(() => expect(api.createProjectThread).toHaveBeenCalledOnce());
    fireEvent.change(textarea, { target: { value: "Проверь оба изображения" } });
    fireEvent.change(fileInput, {
      target: { files: [new File(["first"], "first.png", { type: "image/png" })] },
    });
    fireEvent.change(fileInput, {
      target: { files: [new File(["second"], "second.png", { type: "image/png" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    creation.resolve({ thread: { ...baseThread, id: "created", title: "Новая задача" } });

    reads[1]!.resolve("data:image/png;base64,c2Vjb25k");
    await act(async () => Promise.resolve());
    expect(api.sendReliable).not.toHaveBeenCalled();
    reads[0]!.resolve("data:image/png;base64,Zmlyc3Q=");

    await waitFor(() =>
      expect(api.sendReliable).toHaveBeenCalledWith(
        "created",
        expect.objectContaining({
          images: ["data:image/png;base64,Zmlyc3Q=", "data:image/png;base64,c2Vjb25k"],
        }),
      ),
    );
  });

  it("keeps a delayed next-draft image on the activated thread after early-submit success", async () => {
    const creation = deferred<{ thread: ThreadSummary }>();
    const delivery = deferred<"delivered">();
    const imageRead = deferred<string>();
    class PendingFileReader {
      result: string | ArrayBuffer | null = null;
      error: DOMException | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      readAsDataURL(): void {
        void imageRead.promise.then((result) => {
          this.result = result;
          this.onload?.();
        });
      }
    }
    vi.stubGlobal("FileReader", PendingFileReader);
    const api = mockConnection(snapshot([baseThread]));
    api.createProjectThread.mockReturnValue(creation.promise);
    api.sendReliable.mockReturnValue(delivery.promise);

    const view = renderApp("/threads/newer");
    fireEvent.click(screen.getByRole("button", { name: "Создать новую сессию в проекте Проект" }));
    const textarea = await screen.findByRole("textbox", { name: "Сообщение для Codex" });
    await waitFor(() => expect(api.createProjectThread).toHaveBeenCalledOnce());
    fireEvent.change(textarea, { target: { value: "Отправь сообщение" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    fireEvent.change(view.container.querySelector('input[type="file"]')!, {
      target: { files: [new File(["next"], "next.png", { type: "image/png" })] },
    });

    creation.resolve({ thread: { ...baseThread, id: "created", title: "Новая задача" } });
    await waitFor(() => expect(api.sendReliable).toHaveBeenCalledOnce());
    delivery.resolve("delivered");
    await act(async () => Promise.resolve());
    expect(api.updateThreadDraft).not.toHaveBeenCalledWith(
      "",
      expect.anything(),
      expect.anything(),
    );

    imageRead.resolve("data:image/png;base64,bmV4dA==");

    expect(await screen.findByAltText("next.png")).toBeInTheDocument();
    await waitFor(() =>
      expect(api.updateThreadDraft).toHaveBeenCalledWith(
        "created",
        expect.objectContaining({
          images: [
            expect.objectContaining({
              name: "next.png",
              url: "data:image/png;base64,bmV4dA==",
            }),
          ],
        }),
        { keepalive: false },
      ),
    );
    expect(api.updateThreadDraft.mock.calls.some(([id]) => id === "")).toBe(false);
  });

  it("keeps text and images added after early-submit success as the next draft", async () => {
    const creation = deferred<{ thread: ThreadSummary }>();
    const delivery = deferred<"delivered">();
    const api = mockConnection(snapshot([baseThread]));
    api.createProjectThread.mockReturnValue(creation.promise);
    api.sendReliable.mockReturnValue(delivery.promise);

    const view = renderApp("/threads/newer");
    fireEvent.click(screen.getByRole("button", { name: "Создать новую сессию в проекте Проект" }));
    const textarea = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "Сообщение для Codex",
    });
    await waitFor(() => expect(api.createProjectThread).toHaveBeenCalledOnce());
    fireEvent.change(textarea, { target: { value: "Черновик A" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    fireEvent.change(textarea, { target: { value: "Новый черновик B" } });
    fireEvent.change(view.container.querySelector('input[type="file"]')!, {
      target: { files: [new File(["new"], "new.png", { type: "image/png" })] },
    });
    expect(await screen.findByAltText("new.png")).toBeInTheDocument();

    creation.resolve({ thread: { ...baseThread, id: "created", title: "Новая задача" } });
    await waitFor(() => expect(api.sendReliable).toHaveBeenCalledOnce());
    expect(api.sendReliable.mock.calls[0]?.[1]).not.toHaveProperty("images");
    delivery.resolve("delivered");

    await waitFor(() => expect(textarea).toHaveValue("Новый черновик B"));
    expect(screen.getByAltText("new.png")).toBeInTheDocument();
    await waitFor(() =>
      expect(api.updateThreadDraft).toHaveBeenCalledWith(
        "created",
        expect.objectContaining({
          input: "Новый черновик B",
          images: [expect.objectContaining({ name: "new.png" })],
        }),
        { keepalive: false },
      ),
    );
  });

  it("merges the submitted draft with newer edits when early sending fails", async () => {
    const creation = deferred<{ thread: ThreadSummary }>();
    const delivery = deferred<"delivered">();
    const api = mockConnection(snapshot([baseThread]));
    api.createProjectThread.mockReturnValue(creation.promise);
    api.sendReliable.mockReturnValue(delivery.promise);

    renderApp("/threads/newer");
    fireEvent.click(screen.getByRole("button", { name: "Создать новую сессию в проекте Проект" }));
    const textarea = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "Сообщение для Codex",
    });
    await waitFor(() => expect(api.createProjectThread).toHaveBeenCalledOnce());
    fireEvent.change(textarea, { target: { value: "Черновик A" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    fireEvent.change(textarea, { target: { value: "Новый черновик B" } });
    creation.resolve({ thread: { ...baseThread, id: "created", title: "Новая задача" } });
    await waitFor(() => expect(api.sendReliable).toHaveBeenCalledOnce());
    delivery.reject(new Error("Отправка недоступна"));

    expect(await screen.findByText("Отправка недоступна")).toBeInTheDocument();
    expect(textarea).toHaveValue("Черновик A\n\nНовый черновик B");
  });

  it("keeps an early auto-send recording pending until the created thread activates", async () => {
    installMediaRecorder(async () => {
      return { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    });
    const creation = deferred<{ thread: ThreadSummary }>();
    const upload = deferred<void>();
    const appSnapshot = snapshot([baseThread]);
    const api = mockConnection(appSnapshot);
    api.createProjectThread.mockReturnValue(creation.promise);
    api.queueVoiceRecording.mockReturnValue(upload.promise);
    api.readTranscriptionConfig.mockResolvedValue({
      providers: ["local"],
      provider: "local",
      localUrl: "http://127.0.0.1:8178/inference",
      openAiApiKeyConfigured: false,
      openAiModel: "gpt-4o-transcribe",
      language: "ru",
      refineLocal: false,
      refinementModel: "gpt-5.6-luna",
      maxRecordingSeconds: 300,
      maxUploadBytes: 24 * 1024 * 1024,
      timingEstimate: {
        sampleCount: 0,
        estimatedFixedProcessingMs: null,
        estimatedProcessingMsPerAudioSecond: null,
      },
    });
    localStorage.setItem("codexnest.voiceInputMode", "send");

    renderApp("/threads/newer");
    fireEvent.click(screen.getByRole("button", { name: "Создать новую сессию в проекте Проект" }));
    await waitFor(() => expect(api.createProjectThread).toHaveBeenCalledOnce());
    fireEvent.click(await screen.findByRole("button", { name: "Начать запись" }));
    fireEvent.click(await screen.findByRole("button", { name: "Остановить запись" }));
    await act(async () => Promise.resolve());

    expect(api.transcribe).not.toHaveBeenCalled();
    expect(api.queueVoiceRecording).not.toHaveBeenCalled();
    expect(
      api.queueVoiceRecording.mock.calls.some(([recording]) => recording.threadId === ""),
    ).toBe(false);

    creation.resolve({ thread: { ...baseThread, id: "created", title: "Новая задача" } });

    await waitFor(() =>
      expect(api.queueVoiceRecording).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "created",
          audio: expect.any(Blob),
          mode: "send",
        }),
      ),
    );
    expect(api.queueVoiceRecording).toHaveBeenCalledOnce();
    expect(api.transcribe).not.toHaveBeenCalled();
    expect(
      api.queueVoiceRecording.mock.calls.some(([recording]) => recording.threadId === ""),
    ).toBe(false);
    expect(screen.getByRole("status", { name: "Отправляем запись" })).toHaveClass(
      "voice-transcription-message",
    );

    const recording = api.queueVoiceRecording.mock.calls[0]![0];
    appSnapshot.voiceTranscriptions = [
      {
        id: recording.id,
        threadId: recording.threadId,
        mode: "send",
        status: "transcribing",
        createdAt: Date.now(),
        startedAt: Date.now(),
        audioDurationMs: recording.durationMs,
        estimatedTotalSeconds: null,
        error: null,
      },
    ];
    upload.resolve();

    expect(await screen.findByRole("status", { name: "Распознаём" })).toHaveClass(
      "voice-transcription-message",
    );
  });

  it("queues a recording stopped after activation and shows its progress without reopening", async () => {
    installMediaRecorder(async () => {
      return { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    });
    const creation = deferred<{ thread: ThreadSummary }>();
    const upload = deferred<void>();
    const appSnapshot = snapshot([baseThread]);
    const api = mockConnection(appSnapshot);
    api.createProjectThread.mockReturnValue(creation.promise);
    api.queueVoiceRecording.mockReturnValue(upload.promise);
    api.readTranscriptionConfig.mockResolvedValue({
      providers: ["local"],
      provider: "local",
      localUrl: "http://127.0.0.1:8178/inference",
      openAiApiKeyConfigured: false,
      openAiModel: "gpt-4o-transcribe",
      language: "ru",
      refineLocal: false,
      refinementModel: "gpt-5.6-luna",
      maxRecordingSeconds: 300,
      maxUploadBytes: 24 * 1024 * 1024,
      timingEstimate: {
        sampleCount: 0,
        estimatedFixedProcessingMs: null,
        estimatedProcessingMsPerAudioSecond: null,
      },
    });
    localStorage.setItem("codexnest.voiceInputMode", "send");

    renderApp("/threads/newer");
    fireEvent.click(screen.getByRole("button", { name: "Создать новую сессию в проекте Проект" }));
    await waitFor(() => expect(api.createProjectThread).toHaveBeenCalledOnce());
    fireEvent.click(await screen.findByRole("button", { name: "Начать запись" }));
    await screen.findByRole("button", { name: "Остановить запись" });

    creation.resolve({ thread: { ...baseThread, id: "created", title: "Новая задача" } });
    await waitFor(() =>
      expect(api.dispatch).toHaveBeenCalledWith({
        type: "thread",
        thread: expect.objectContaining({ id: "created" }),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Остановить запись" }));

    await waitFor(() =>
      expect(api.queueVoiceRecording).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "created",
          audio: expect.any(Blob),
          mode: "send",
        }),
      ),
    );
    const uploading = screen.getByRole("status", { name: "Отправляем запись" });
    expect(uploading).toHaveClass("voice-transcription-message");
    expect(
      api.queueVoiceRecording.mock.calls.some(([recording]) => recording.threadId === ""),
    ).toBe(false);
    expect(api.updateThreadDraft.mock.calls.some(([id]) => id === "")).toBe(false);

    const recording = api.queueVoiceRecording.mock.calls[0]![0];
    appSnapshot.voiceTranscriptions = [
      {
        id: recording.id,
        threadId: recording.threadId,
        mode: "send",
        status: "transcribing",
        createdAt: Date.now(),
        startedAt: Date.now(),
        audioDurationMs: recording.durationMs,
        estimatedTotalSeconds: null,
        error: null,
      },
    ];
    upload.resolve();

    const transcribing = await screen.findByRole("status", { name: "Распознаём" });
    expect(transcribing).toHaveClass("voice-transcription-message");
  });

  it("restores an early draft after creation fails without replacing the editor", async () => {
    const creation = deferred<{ thread: ThreadSummary }>();
    const api = mockConnection(snapshot([baseThread]));
    api.createProjectThread.mockReturnValue(creation.promise);

    renderApp("/threads/newer");
    fireEvent.click(screen.getByRole("button", { name: "Создать новую сессию в проекте Проект" }));
    const textarea = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "Сообщение для Codex",
    });
    await waitFor(() => expect(api.createProjectThread).toHaveBeenCalledOnce());
    fireEvent.change(textarea, { target: { value: "Верни этот черновик" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    creation.reject(new Error("Создание недоступно"));

    expect(await screen.findByText("Создание недоступно")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).toBe(textarea);
    expect(textarea).toHaveValue("Верни этот черновик");
    expect(screen.getByRole("button", { name: "Повторить" })).toBeEnabled();
    expect(api.sendReliable).not.toHaveBeenCalled();
  });

  it("restores an early draft in the same editor when reliable sending fails", async () => {
    const creation = deferred<{ thread: ThreadSummary }>();
    const api = mockConnection(snapshot([baseThread]));
    api.createProjectThread.mockReturnValue(creation.promise);
    api.sendReliable.mockRejectedValue(new Error("Отправка недоступна"));

    renderApp("/threads/newer");
    fireEvent.click(screen.getByRole("button", { name: "Создать новую сессию в проекте Проект" }));
    const textarea = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "Сообщение для Codex",
    });
    await waitFor(() => expect(api.createProjectThread).toHaveBeenCalledOnce());
    fireEvent.change(textarea, { target: { value: "Не потеряй после отправки" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    creation.resolve({ thread: { ...baseThread, id: "created", title: "Новая задача" } });

    expect(await screen.findByText("Отправка недоступна")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).toBe(textarea);
    expect(textarea).toHaveValue("Не потеряй после отправки");
    expect(api.createProjectThread).toHaveBeenCalledOnce();
    expect(api.sendReliable).toHaveBeenCalledOnce();
  });

  it("opens global Codex settings and switches the saved server there", async () => {
    const api = mockConnection(snapshot([baseThread]));
    const onDisconnected = vi.fn();
    localStorage.setItem("codexnest.serverUrl", "https://pi.local");
    localStorage.setItem("codexnest.token", "secret");
    renderApp("/threads/newer", onDisconnected);

    fireEvent.click(screen.getByRole("link", { name: "Настройки" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Настройки" })).toBeInTheDocument();
    expect(api.readPermissionSettings).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("tab", { name: "Подключение" }));
    fireEvent.click(screen.getByRole("button", { name: "Сменить сервер" }));

    await waitFor(() => expect(onDisconnected).toHaveBeenCalledOnce());
    expect(localStorage.getItem("codexnest.serverUrl")).toBeNull();
    expect(localStorage.getItem("codexnest.token")).toBeNull();
  });

  it("tracks a mobile swipe and opens the session drawer after the threshold", () => {
    mockConnection(snapshot([baseThread]));
    mockMobileViewport();

    const view = renderApp("/threads/newer");
    const frame = view.container.querySelector(".app-frame") as HTMLDivElement;
    const sidebar = view.container.querySelector(".sidebar") as HTMLElement;
    vi.spyOn(sidebar, "getBoundingClientRect").mockReturnValue({
      ...sidebar.getBoundingClientRect(),
      width: 300,
    });
    const textarea = screen.getByRole("textbox", { name: "Сообщение для Codex" });
    textarea.focus();

    fireEvent.touchStart(frame, { touches: [{ clientX: 80, clientY: 200 }] });
    fireEvent.touchMove(frame, { touches: [{ clientX: 180, clientY: 204 }] });

    expect(textarea).not.toHaveFocus();
    expect(frame).toHaveClass("drawer-dragging");
    expect(frame.style.getPropertyValue("--drawer-drag-progress")).toBe(String(100 / 300));
    expect(view.container.querySelector(".drawer-backdrop")).not.toBeNull();

    fireEvent.touchEnd(frame, { touches: [] });

    expect(frame).not.toHaveClass("drawer-dragging");
    expect(sidebar).toHaveClass("open");
  });

  it("opens the session drawer from a swipe starting on a summary element", () => {
    mockConnection(snapshot([baseThread]));
    mockMobileViewport();

    const view = renderApp("/threads/newer");
    const frame = view.container.querySelector(".app-frame") as HTMLDivElement;
    const sidebar = view.container.querySelector(".sidebar") as HTMLElement;
    const summary = document.createElement("summary");
    frame.append(summary);
    vi.spyOn(sidebar, "getBoundingClientRect").mockReturnValue({
      ...sidebar.getBoundingClientRect(),
      width: 300,
    });

    fireEvent.touchStart(summary, { touches: [{ clientX: 80, clientY: 200 }] });
    fireEvent.touchMove(frame, { touches: [{ clientX: 180, clientY: 204 }] });

    expect(frame).toHaveClass("drawer-dragging");

    fireEvent.touchEnd(frame, { touches: [] });

    expect(frame).not.toHaveClass("drawer-dragging");
    expect(sidebar).toHaveClass("open");
  });

  it("does not treat a touch on the project drag handle as a drawer swipe", () => {
    mockConnection(snapshot([baseThread]));
    mockMobileViewport();

    const view = renderApp("/threads/newer");
    const frame = view.container.querySelector(".app-frame") as HTMLDivElement;
    const sidebar = view.container.querySelector(".sidebar") as HTMLElement;
    const handle = screen.getByTitle("Перетащить проект Проект");
    vi.spyOn(sidebar, "getBoundingClientRect").mockReturnValue({
      ...sidebar.getBoundingClientRect(),
      width: 300,
    });

    fireEvent.touchStart(handle, { touches: [{ clientX: 80, clientY: 200 }] });
    fireEvent.touchMove(frame, { touches: [{ clientX: 200, clientY: 204 }] });
    fireEvent.touchEnd(frame, { touches: [] });

    expect(frame).not.toHaveClass("drawer-dragging");
    expect(sidebar).not.toHaveClass("open");
  });

  it("does not treat horizontal table scrolling as a drawer swipe", () => {
    mockConnection(snapshot([baseThread]));
    mockMobileViewport();

    const view = renderApp("/threads/newer");
    const frame = view.container.querySelector(".app-frame") as HTMLDivElement;
    const sidebar = view.container.querySelector(".sidebar") as HTMLElement;
    const tableScroll = document.createElement("div");
    tableScroll.className = "markdown-table-scroll";
    frame.append(tableScroll);

    fireEvent.touchStart(tableScroll, { touches: [{ clientX: 80, clientY: 200 }] });
    fireEvent.touchMove(frame, { touches: [{ clientX: 200, clientY: 204 }] });
    fireEvent.touchEnd(frame, { touches: [] });

    expect(frame).not.toHaveClass("drawer-dragging");
    expect(sidebar).not.toHaveClass("open");
  });

  it("switches sessions after touch drift on a mobile drawer link", async () => {
    const other = { ...baseThread, id: "other", title: "Другая задача", updatedAt: 10 };
    const running = { ...baseThread, state: "running" as const, currentTurnId: "turn" };
    mockConnection(snapshot([running, other]));
    mockMobileViewport();

    const view = renderApp("/threads/newer");
    const frame = view.container.querySelector(".app-frame") as HTMLDivElement;
    const sidebar = view.container.querySelector(".sidebar") as HTMLElement;
    const context = connection.mock.results.at(-1)?.value;
    context.forceRefreshDetail.mockRejectedValueOnce(new Error("Ошибка старой сессии"));

    fireEvent.click(screen.getByRole("button", { name: "Принудительно обновить сессию" }));
    expect(await screen.findByText("Ошибка старой сессии")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Открыть список задач" }));

    const otherLink = screen.getByRole("link", { name: "Другая задача" });
    fireEvent.touchStart(otherLink, { touches: [{ clientX: 220, clientY: 200 }] });
    const touchContinued = fireEvent.touchMove(frame, {
      touches: [{ clientX: 205, clientY: 202 }],
    });
    fireEvent.touchEnd(frame, { touches: [] });

    expect(touchContinued).toBe(true);
    expect(frame).not.toHaveClass("drawer-dragging");
    expect(sidebar).toHaveClass("open");

    otherLink.addEventListener("click", (event) => event.preventDefault(), { once: true });
    fireEvent.click(otherLink);

    expect(screen.getByRole("heading", { level: 1, name: "Новая задача в истории" })).toBeVisible();
    expect(screen.getByText("Ошибка старой сессии")).toBeInTheDocument();
    expect(sidebar).toHaveClass("open");
    expect(manualNavigationIntent).toHaveBeenCalledOnce();

    fireEvent.click(otherLink);

    expect(await screen.findByRole("heading", { level: 1, name: "Другая задача" })).toBeVisible();
    expect(screen.queryByText("Ошибка старой сессии")).not.toBeInTheDocument();
    expect(sidebar).not.toHaveClass("open");
    expect(manualNavigationIntent).toHaveBeenCalledTimes(2);
    expect(view.container.querySelectorAll(".thread-link.active")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Другая задача" })).toHaveClass("active");
  });

  it("tracks a reverse swipe and closes the open session drawer after the threshold", () => {
    mockConnection(snapshot([baseThread]));
    mockMobileViewport();

    const view = renderApp("/threads/newer");
    const frame = view.container.querySelector(".app-frame") as HTMLDivElement;
    const sidebar = view.container.querySelector(".sidebar") as HTMLElement;
    vi.spyOn(sidebar, "getBoundingClientRect").mockReturnValue({
      ...sidebar.getBoundingClientRect(),
      width: 300,
    });
    const textarea = screen.getByRole("textbox", { name: "Сообщение для Codex" });
    textarea.focus();
    fireEvent.click(screen.getByRole("button", { name: "Открыть список задач" }));

    expect(textarea).not.toHaveFocus();
    fireEvent.touchStart(frame, { touches: [{ clientX: 220, clientY: 200 }] });
    fireEvent.touchMove(frame, { touches: [{ clientX: 120, clientY: 204 }] });

    expect(frame).toHaveClass("drawer-dragging");
    expect(frame.style.getPropertyValue("--drawer-drag-progress")).toBe(String(1 - 100 / 300));

    fireEvent.touchEnd(frame, { touches: [] });

    expect(frame).not.toHaveClass("drawer-dragging");
    expect(sidebar).not.toHaveClass("open");
  });

  it("mirrors mobile drawer gestures when the sidebar is on the right", () => {
    localStorage.setItem("codexnest.layoutDefaultsVersion", "1");
    localStorage.setItem("codexnest.sidebarSide", "right");
    mockConnection(snapshot([baseThread]));
    mockMobileViewport();

    const view = renderApp("/threads/newer");
    const frame = view.container.querySelector(".app-frame") as HTMLDivElement;
    const sidebar = view.container.querySelector(".sidebar") as HTMLElement;
    vi.spyOn(sidebar, "getBoundingClientRect").mockReturnValue({
      ...sidebar.getBoundingClientRect(),
      width: 300,
    });

    fireEvent.touchStart(frame, { touches: [{ clientX: 220, clientY: 200 }] });
    fireEvent.touchMove(frame, { touches: [{ clientX: 120, clientY: 204 }] });
    expect(frame).toHaveClass("drawer-dragging");
    expect(
      Number.parseFloat(frame.style.getPropertyValue("--drawer-drag-translate")),
    ).toBeGreaterThan(0);
    fireEvent.touchEnd(frame, { touches: [] });
    expect(sidebar).toHaveClass("open");

    fireEvent.touchStart(frame, { touches: [{ clientX: 100, clientY: 200 }] });
    fireEvent.touchMove(frame, { touches: [{ clientX: 200, clientY: 204 }] });
    fireEvent.touchEnd(frame, { touches: [] });
    expect(sidebar).not.toHaveClass("open");
  });

  it("keeps the drawer open after a short reverse swipe", () => {
    mockConnection(snapshot([baseThread]));
    mockMobileViewport();

    const view = renderApp("/threads/newer");
    const frame = view.container.querySelector(".app-frame") as HTMLDivElement;
    const sidebar = view.container.querySelector(".sidebar") as HTMLElement;
    vi.spyOn(sidebar, "getBoundingClientRect").mockReturnValue({
      ...sidebar.getBoundingClientRect(),
      width: 300,
    });
    fireEvent.click(screen.getByRole("button", { name: "Открыть список задач" }));

    fireEvent.touchStart(frame, { touches: [{ clientX: 220, clientY: 200 }] });
    fireEvent.touchMove(frame, { touches: [{ clientX: 150, clientY: 202 }] });
    fireEvent.touchEnd(frame, { touches: [] });

    expect(sidebar).toHaveClass("open");
  });

  it("rejects short, vertical, leftward and multitouch drawer gestures", () => {
    mockConnection(snapshot([baseThread]));
    mockMobileViewport();

    const view = renderApp("/threads/newer");
    const frame = view.container.querySelector(".app-frame") as HTMLDivElement;
    const sidebar = view.container.querySelector(".sidebar") as HTMLElement;
    vi.spyOn(sidebar, "getBoundingClientRect").mockReturnValue({
      ...sidebar.getBoundingClientRect(),
      width: 300,
    });

    fireEvent.touchStart(frame, { touches: [{ clientX: 80, clientY: 200 }] });
    fireEvent.touchMove(frame, { touches: [{ clientX: 150, clientY: 202 }] });
    expect(frame).toHaveClass("drawer-dragging");
    fireEvent.touchEnd(frame, { touches: [] });
    expect(sidebar).not.toHaveClass("open");

    fireEvent.touchStart(frame, { touches: [{ clientX: 80, clientY: 200 }] });
    fireEvent.touchMove(frame, { touches: [{ clientX: 95, clientY: 250 }] });
    expect(frame).not.toHaveClass("drawer-dragging");

    fireEvent.touchStart(frame, { touches: [{ clientX: 80, clientY: 200 }] });
    fireEvent.touchMove(frame, { touches: [{ clientX: 40, clientY: 202 }] });
    expect(frame).not.toHaveClass("drawer-dragging");

    fireEvent.touchStart(frame, { touches: [{ clientX: 80, clientY: 200 }] });
    fireEvent.touchStart(frame, {
      touches: [
        { clientX: 80, clientY: 200 },
        { clientX: 100, clientY: 220 },
      ],
    });
    fireEvent.touchMove(frame, { touches: [{ clientX: 200, clientY: 202 }] });
    expect(frame).not.toHaveClass("drawer-dragging");
    expect(sidebar).not.toHaveClass("open");
  });

  it("resets a drawer gesture on touch cancellation and ignores it on desktop", () => {
    mockConnection(snapshot([baseThread]));
    mockMobileViewport();

    const view = renderApp("/threads/newer");
    const frame = view.container.querySelector(".app-frame") as HTMLDivElement;
    const sidebar = view.container.querySelector(".sidebar") as HTMLElement;
    vi.spyOn(sidebar, "getBoundingClientRect").mockReturnValue({
      ...sidebar.getBoundingClientRect(),
      width: 300,
    });

    fireEvent.touchStart(frame, { touches: [{ clientX: 80, clientY: 200 }] });
    fireEvent.touchMove(frame, { touches: [{ clientX: 180, clientY: 202 }] });
    fireEvent.touchCancel(frame);

    expect(frame).not.toHaveClass("drawer-dragging");
    expect(sidebar).not.toHaveClass("open");

    view.unmount();
    vi.mocked(window.matchMedia).mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList);
    const desktopView = renderApp("/threads/newer");
    const desktopFrame = desktopView.container.querySelector(".app-frame") as HTMLDivElement;
    const desktopSidebar = desktopView.container.querySelector(".sidebar") as HTMLElement;
    fireEvent.touchStart(desktopFrame, { touches: [{ clientX: 80, clientY: 200 }] });
    fireEvent.touchMove(desktopFrame, { touches: [{ clientX: 200, clientY: 202 }] });
    fireEvent.touchEnd(desktopFrame, { touches: [] });

    expect(desktopFrame).not.toHaveClass("drawer-dragging");
    expect(desktopSidebar).not.toHaveClass("open");
  });

  it("opens and closes the session drawer with Android Back", async () => {
    capacitor.getPlatform.mockReturnValue("android");
    mockConnection(snapshot([baseThread]));
    mockMobileViewport();

    const view = renderApp("/threads/newer");
    const sidebar = view.container.querySelector(".sidebar") as HTMLElement;
    await waitFor(() => expect(capacitor.addListener).toHaveBeenCalledOnce());
    const textarea = screen.getByRole("textbox", { name: "Сообщение для Codex" });
    textarea.focus();

    act(() => capacitor.backHandler?.());
    expect(textarea).not.toHaveFocus();
    expect(sidebar).toHaveClass("open");

    await waitFor(() => expect(capacitor.addListener).toHaveBeenCalledTimes(2));
    act(() => capacitor.backHandler?.());
    expect(sidebar).not.toHaveClass("open");
  });

  it("leaves Android Back to an open viewer layer before toggling the drawer", async () => {
    capacitor.getPlatform.mockReturnValue("android");
    mockConnection(snapshot([baseThread]));
    mockMobileViewport();

    const view = renderApp("/threads/newer");
    const sidebar = view.container.querySelector(".sidebar") as HTMLElement;
    await waitFor(() => expect(capacitor.addListener).toHaveBeenCalledOnce());
    const layer = document.createElement("div");
    layer.dataset.androidBackLayer = "";
    document.body.append(layer);

    act(() => capacitor.backHandler?.());

    expect(sidebar).not.toHaveClass("open");
    layer.remove();
  });

  it("leaves Android Back to Capacitor outside a session", async () => {
    capacitor.getPlatform.mockReturnValue("android");
    mockConnection(snapshot([baseThread]));
    mockMobileViewport();

    renderApp("/settings");
    await act(async () => Promise.resolve());

    expect(capacitor.addListener).not.toHaveBeenCalled();
  });
});

function renderApp(path: string, onDisconnected = () => undefined, baseUrl = "https://pi.local") {
  return render(
    <MemoryRouter initialEntries={[path]} useTransitions={false}>
      <App settings={{ baseUrl, token: "secret" }} onDisconnected={onDisconnected} />
    </MemoryRouter>,
  );
}

function statusFor(title: string): Element {
  const status = screen.getByRole("link", { name: title }).querySelector(".status");
  if (!status) throw new Error(`Missing status for ${title}`);
  return status;
}

function mockMobileViewport() {
  vi.mocked(window.matchMedia).mockReturnValue({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaQueryList);
}

function fireProjectPointer(
  target: Element,
  type: "pointercancel" | "pointerdown" | "pointermove" | "pointerup",
  {
    clientX,
    clientY,
    pointerId,
    pointerType = "mouse",
  }: {
    clientX: number;
    clientY: number;
    pointerId: number;
    pointerType?: "mouse" | "touch";
  },
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    button: 0,
    cancelable: true,
    clientX,
    clientY,
  });
  Object.defineProperties(event, {
    isPrimary: { value: true },
    pointerId: { value: pointerId },
    pointerType: { value: pointerType },
  });
  fireEvent(target, event);
}

function setProjectDragBounds(
  container: HTMLElement,
  projectTops: number[],
  navigationBounds: { top: number; height: number } = { top: 0, height: 400 },
) {
  const projectTitles = Array.from(container.querySelectorAll<HTMLElement>(".project-title"));
  if (projectTitles.length !== projectTops.length) {
    throw new Error("Project drag test bounds do not match the rendered project count");
  }
  projectTitles.forEach((title, index) => {
    vi.spyOn(title, "getBoundingClientRect").mockReturnValue(testBounds(projectTops[index]!, 31));
  });
  const navigation = container.querySelector(".thread-nav") as HTMLElement;
  vi.spyOn(navigation, "getBoundingClientRect").mockReturnValue(
    testBounds(navigationBounds.top, navigationBounds.height),
  );
}

function testBounds(top: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left: 0,
    right: 300,
    top,
    width: 300,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

function testProject(id: string, displayName: string): Project {
  return {
    id,
    displayName,
    path: `/work/${id}`,
    createdAt: "2026-01-02",
    updatedAt: "2026-01-02",
  };
}

function defaultProject(): Project {
  return {
    id: "project",
    displayName: "Проект",
    path: "/work/project",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  };
}

function snapshot(threads: ThreadSummary[], projects: Project[] = [defaultProject()]): AppSnapshot {
  return {
    sequence: 1,
    uiLanguage: "ru",
    connection: { state: "ready", message: null, syncedAt: "2026-08-03T00:00:00.000Z" },
    projects,
    threads,
    attention: [],
    models: [],
  };
}

function mockConnection(
  appSnapshot: AppSnapshot,
  network: "connecting" | "connected" | "offline" = "connected",
) {
  const api = {
    settings: { baseUrl: "https://codexnest.example", token: "token" },
    markRead: vi.fn().mockResolvedValue(undefined),
    markViewed: vi.fn().mockResolvedValue(undefined),
    updateThread: vi.fn().mockResolvedValue(undefined),
    archive: vi.fn().mockResolvedValue(undefined),
    startTurn: vi.fn().mockResolvedValue({ turnId: "turn" }),
    interrupt: vi.fn().mockResolvedValue(undefined),
    createProjectThread: vi.fn(),
    updateThreadDraft: vi.fn().mockImplementation(async (_id, draft) => ({
      ...draft,
      updatedAt: Date.now(),
    })),
    updateThreadSettings: vi.fn().mockImplementation(async (id, patch) => ({
      ...baseThread,
      id,
      settings: { ...baseThread.settings, ...patch },
    })),
    transcribe: vi.fn(),
    deleteProject: vi.fn(),
    moveProject: vi.fn(),
    dispatch: vi.fn(),
    readTranscriptionConfig: vi.fn().mockResolvedValue({
      providers: [],
      provider: null,
      localUrl: null,
      openAiApiKeyConfigured: false,
      openAiModel: "gpt-4o-transcribe",
      language: "ru",
      refineLocal: true,
      refinementModel: "gpt-5.6-luna",
      maxRecordingSeconds: 300,
      maxUploadBytes: 24 * 1024 * 1024,
    }),
    updateTranscriptionSettings: vi.fn(),
    readCodexRateLimits: vi.fn(),
    readAppSettings: vi.fn().mockResolvedValue(appUpdateStatus()),
    checkAppUpdate: vi.fn().mockResolvedValue(appUpdateStatus()),
    updateApp: vi.fn().mockResolvedValue(appUpdateStatus()),
    readCodexSettings: vi.fn().mockResolvedValue({
      supported: true,
      unavailableReason: null,
      operation: "idle",
      activeTurnCount: 0,
      daemonStatus: "running",
      cliVersion: "0.144.6",
      appServerVersion: "0.144.6",
      latestVersion: null,
      updateAvailable: null,
      networkStatus: "unknown",
      networkMessage: null,
      proxy: {
        configured: true,
        protocol: "http",
        host: "proxy.example",
        port: 8000,
        username: "user",
        hasPassword: true,
        error: null,
      },
    }),
    checkCodex: vi.fn(),
    updateCodexProxy: vi.fn(),
    updateCodex: vi.fn(),
    restartCodex: vi.fn(),
    readPermissionSettings: vi.fn().mockResolvedValue({
      preset: "auto",
      version: "version-1",
      overridden: false,
      message: null,
    }),
    updatePermissionSettings: vi.fn(),
    sendReliable: vi.fn().mockResolvedValue("delivered"),
    queueVoiceRecording: vi.fn().mockResolvedValue(undefined),
  };
  connection.mockReturnValue({
    api,
    appActive: true,
    foregroundEpoch: 0,
    state: {
      snapshot: appSnapshot,
      details: Object.fromEntries(
        appSnapshot.threads.map((thread) => [
          thread.id,
          { summary: thread, turns: [], queuedMessages: [], olderTurnsCursor: null },
        ]),
      ),
      network,
      error: null,
      snapshotEpoch: 1,
    },
    dispatch: api.dispatch,
    reconnect: vi.fn(),
    refreshDetail: vi.fn().mockImplementation(async (id: string) => ({
      summary: appSnapshot.threads.find((thread) => thread.id === id),
      turns: [],
      queuedMessages: [],
      olderTurnsCursor: null,
    })),
    forceRefreshDetail: vi.fn(),
    loadOlderDetail: vi.fn(),
    sendReliable: api.sendReliable,
    queueVoiceRecording: api.queueVoiceRecording,
  });
  return api;
}

function appUpdateStatus(overrides: Partial<AppUpdateStatus> = {}): AppUpdateStatus {
  return {
    supported: true,
    canUpdateWithActiveTurns: false,
    currentVersion: "0.1.4",
    latestVersion: "0.1.4",
    updateAvailable: false,
    operation: "idle",
    result: "none",
    message: null,
    checkedAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function installMediaRecorder(getUserMedia: () => Promise<MediaStream>) {
  class FakeMediaRecorder extends EventTarget {
    static isTypeSupported = vi.fn(() => true);
    readonly mimeType: string;
    state: RecordingState = "inactive";

    constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
      super();
      this.mimeType = options?.mimeType ?? "audio/webm";
    }

    start() {
      this.state = "recording";
    }

    stop() {
      if (this.state === "inactive") return;
      this.state = "inactive";
      const data = new Blob(["audio"], { type: this.mimeType });
      const dataEvent = new Event("dataavailable") as BlobEvent;
      Object.defineProperty(dataEvent, "data", { value: data });
      this.dispatchEvent(dataEvent);
      this.dispatchEvent(new Event("stop"));
    }
  }

  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(getUserMedia) },
  });
}
