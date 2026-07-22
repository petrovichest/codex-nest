import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

import type { AppSnapshot, Project, ThreadSummary } from "@codexnest/protocol";

import { App } from "./App";

const connection = vi.hoisted(() => vi.fn());
const capacitor = vi.hoisted(() => ({
  addListener: vi.fn(),
  backHandler: null as (() => void) | null,
  getPlatform: vi.fn(() => "web"),
  isNativePlatform: vi.fn(() => false),
  removeListener: vi.fn(),
}));

vi.mock("./connection", () => ({ useConnection: connection }));
vi.mock("./push", () => ({
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
  App: { addListener: capacitor.addListener },
}));

const baseThread: ThreadSummary = {
  id: "newer",
  projectId: "project",
  title: "Новая задача в истории",
  preview: "",
  cwd: "/work/project",
  state: "idle",
  unread: false,
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

  it("opens the empty chat when only archived tasks exist", async () => {
    mockConnection(snapshot([{ ...baseThread, archived: true }]));

    renderApp("/");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Новая задача" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Что поручим Codex?")).toBeInTheDocument();
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

  it("loads and refreshes both Codex limits only when clicked", async () => {
    const api = mockConnection(snapshot([baseThread]));
    api.readCodexRateLimits
      .mockResolvedValueOnce({
        primary: { usedPercent: 20.4, windowDurationMins: 300 },
        secondary: { usedPercent: 38.2, windowDurationMins: 10_080 },
      })
      .mockResolvedValueOnce({
        primary: { usedPercent: 100.5, windowDurationMins: 300 },
        secondary: null,
      });

    renderApp("/threads/newer");
    expect(api.readCodexRateLimits).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Показать лимиты Codex" }));
    expect(await screen.findByText("5 ч 80% · 7 д 62%")).toBeInTheDocument();
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

  it("uses one status indicator and dims acknowledged interruptions", () => {
    const threads: ThreadSummary[] = [
      { ...baseThread, id: "completed-read", title: "Прочитана", state: "completed" },
      {
        ...baseThread,
        id: "completed-unread",
        title: "Новый результат",
        state: "completed",
        unread: true,
      },
      { ...baseThread, id: "failed", title: "Ошибка", state: "failed", unread: true },
      {
        ...baseThread,
        id: "interrupted-unread",
        title: "Прервана",
        state: "interrupted",
        unread: true,
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
    expect(statusFor("Новый результат")).toHaveClass("status-completed-unread");
    expect(statusFor("Ошибка")).toHaveClass("status-failed");
    expect(statusFor("Прервана")).toHaveClass("status-interrupted");
    expect(statusFor("Прерывание прочитано")).toHaveClass("status-interrupted-read");
    expect(statusFor("Выполняется")).toHaveClass("status-running");
    expect(statusFor("Нужно внимание")).toHaveClass("status-needsAttention");
    expect(container.querySelectorAll(".thread-link .status")).toHaveLength(7);
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

  it("restores and persists the sidebar side from the settings page", async () => {
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

  it("restores and persists the speech transcription provider", async () => {
    localStorage.setItem("codexnest.transcriptionProvider", "openai");
    const api = mockConnection(snapshot([baseThread]));
    api.readTranscriptionConfig.mockResolvedValue({
      providers: ["local", "openai"],
      maxRecordingSeconds: 300,
      maxUploadBytes: 24 * 1024 * 1024,
    });

    renderApp("/settings");
    const provider = await screen.findByRole("combobox", {
      name: "Провайдер распознавания речи",
    });
    expect(provider).toHaveValue("openai");

    fireEvent.change(provider, { target: { value: "local" } });
    await waitFor(() =>
      expect(localStorage.getItem("codexnest.transcriptionProvider")).toBe("local"),
    );
    expect(api.readTranscriptionConfig).toHaveBeenCalledOnce();
  });

  it("restores the project flow and scrolls to the bottom when bottom-up is selected", async () => {
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

  it("reverses only project order while sessions still expand top-down", () => {
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

  it("collapses project sessions without toggling from project actions", () => {
    const api = mockConnection(snapshot([baseThread]));
    api.createProjectThread.mockImplementation(() => new Promise(() => undefined));

    renderApp("/threads/newer");
    const toggle = screen.getByRole("button", { name: "Проект" });
    const projectTitle = toggle.closest(".project-title") as HTMLElement;
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(projectTitle.children[1]).toHaveClass("project-action-menu");
    expect(projectTitle.children[2]).toHaveAccessibleName("Создать новую сессию в проекте Проект");

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
    const moveUp = within(projectGroup!).getByRole("button", { name: "Переместить выше" });
    expect(moveUp).toBeEnabled();
    expect(within(projectGroup!).getByRole("button", { name: "Переместить ниже" })).toBeDisabled();
    fireEvent.click(moveUp);

    await waitFor(() =>
      expect(api.moveProject).toHaveBeenCalledWith("project", { direction: "down" }),
    );
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
    fireEvent.click(within(projectGroup).getByRole("button", { name: "Переместить выше" }));

    expect(await within(projectGroup).findByRole("alert")).toHaveTextContent("Сервер недоступен");
  });
  it("creates an empty session from a project and opens it", async () => {
    const created = {
      ...baseThread,
      id: "created",
      title: "Без названия",
      updatedAt: 30,
      settings: { collaborationMode: "default" as const },
    };
    const api = mockConnection(snapshot([baseThread, created]));
    api.createProjectThread.mockResolvedValue({ thread: created });

    renderApp("/threads/newer");
    fireEvent.click(screen.getByRole("button", { name: "Создать новую сессию в проекте Проект" }));

    await waitFor(() => expect(api.createProjectThread).toHaveBeenCalledWith("project"));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Без названия" }),
    ).toBeInTheDocument();
  });

  it("shows a project-scoped error when session creation fails", async () => {
    const api = mockConnection(snapshot([baseThread]));
    api.createProjectThread.mockRejectedValue(new Error("Codex недоступен"));

    renderApp("/threads/newer");
    fireEvent.click(screen.getByRole("button", { name: "Создать новую сессию в проекте Проект" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Codex недоступен");
    expect(
      screen.getByRole("heading", { level: 1, name: "Новая задача в истории" }),
    ).toBeInTheDocument();
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

    fireEvent.touchStart(frame, { touches: [{ clientX: 80, clientY: 200 }] });
    fireEvent.touchMove(frame, { touches: [{ clientX: 180, clientY: 204 }] });

    expect(frame).toHaveClass("drawer-dragging");
    expect(frame.style.getPropertyValue("--drawer-drag-progress")).toBe(String(100 / 300));
    expect(view.container.querySelector(".drawer-backdrop")).not.toBeNull();

    fireEvent.touchEnd(frame, { touches: [] });

    expect(frame).not.toHaveClass("drawer-dragging");
    expect(sidebar).toHaveClass("open");
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
    fireEvent.click(screen.getByRole("button", { name: "Открыть список задач" }));

    fireEvent.touchStart(frame, { touches: [{ clientX: 220, clientY: 200 }] });
    fireEvent.touchMove(frame, { touches: [{ clientX: 120, clientY: 204 }] });

    expect(frame).toHaveClass("drawer-dragging");
    expect(frame.style.getPropertyValue("--drawer-drag-progress")).toBe(String(1 - 100 / 300));

    fireEvent.touchEnd(frame, { touches: [] });

    expect(frame).not.toHaveClass("drawer-dragging");
    expect(sidebar).not.toHaveClass("open");
  });

  it("mirrors mobile drawer gestures when the sidebar is on the right", () => {
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

    act(() => capacitor.backHandler?.());
    expect(sidebar).toHaveClass("open");

    await waitFor(() => expect(capacitor.addListener).toHaveBeenCalledTimes(2));
    act(() => capacitor.backHandler?.());
    expect(sidebar).not.toHaveClass("open");
  });

  it("leaves Android Back to Capacitor outside a session", async () => {
    capacitor.getPlatform.mockReturnValue("android");
    mockConnection(snapshot([baseThread]));
    mockMobileViewport();

    renderApp("/new");
    await act(async () => Promise.resolve());

    expect(capacitor.addListener).not.toHaveBeenCalled();
  });
});

function renderApp(path: string, onDisconnected = () => undefined) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App
        settings={{ baseUrl: "https://pi.local", token: "secret" }}
        onDisconnected={onDisconnected}
      />
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
    moveProject: vi.fn(),
    readTranscriptionConfig: vi.fn().mockResolvedValue({
      providers: [],
      maxRecordingSeconds: 300,
      maxUploadBytes: 24 * 1024 * 1024,
    }),
    readCodexRateLimits: vi.fn(),
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
