import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import type { AttentionRequest, ThreadSummary, TurnProgress } from "@codexnest/protocol";

import { Activity, ThreadPage, TurnTiming, formatMessageTime } from "./ThreadPage";

const connection = vi.hoisted(() => vi.fn());

vi.mock("../connection", () => ({ useConnection: connection }));

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

  it("keeps send, pin, rename and archive actions wired to the existing API", async () => {
    const api = threadApi();
    mockThreadConnection(api, summary);
    renderThread();

    fireEvent.change(screen.getByRole("textbox", { name: "Сообщение для Codex" }), {
      target: { value: "Продолжай" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() =>
      expect(api.startTurn).toHaveBeenCalledWith("thread", { input: "Продолжай" }),
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

  it("queues and interrupts a running task", async () => {
    const api = threadApi();
    mockThreadConnection(api, { ...summary, state: "running", currentTurnId: "turn" });
    renderThread();

    fireEvent.change(screen.getByRole("textbox", { name: "Направить текущую задачу" }), {
      target: { value: "Сначала проверь тесты" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Добавить в очередь" }));
    await waitFor(() =>
      expect(api.enqueue).toHaveBeenCalledWith("thread", { input: "Сначала проверь тесты" }),
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
      expect(api.startTurn).toHaveBeenCalledWith("thread", { input: "Сообщение" }),
    );
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
    expect(api.startTurn).toHaveBeenCalledWith("thread", { input: "Да, реализуй этот план" });
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

  it("shows the current plan step and turn diff above the composer", () => {
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
          items: [],
        },
      ],
    });
    renderThread();

    expect(screen.getByText("Шаг 2 / 3")).toBeInTheDocument();
    expect(screen.getByText("Изменено 2 файла")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Шаг 2 / 3"));
    expect(screen.getByText("Исправить чат")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Исправить чат"));
    expect(screen.queryByText("Исправить чат")).toBeNull();
    fireEvent.click(screen.getByText("Шаг 2 / 3"));
    fireEvent.click(screen.getByText("Шаг 2 / 3"));
    expect(screen.queryByText("Исправить чат")).toBeNull();
    fireEvent.click(screen.getByText("Шаг 2 / 3"));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByText("Исправить чат")).toBeNull();
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

function renderThread() {
  return render(threadRoute());
}

function threadRoute() {
  return (
    <MemoryRouter initialEntries={["/threads/thread"]}>
      <Routes>
        <Route
          path="/threads/:threadId"
          element={<ThreadPage onOpenNavigation={() => undefined} />}
        />
      </Routes>
    </MemoryRouter>
  );
}

function threadApi() {
  return {
    startTurn: vi.fn().mockResolvedValue({ turnId: "turn" }),
    enqueue: vi.fn().mockResolvedValue({ id: "queued" }),
    sendQueuedNow: vi.fn().mockResolvedValue({ turnId: "turn" }),
    steer: vi.fn().mockResolvedValue({ turnId: "turn" }),
    interrupt: vi.fn().mockResolvedValue(undefined),
    updateThread: vi.fn().mockResolvedValue(undefined),
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
    attention: AttentionRequest[];
  }> = {},
) {
  const detail = {
    summary: thread,
    turns: detailPatch.turns ?? [],
    queuedMessages: detailPatch.queuedMessages ?? [],
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
      network: "connected",
      snapshotEpoch: 1,
    },
    refreshDetail: vi.fn().mockResolvedValue(detail),
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
