import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import type { AttentionRequest, ThreadSummary, TurnProgress } from "@codexnest/protocol";

import type { OptimisticMessage } from "../state";
import { Activity, ThreadPage, TurnTiming, formatMessageTime } from "./ThreadPage";

const connection = vi.hoisted(() => vi.fn());
const openDownloadUrl = vi.hoisted(() => vi.fn());

vi.mock("../connection", () => ({ useConnection: connection }));
vi.mock("../downloads", () => ({ openDownloadUrl }));

const summary: ThreadSummary = {
  id: "thread",
  projectId: "project",
  title: "Тестовая задача",
  preview: "",
  cwd: "/work/project",
  state: "idle",
  unread: false,
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  currentTurnId: null,
  queuedMessageCount: 0,
  settings: { collaborationMode: "default" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
});

describe("Activity", () => {
  it("renders user and agent messages without legacy labels", () => {
    const { rerender } = render(
      <Activity
        item={{
          type: "userMessage",
          id: "user",
          status: "completed",
          text: "Сообщение",
          images: [],
          timestamp: null,
          phase: null,
        }}
      />,
    );
    expect(screen.getByText("Сообщение").closest("article")).toHaveClass("userMessage");
    expect(screen.queryByText("Вы")).not.toBeInTheDocument();

    rerender(
      <Activity
        item={{
          type: "agentMessage",
          id: "agent",
          status: "completed",
          text: "Ответ",
          images: [],
          timestamp: null,
          phase: "final_answer",
        }}
      />,
    );
    expect(screen.getByText("Ответ").closest("article")).toHaveClass("agentMessage");
    expect(screen.queryByText("Codex")).not.toBeInTheDocument();

    rerender(
      <Activity
        item={{
          type: "reasoning",
          id: "reasoning",
          status: "completed",
          text: "Проверяю",
          images: [],
          timestamp: null,
          phase: null,
        }}
      />,
    );
    expect(screen.getByText("Проверяю")).toBeInTheDocument();
    expect(screen.queryByText("Ход работы")).not.toBeInTheDocument();
  });

  it("renders GFM tables and task lists", () => {
    const view = render(
      <Activity
        item={{
          type: "agentMessage",
          id: "markdown",
          status: "completed",
          text: "| Поле | Значение |\n| --- | --- |\n| Статус | Готово |\n\n- [x] Проверено",
          images: [],
          timestamp: null,
          phase: "final_answer",
        }}
      />,
    );

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Поле" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "" })).toBeChecked();
    expect(view.container.querySelector(".markdown-table-scroll")).not.toBeNull();
  });

  it("renders submitted questions and answers as one user message", () => {
    render(
      <Activity
        item={{
          type: "userInputResponse",
          id: "answers",
          status: "completed",
          entries: [
            { header: "Хранение", question: "Где хранить?", answers: ["На сервере"] },
            { header: "Токен", question: "Какой токен?", answers: ["secret-value"] },
          ],
          timestamp: Date.now(),
          afterItemId: "request",
        }}
      />,
    );

    const article = screen.getByText("Где хранить?").closest("article");
    expect(article).toHaveClass("userMessage", "user-input-response");
    expect(screen.getByText("На сервере")).toBeInTheDocument();
    expect(screen.getByText("secret-value")).toBeInTheDocument();
  });

  it("omits empty text activities and hides copy for image-only messages", () => {
    const view = render(
      <Activity
        item={{
          type: "userMessage",
          id: "image",
          status: "completed",
          text: "  ",
          images: ["data:image/png;base64,aW1hZ2U="],
          timestamp: Date.now(),
          phase: null,
        }}
      />,
    );

    expect(screen.getByAltText("Изображение 1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Копировать сообщение" })).toBeNull();

    view.rerender(
      <Activity
        item={{
          type: "agentMessage",
          id: "empty",
          status: "inProgress",
          text: "\n",
          images: [],
          timestamp: Date.now(),
          phase: "commentary",
        }}
      />,
    );
    expect(view.container).toBeEmptyDOMElement();
  });

  it("keeps command output and file patches in compact details", () => {
    const { rerender } = render(
      <Activity
        item={{
          type: "command",
          id: "command",
          status: "completed",
          kind: "command",
          command: "npm test",
          cwd: "/work",
          output: "5 tests passed",
          exitCode: 0,
        }}
      />,
    );
    expect(screen.getByText("npm test").closest("details")).toHaveClass("activity-card");
    expect(screen.getByText("5 tests passed")).toBeInTheDocument();

    rerender(
      <Activity
        item={{
          type: "fileChange",
          id: "file",
          status: "completed",
          path: "src/App.tsx",
          patch: "+new line",
        }}
      />,
    );
    expect(screen.getByText("Изменён src/App.tsx")).toBeInTheDocument();
    expect(screen.getByText("+new line")).toBeInTheDocument();
  });

  it("copies message text and formats timestamps for today and older days", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const timestamp = Date.now();
    render(
      <Activity
        item={{
          type: "agentMessage",
          id: "agent",
          status: "completed",
          text: "Текст ответа",
          images: [],
          timestamp,
          phase: "final_answer",
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Копировать сообщение" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Текст ответа"));
    expect(screen.getByRole("status")).toHaveTextContent("Скопировано");
    expect(screen.getByText(formatMessageTime(timestamp))).toBeInTheDocument();
    const copyButton = screen.getByRole("button", { name: "Копировать сообщение" });
    expect(copyButton.closest(".message-footer")?.lastElementChild).toBe(copyButton);
    expect(formatMessageTime(timestamp - 3 * 86_400_000)).toMatch(/\d{2}:\d{2}/);
  });

  it("shows a live turn timer and a final duration", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-21T12:00:05Z"));
      const running = {
        id: "running",
        status: "inProgress" as const,
        startedAt: Date.now() - 5_000,
        completedAt: null,
        durationMs: null,
        progress: progress(),
        items: [],
      };
      const view = render(<TurnTiming turn={running} />);
      expect(screen.getByText("Codex работает 5с")).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(2_000));
      expect(screen.getByText("Codex работает 7с")).toBeInTheDocument();

      view.rerender(
        <TurnTiming
          turn={{
            ...running,
            status: "completed",
            completedAt: running.startedAt + 8_000,
            durationMs: 8_000,
          }}
        />,
      );
      expect(screen.getByText("Работал 8с")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("downloads task file links once and leaves other links unchanged", async () => {
    const api = threadApi();
    let resolveTicket: ((ticket: { downloadUrl: string; expiresAt: number }) => void) | undefined;
    api.createDownload.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTicket = resolve;
        }),
    );
    mockThreadConnection(api, summary, {
      turns: [
        {
          id: "turn",
          status: "completed",
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
          progress: progress(),
          items: [
            {
              type: "agentMessage",
              id: "agent",
              status: "completed",
              text: [
                "[Скачать APK](/work/project/build/app-debug.apk)",
                "[Внешняя ссылка](https://example.com/file.apk)",
                "[Раздел приложения](/settings)",
              ].join("\n\n"),
              images: [],
              timestamp: 2,
              phase: "final_answer",
            },
          ],
        },
      ],
    });
    renderThread();

    const fileLink = screen.getByRole("link", { name: "Скачать APK" });
    fireEvent.click(fileLink);
    fireEvent.click(fileLink);
    expect(api.createDownload).toHaveBeenCalledTimes(1);
    expect(api.createDownload).toHaveBeenCalledWith("thread", "/work/project/build/app-debug.apk");
    expect(fileLink).toHaveAttribute("aria-busy", "true");

    resolveTicket?.({ downloadUrl: "/downloads/ticket/app-debug.apk", expiresAt: 61_000 });
    await waitFor(() =>
      expect(openDownloadUrl).toHaveBeenCalledWith(
        "https://codex.home.arpa",
        "/downloads/ticket/app-debug.apk",
      ),
    );
    expect(fileLink).toHaveAttribute("aria-busy", "false");
    expect(screen.getByRole("link", { name: "Внешняя ссылка" })).toHaveAttribute(
      "href",
      "https://example.com/file.apk",
    );
    expect(screen.getByRole("link", { name: "Раздел приложения" })).toHaveAttribute(
      "href",
      "/settings",
    );
  });

  it("shows a retryable error when a file ticket cannot be issued", async () => {
    const api = threadApi();
    api.createDownload
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce({ downloadUrl: "/downloads/retry/file.txt", expiresAt: 61_000 });
    mockThreadConnection(api, summary, {
      turns: [
        {
          id: "turn",
          status: "completed",
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
          progress: progress(),
          items: [
            {
              type: "agentMessage",
              id: "agent",
              status: "completed",
              text: "[Скачать файл](/work/project/file.txt)",
              images: [],
              timestamp: 2,
              phase: "final_answer",
            },
          ],
        },
      ],
    });
    renderThread();

    const link = screen.getByRole("link", { name: "Скачать файл" });
    fireEvent.click(link);
    expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось скачать файл");

    fireEvent.click(link);
    await waitFor(() => expect(openDownloadUrl).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps send, pin, rename and archive actions wired to the existing API", async () => {
    const api = threadApi();
    mockThreadConnection(api, summary);
    renderThread();

    fireEvent.change(screen.getByRole("textbox", { name: "Сообщение для Codex" }), {
      target: { value: "Продолжай" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() =>
      expect(api.startTurn).toHaveBeenCalledWith(
        "thread",
        expect.objectContaining({ input: "Продолжай", clientMessageId: expect.any(String) }),
      ),
    );

    fireEvent.click(screen.getByLabelText("Действия с задачей"));
    fireEvent.click(screen.getByRole("button", { name: "Закрепить" }));
    expect(api.updateThread).toHaveBeenCalledWith("thread", { pinned: true });

    fireEvent.click(screen.getByRole("button", { name: "Переименовать" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Название" }), {
      target: { value: "Новое имя" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(api.updateThread).toHaveBeenCalledWith("thread", { name: "Новое имя" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Архивировать" }));
    expect(api.archive).toHaveBeenCalledWith("thread", true);
  });

  it("keeps a completed session green until the user finishes it", async () => {
    let resolveFinish: (() => void) | undefined;
    const api = threadApi();
    api.markRead.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveFinish = resolve;
      }),
    );
    const unfinished = {
      ...summary,
      state: "completed" as const,
      unread: true,
      updatedAt: 123,
    };
    const context = mockThreadConnection(api, unfinished, {
      turns: [
        {
          id: "completed-turn",
          status: "completed",
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
          progress: progress(),
          items: [
            {
              type: "agentMessage",
              id: "answer",
              status: "completed",
              text: "Готово",
              images: [],
              timestamp: 2,
              phase: null,
            },
          ],
        },
      ],
    });
    const view = renderThread();

    expect(api.markRead).not.toHaveBeenCalled();
    const finish = screen.getByRole("button", { name: "Закончить" });
    expect(view.container.querySelector(".timeline")?.lastElementChild).toBe(finish);

    fireEvent.click(finish);
    expect(api.markRead).toHaveBeenCalledWith("thread", { observedUpdatedAt: 123 });
    expect(screen.getByRole("button", { name: "Заканчиваем…" })).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox", { name: "Сообщение для Codex" }), {
      target: { value: "Ещё вопрос" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() =>
      expect(api.startTurn).toHaveBeenCalledWith(
        "thread",
        expect.objectContaining({ input: "Ещё вопрос", clientMessageId: expect.any(String) }),
      ),
    );

    resolveFinish?.();
    await waitFor(() => expect(screen.getByRole("button", { name: "Закончить" })).toBeEnabled());

    const finished = { ...unfinished, unread: false };
    context.state.snapshot.threads = [finished];
    context.state.details.thread.summary = finished;
    view.rerender(threadRoute());
    expect(screen.queryByRole("button", { name: "Закончить" })).toBeNull();
  });

  it("keeps the finish action available when marking the session fails", async () => {
    const api = threadApi();
    api.markRead.mockRejectedValue(new Error("Сервер недоступен"));
    mockThreadConnection(api, {
      ...summary,
      state: "completed",
      unread: true,
      updatedAt: 123,
    });
    renderThread();

    fireEvent.click(screen.getByRole("button", { name: "Закончить" }));

    expect(await screen.findByText("Сервер недоступен")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Закончить" })).toBeEnabled();
    expect(api.startTurn).not.toHaveBeenCalled();
    expect(api.interrupt).not.toHaveBeenCalled();
  });

  it("deletes an empty unnamed session after confirmation", async () => {
    const api = threadApi();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    mockThreadConnection(api, { ...summary, title: "Без названия", preview: "" });
    renderThread();

    fireEvent.click(screen.getByLabelText("Действия с задачей"));
    fireEvent.click(screen.getByRole("button", { name: "Удалить" }));

    expect(confirm).toHaveBeenCalledWith("Удалить эту сессию? Это действие нельзя отменить.");
    await waitFor(() => expect(api.deleteThread).toHaveBeenCalledWith("thread"));
    confirm.mockRestore();
  });

  it("loads Git changes when the inspector opens and refreshes after a turn completes", async () => {
    const api = threadApi();
    api.readGitChanges
      .mockResolvedValueOnce({ state: "dirty", filesChanged: 1, additions: 2, deletions: 1 })
      .mockResolvedValueOnce({ state: "clean", filesChanged: 0, additions: 0, deletions: 0 });
    const running = { ...summary, state: "running" as const, currentTurnId: "turn" };
    const context = mockThreadConnection(api, running);
    const view = renderThread();

    fireEvent.click(screen.getByRole("button", { name: "Показать сведения" }));
    await waitFor(() => expect(api.readGitChanges).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("1 файл")).toBeInTheDocument();

    const completed = { ...summary, state: "completed" as const, updatedAt: 3 };
    context.state.snapshot.threads = [completed];
    context.state.details.thread.summary = completed;
    view.rerender(threadRoute());

    await waitFor(() => expect(api.readGitChanges).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Нет изменений")).toBeInTheDocument();
  });

  it("refreshes Git changes when the active turn diff changes", async () => {
    const api = threadApi();
    api.readGitChanges
      .mockResolvedValueOnce({ state: "clean", filesChanged: 0, additions: 0, deletions: 0 })
      .mockResolvedValueOnce({ state: "dirty", filesChanged: 2, additions: 4, deletions: 1 })
      .mockResolvedValueOnce({ state: "clean", filesChanged: 0, additions: 0, deletions: 0 });
    const running = { ...summary, state: "running" as const, currentTurnId: "turn" };
    const context = mockThreadConnection(api, running, {
      turns: [
        {
          id: "turn",
          status: "inProgress",
          startedAt: 1,
          completedAt: null,
          durationMs: null,
          progress: progress(),
          items: [],
        },
      ],
    });
    const view = renderThread();

    fireEvent.click(screen.getByRole("button", { name: "Показать сведения" }));
    await waitFor(() => expect(api.readGitChanges).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Нет изменений")).toBeInTheDocument();

    context.state.details.thread.turns[0]!.progress = {
      ...progress(),
      filesChanged: 2,
      additions: 4,
      deletions: 1,
    };
    view.rerender(threadRoute());

    await waitFor(() => expect(api.readGitChanges).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("2 файла")).toBeInTheDocument();

    context.state.details.thread.turns[0]!.progress = {
      ...context.state.details.thread.turns[0]!.progress,
      explanation: "Счётчики не изменились",
    };
    view.rerender(threadRoute());
    expect(api.readGitChanges).toHaveBeenCalledTimes(2);

    context.state.details.thread.turns[0]!.progress = progress();
    view.rerender(threadRoute());

    await waitFor(() => expect(api.readGitChanges).toHaveBeenCalledTimes(3));
    expect(await screen.findByText("Нет изменений")).toBeInTheDocument();
  });

  it("queues and interrupts a running task", async () => {
    const api = threadApi();
    const context = mockThreadConnection(api, {
      ...summary,
      state: "running",
      currentTurnId: "turn",
    });
    renderThread();

    const textbox = screen.getByRole("textbox", { name: "Направить текущую задачу" });
    fireEvent.change(textbox, {
      target: { value: "Сначала проверь тесты" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Добавить в очередь" }));
    expect(textbox).toHaveValue("");
    expect(context.dispatch).toHaveBeenCalledWith({
      type: "optimistic.add",
      message: expect.objectContaining({
        text: "Сначала проверь тесты",
        destination: "queue",
      }),
    });
    await waitFor(() =>
      expect(api.enqueue).toHaveBeenCalledWith(
        "thread",
        expect.objectContaining({
          input: "Сначала проверь тесты",
          clientMessageId: expect.any(String),
        }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Остановить задачу" }));
    expect(api.interrupt).toHaveBeenCalledWith("thread", "turn");
    expect(screen.getByRole("button", { name: "Включить режим планирования" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Модель" })).toBeDisabled();
  });

  it("sends image-only messages, keeps attachments after errors, and clears them after success", async () => {
    const api = threadApi();
    api.startTurn
      .mockRejectedValueOnce(new Error("Сеть недоступна"))
      .mockResolvedValueOnce({ turnId: "turn" });
    mockThreadConnection(api, summary);
    const view = renderThread();
    const fileInput = view.container.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(fileInput, {
      target: { files: [new File(["image"], "screen.png", { type: "image/png" })] },
    });
    expect(await screen.findByAltText("screen.png")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    expect(await screen.findByText("Сеть недоступна")).toBeInTheDocument();
    expect(screen.getByAltText("screen.png")).toBeInTheDocument();
    expect(api.startTurn.mock.calls[0]?.[1]).toMatchObject({
      input: "",
      images: [expect.stringMatching(/^data:image\/png;base64,/)],
    });

    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() => expect(screen.queryByAltText("screen.png")).toBeNull());
  });

  it("keeps task settings in the composer without permission controls", async () => {
    const api = threadApi();
    mockThreadConnection(api, summary);
    renderThread();

    expect(
      screen.queryByRole("combobox", { name: "Уровень подтверждений" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Модель" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Уровень рассуждений" })).toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "Проверка подтверждений" }),
    ).not.toBeInTheDocument();
    const plan = screen.getByRole("button", { name: "Включить режим планирования" });
    expect(plan).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(plan);
    await waitFor(() =>
      expect(api.updateThreadSettings).toHaveBeenCalledWith("thread", {
        collaborationMode: "plan",
      }),
    );
  });

  it("shows native goal state and exposes pause and clear actions", async () => {
    const api = threadApi();
    api.updateGoal.mockResolvedValue({
      threadId: "thread",
      objective: "Завершить интерфейс",
      status: "paused",
      tokenBudget: null,
      tokensUsed: 120,
      timeUsedSeconds: 15,
      createdAt: 1,
      updatedAt: 2,
    });
    const context = mockThreadConnection(api, summary);
    Object.assign(context.state, {
      goals: {
        thread: {
          threadId: "thread",
          objective: "Завершить интерфейс",
          status: "active",
          tokenBudget: null,
          tokensUsed: 120,
          timeUsedSeconds: 15,
          createdAt: 1,
          updatedAt: 2,
        },
      },
    });
    renderThread();

    const goalControl = screen.getByLabelText("Управление целью");
    expect(goalControl.querySelector("span")).toBeNull();
    expect(goalControl.querySelectorAll("svg")).toHaveLength(1);
    fireEvent.click(goalControl);
    expect(screen.getByText("Завершить интерфейс")).toBeInTheDocument();
    expect(screen.getByText(/120 токенов/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Включить режим планирования" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Пауза" }));
    await waitFor(() =>
      expect(api.updateGoal).toHaveBeenCalledWith("thread", { status: "paused" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Очистить" }));
    await waitFor(() => expect(api.clearGoal).toHaveBeenCalledWith("thread"));
  });

  it("submits on Enter, keeps Shift+Enter for a newline, and ignores IME composition", async () => {
    const api = threadApi();
    mockThreadConnection(api, summary);
    renderThread();
    const textarea = screen.getByRole("textbox", { name: "Сообщение для Codex" });

    fireEvent.change(textarea, { target: { value: "Сообщение" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
    expect(api.startTurn).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() =>
      expect(api.startTurn).toHaveBeenCalledWith(
        "thread",
        expect.objectContaining({ input: "Сообщение", clientMessageId: expect.any(String) }),
      ),
    );
  });

  it("focuses the composer only when navigation marks the session as newly created", () => {
    const api = threadApi();
    mockThreadConnection(api, summary);
    const view = renderThread({ focusComposer: true });
    expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).toHaveFocus();

    view.unmount();
    renderThread();
    expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).not.toHaveFocus();
  });

  it("accepts a completed plan without offering a reject action", async () => {
    const api = threadApi();
    const planThread = {
      ...summary,
      settings: { collaborationMode: "plan" as const },
    };
    mockThreadConnection(api, planThread, {
      turns: [
        {
          id: "plan-turn",
          status: "completed",
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
          progress: progress(),
          items: [
            {
              type: "plan",
              id: "plan",
              status: "completed",
              text: "# План\n\nСделать",
              images: [],
              timestamp: 2,
              phase: null,
            },
          ],
        },
      ],
    });
    renderThread();

    expect(screen.queryByRole("button", { name: /Отклонить/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Да, реализуй этот план" }));

    await waitFor(() =>
      expect(api.updateThreadSettings).toHaveBeenCalledWith("thread", {
        collaborationMode: "default",
      }),
    );
    expect(api.startTurn).toHaveBeenCalledWith(
      "thread",
      expect.objectContaining({
        input: "Да, реализуй этот план",
        clientMessageId: expect.any(String),
      }),
    );
  });

  it("shows server-owned queued messages and sends one immediately", async () => {
    const api = threadApi();
    const running = { ...summary, state: "running" as const, currentTurnId: "turn" };
    mockThreadConnection(api, running, {
      queuedMessages: [
        {
          id: "queued",
          threadId: "thread",
          text: "Срочная правка",
          createdAt: 1,
          status: "queued",
        },
      ],
    });
    renderThread();

    expect(screen.getByText("В очереди")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Отправить сейчас" }));
    await waitFor(() => expect(api.sendQueuedNow).toHaveBeenCalledWith("thread", "queued"));
  });

  it("shows the live plan checklist inside the turn without a composer status pill", () => {
    const api = threadApi();
    const running = { ...summary, state: "running" as const, currentTurnId: "turn" };
    mockThreadConnection(api, running, {
      turns: [
        {
          id: "turn",
          status: "inProgress",
          startedAt: Date.now() - 5_000,
          completedAt: null,
          durationMs: null,
          progress: {
            startedAt: Date.now() - 5_000,
            explanation: "Проверяем изменения",
            steps: [
              { step: "Прочитать код", status: "completed" },
              { step: "Исправить чат", status: "inProgress" },
              { step: "Запустить тесты", status: "pending" },
            ],
            filesChanged: 2,
            additions: 12,
            deletions: 3,
          },
          items: [
            {
              type: "planChecklist",
              id: "turn-plan-checklist",
              status: "inProgress",
              explanation: "Проверяем изменения",
              steps: [
                { step: "Прочитать код", status: "completed" },
                { step: "Исправить чат", status: "inProgress" },
                { step: "Запустить тесты", status: "pending" },
              ],
              timestamp: Date.now(),
              afterItemId: null,
            },
          ],
        },
      ],
    });
    renderThread();

    expect(screen.getByText("Ход работы")).toBeInTheDocument();
    expect(screen.getByText("Прочитать код")).toBeInTheDocument();
    expect(screen.getByText("Исправить чат")).toBeInTheDocument();
    expect(screen.getByText("Запустить тесты")).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    expect(screen.getAllByRole("checkbox")[0]).toBeChecked();
    expect(screen.getAllByText("Проверяем изменения").length).toBeGreaterThanOrEqual(1);
    expect(document.querySelector(".turn-progress")).toBeNull();
  });

  it("does not leave timeline gaps for empty streamed activities", () => {
    const api = threadApi();
    const running = { ...summary, state: "running" as const, currentTurnId: "turn" };
    mockThreadConnection(api, running, {
      turns: [
        {
          id: "turn",
          status: "inProgress",
          startedAt: Date.now() - 3_000,
          completedAt: null,
          durationMs: null,
          progress: progress(),
          items: [
            {
              type: "agentMessage",
              id: "empty-agent",
              status: "inProgress",
              text: "",
              images: [],
              timestamp: Date.now(),
              phase: "commentary",
            },
            {
              type: "reasoning",
              id: "empty-reasoning",
              status: "inProgress",
              text: " \n ",
              images: [],
              timestamp: Date.now(),
              phase: null,
            },
          ],
        },
      ],
    });
    const view = renderThread();

    expect(screen.queryByRole("button", { name: "Копировать сообщение" })).toBeNull();
    expect(view.container.querySelector(".turn > div:empty")).toBeNull();
  });

  it("renders attention requests after the active turn inside the timeline", () => {
    const api = threadApi();
    const running = { ...summary, state: "running" as const, currentTurnId: "turn" };
    mockThreadConnection(api, running, {
      turns: [
        {
          id: "turn",
          status: "inProgress",
          startedAt: 1,
          completedAt: null,
          durationMs: null,
          progress: progress(),
          items: [
            {
              type: "agentMessage",
              id: "agent",
              status: "completed",
              text: "Перед запросом",
              images: [],
              timestamp: 1,
              phase: "commentary",
            },
          ],
        },
      ],
      attention: [
        {
          id: "attention",
          threadId: "thread",
          turnId: "turn",
          itemId: null,
          createdAt: 1,
          kind: "commandApproval",
          command: "npm test",
          cwd: "/work",
          reason: null,
          networkHost: null,
          canAcceptForSession: false,
          proposedPolicyChanges: [],
        },
      ],
    });
    const view = renderThread();
    const turn = view.container.querySelector(".turn")!;
    const attention = view.container.querySelector(".attention-stack")!;

    expect(turn.compareDocumentPosition(attention) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(attention.closest(".timeline")).not.toBeNull();
  });

  it("renders an optimistic message before the running indicator while startTurn is pending", async () => {
    let resolveStart: ((value: { turnId: string }) => void) | undefined;
    const api = threadApi();
    api.startTurn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve;
        }),
    );
    const context = mockThreadConnection(api, summary);
    const view = renderThread();
    const textbox = screen.getByRole("textbox", { name: "Сообщение для Codex" });

    fireEvent.change(textbox, { target: { value: "Появись сразу" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    expect(textbox).toHaveValue("");
    const optimistic = context.dispatch.mock.calls.find(
      ([action]) => action.type === "optimistic.add",
    )?.[0].message;
    expect(optimistic).toMatchObject({
      text: "Появись сразу",
      destination: "turn",
    });

    const running = { ...summary, state: "running" as const, currentTurnId: "turn" };
    context.state.snapshot.threads = [running];
    context.state.details.thread = {
      ...context.state.details.thread,
      summary: running,
      turns: [
        {
          id: "turn",
          status: "inProgress",
          startedAt: Date.now(),
          completedAt: null,
          durationMs: null,
          progress: progress(),
          items: [],
        },
      ],
    };
    context.state.optimisticMessages.thread = [optimistic];
    view.rerender(threadRoute());

    const message = screen.getByText("Появись сразу").closest("article")!;
    const timing = view.container.querySelector(".turn-timing")!;
    expect(message.compareDocumentPosition(timing) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await act(async () => resolveStart?.({ turnId: "turn" }));
  });

  it("loads older turns near the top and preserves the visible scroll position", async () => {
    const api = threadApi();
    const context = mockThreadConnection(api, summary, { olderTurnsCursor: "older-page" });
    let scrollHeight = 1_000;
    context.loadOlderDetail.mockImplementation(async () => {
      scrollHeight = 1_300;
      const current = context.state.details.thread;
      context.state.details.thread = {
        ...current,
        turns: [
          {
            id: "older",
            status: "completed",
            startedAt: 1,
            completedAt: 2,
            durationMs: 1,
            progress: progress(),
            items: [],
          },
          ...current.turns,
        ],
        olderTurnsCursor: null,
      };
      return context.state.details.thread;
    });
    const view = renderThread();
    const scroll = view.container.querySelector(".conversation-scroll") as HTMLDivElement;
    Object.defineProperty(scroll, "scrollHeight", { configurable: true, get: () => scrollHeight });
    Object.defineProperty(scroll, "clientHeight", { configurable: true, get: () => 500 });
    scroll.scrollTop = 50;

    fireEvent.scroll(scroll);

    await waitFor(() =>
      expect(context.loadOlderDetail).toHaveBeenCalledWith("thread", "older-page"),
    );
    await waitFor(() => expect(scroll.scrollTop).toBe(350));
  });

  it("does not reload history for a reconnect snapshot epoch", async () => {
    const api = threadApi();
    const context = mockThreadConnection(api, summary);
    const view = renderThread();
    await waitFor(() => expect(context.refreshDetail).toHaveBeenCalledTimes(1));

    context.state.snapshotEpoch += 1;
    view.rerender(threadRoute());

    expect(context.refreshDetail).toHaveBeenCalledTimes(1);
  });

  it("shows a fallback working row and refreshes only when turn details disagree", async () => {
    const api = threadApi();
    const running = { ...summary, state: "running" as const, currentTurnId: "missing-turn" };
    const context = mockThreadConnection(api, running);
    const view = renderThread();

    expect(screen.getByText("Codex работает…")).toBeInTheDocument();
    await waitFor(() => expect(context.refreshDetail).toHaveBeenCalled());

    context.state.snapshot.threads = [{ ...running, state: "completed", currentTurnId: null }];
    context.state.details.thread = {
      ...context.state.details.thread,
      summary: { ...running, state: "completed", currentTurnId: null },
      turns: [
        {
          id: "stale-turn",
          status: "inProgress",
          startedAt: Date.now(),
          completedAt: null,
          durationMs: null,
          progress: progress(),
          items: [],
        },
      ],
    };
    view.rerender(threadRoute());
    expect(screen.queryByText(/Codex работает/)).toBeNull();
  });

  it("opens a loaded conversation at the bottom", () => {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 900,
    });
    const api = threadApi();
    mockThreadConnection(api, summary);
    const view = renderThread();
    const scroll = view.container.querySelector(".conversation-scroll") as HTMLDivElement;
    expect(scroll.scrollTop).toBe(900);
    delete (HTMLElement.prototype as unknown as { scrollHeight?: number }).scrollHeight;
  });
});

function renderThread(state?: Record<string, unknown>) {
  return render(threadRoute(state));
}

function threadRoute(state?: Record<string, unknown>) {
  return (
    <MemoryRouter initialEntries={[{ pathname: "/threads/thread", state }]}>
      <Routes>
        <Route
          path="/threads/:threadId"
          element={<ThreadPage onOpenNavigation={() => undefined} />}
        />
        <Route path="/new" element={<div>Новая сессия</div>} />
      </Routes>
    </MemoryRouter>
  );
}

function threadApi() {
  return {
    settings: { baseUrl: "https://codex.home.arpa", token: "secret" },
    createDownload: vi.fn().mockResolvedValue({
      downloadUrl: "/downloads/ticket/file.bin",
      expiresAt: Date.now() + 60_000,
    }),
    startTurn: vi.fn().mockResolvedValue({ turnId: "turn" }),
    enqueue: vi.fn().mockResolvedValue({ id: "queued" }),
    sendQueuedNow: vi.fn().mockResolvedValue({ turnId: "turn" }),
    steer: vi.fn().mockResolvedValue({ turnId: "turn" }),
    interrupt: vi.fn().mockResolvedValue(undefined),
    updateThread: vi.fn().mockResolvedValue(undefined),
    deleteThread: vi.fn().mockResolvedValue(undefined),
    updateThreadSettings: vi.fn().mockImplementation((_id, patch) =>
      Promise.resolve({
        ...summary,
        settings: { ...summary.settings, ...patch },
      }),
    ),
    archive: vi.fn().mockResolvedValue(undefined),
    markRead: vi.fn().mockResolvedValue(undefined),
    readGitChanges: vi
      .fn()
      .mockResolvedValue({ state: "clean", filesChanged: 0, additions: 0, deletions: 0 }),
    readGoal: vi.fn().mockResolvedValue(null),
    updateGoal: vi.fn().mockResolvedValue(null),
    clearGoal: vi.fn().mockResolvedValue(undefined),
  };
}

function mockThreadConnection(
  api: ReturnType<typeof threadApi>,
  thread: ThreadSummary,
  detailPatch: Partial<{
    turns: Array<{
      id: string;
      status: "inProgress" | "completed" | "failed" | "interrupted";
      startedAt: number | null;
      completedAt: number | null;
      durationMs: number | null;
      progress: ReturnType<typeof progress>;
      items: Array<Parameters<typeof Activity>[0]["item"]>;
    }>;
    queuedMessages: Array<{
      id: string;
      threadId: string;
      text: string;
      createdAt: number;
      status: "queued" | "dispatching";
    }>;
    olderTurnsCursor: string | null;
    attention: AttentionRequest[];
  }> = {},
) {
  const detail = {
    summary: thread,
    turns: detailPatch.turns ?? [],
    queuedMessages: detailPatch.queuedMessages ?? [],
    olderTurnsCursor: detailPatch.olderTurnsCursor ?? null,
  };
  const value = {
    api,
    state: {
      snapshot: {
        projects: [
          {
            id: "project",
            displayName: "Проект",
            path: "/work/project",
            createdAt: "2026-01-01",
            updatedAt: "2026-01-01",
          },
        ],
        threads: [thread] as ThreadSummary[],
        attention: detailPatch.attention ?? [],
        models: [
          {
            id: "gpt",
            displayName: "GPT",
            description: "",
            isDefault: true,
            reasoningEfforts: [{ value: "high", description: null, isDefault: true }],
            serviceTiers: [],
            supportsPersonality: true,
          },
        ],
        connection: { state: "ready" },
      },
      details: { thread: detail },
      expandedHistory: {},
      optimisticMessages: {} as Record<string, OptimisticMessage[]>,
      network: "connected",
      snapshotEpoch: 1,
    },
    refreshDetail: vi.fn().mockResolvedValue(detail),
    loadOlderDetail: vi.fn().mockResolvedValue(detail),
    dispatch: vi.fn(),
  };
  connection.mockReturnValue(value);
  return value;
}

function progress(): TurnProgress {
  return {
    startedAt: 1,
    explanation: null,
    steps: [],
    filesChanged: 0,
    additions: 0,
    deletions: 0,
  };
}
