import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";

import type { AppSnapshot, AppUpdateStatus, Project, ThreadSummary } from "@codexnest/protocol";

import { App } from "./App";
import { I18nProvider } from "./i18n";

const connection = vi.hoisted(() => vi.fn());
const capacitor = vi.hoisted(() => ({
  addListener: vi.fn(),
  backHandler: null as (() => void) | null,
  getInfo: vi.fn(),
  getPlatform: vi.fn(() => "web"),
  isNativePlatform: vi.fn(() => false),
  removeListener: vi.fn(),
}));

vi.mock("./connection", () => ({ useConnection: connection }));
vi.mock("./push", () => ({
  acknowledgePendingThread: vi.fn().mockResolvedValue(undefined),
  stopPushNotifications: vi.fn().mockResolvedValue(undefined),
  usePushNotifications: vi.fn(),
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
  capacitor.addListener.mockImplementation(async (_event: string, listener: () => void) => {
    capacitor.backHandler = listener;
    return { remove: capacitor.removeListener };
  });
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

    expect(screen.getByRole("dialog", { name: "Разрешить уведомления?" })).toBeInTheDocument();
    expect(requestPermission).not.toHaveBeenCalled();
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

  it("shows project-only session creation when only archived tasks exist", async () => {
    mockConnection(snapshot([{ ...baseThread, archived: true }]));

    renderApp("/");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Нет открытых сессий" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Создайте сессию в проекте")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Сообщение для Codex" })).not.toBeInTheDocument();
  });

  it("opens the new-session editor from /new", async () => {
    mockConnection(snapshot([]));

    renderApp("/new");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Новая задача" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Проект" })).toHaveValue("project");
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

  it("orders the fixed controls above the project list", () => {
    mockConnection(snapshot([baseThread]));

    const view = renderApp("/threads/newer");
    const controls = view.container.querySelector(".sidebar-controls");

    expect(controls).not.toBeNull();
    expect(Array.from(controls!.children).map((element) => element.textContent?.trim())).toEqual([
      "Подключено",
      "Настройки",
      "Лимиты Codex",
      "Добавить проект",
    ]);
    expect(controls?.nextElementSibling).toHaveClass("thread-nav");
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

    fireEvent.click(indicator);
    expect(await screen.findByRole("heading", { level: 1, name: "Настройки" })).toBeInTheDocument();
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
    expect(statusFor("Ответ просмотрен")).not.toHaveClass("status-unseen");
    expect(statusFor("Новый результат")).toHaveClass("status-completed-unread", "status-unseen");
    expect(statusFor("Ошибка")).toHaveClass("status-failed", "status-unseen");
    expect(statusFor("Прервана")).toHaveClass("status-interrupted", "status-unseen");
    expect(statusFor("Прерывание прочитано")).toHaveClass("status-interrupted-read");
    expect(statusFor("Выполняется")).toHaveClass("status-running");
    expect(statusFor("Нужно внимание")).toHaveClass("status-needsAttention");
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

    fireEvent.change(theme, { target: { value: "light" } });
    await waitFor(() => expect(localStorage.getItem("codexnest.theme")).toBe("light"));
    expect(document.documentElement.dataset.theme).toBe("light");
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

  it("restores project tree state and resets branch history", () => {
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
    expect(restoredProjectSessions.querySelectorAll(":scope > .thread-branch")).toHaveLength(6);
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

  it("migrates legacy fully expanded project state", async () => {
    const storageKey = "codexnest.sidebarTree.v1:https%3A%2F%2Fpi.local";
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 1,
        collapsedProjectIds: [],
        expandedProjectListIds: ["project"],
        openBranchIds: [],
        expandedBranchListIds: [],
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
    expect(view.container.querySelectorAll(".project-sessions > .thread-branch")).toHaveLength(6);
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(storageKey) ?? "{}")).toEqual({
        version: 1,
        collapsedProjectIds: [],
        projectListExpansions: [["project", "all"]],
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
        projectListExpansions: [],
      }),
    );
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

    renderApp("/threads/newer");
    fireEvent.click(screen.getByRole("button", { name: "Создать новую сессию в проекте Второй" }));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Новая задача" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Проект" })).toHaveValue("second");
    expect(api.createProjectThread).not.toHaveBeenCalled();
    expect(api.createThread).not.toHaveBeenCalled();
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
    <MemoryRouter initialEntries={[path]}>
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
    connection: { state: "ready", message: null, syncedAt: null },
    projects,
    threads,
    attention: [],
    models: [],
    pushConfigured: false,
  };
}

function mockConnection(
  appSnapshot: AppSnapshot,
  network: "connecting" | "connected" | "offline" = "connected",
) {
  const api = {
    settings: { baseUrl: "https://codexnest.example", token: "token" },
    markRead: vi.fn().mockResolvedValue(undefined),
    updateThread: vi.fn().mockResolvedValue(undefined),
    archive: vi.fn().mockResolvedValue(undefined),
    startTurn: vi.fn().mockResolvedValue({ turnId: "turn" }),
    steer: vi.fn().mockResolvedValue({ turnId: "turn" }),
    interrupt: vi.fn().mockResolvedValue(undefined),
    createThread: vi.fn(),
    createProjectThread: vi.fn(),
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
  };
  connection.mockReturnValue({
    api,
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
