import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router";

import { DEFAULT_SESSION_SETTINGS } from "@codexnest/protocol";
import type {
  ActivityItem,
  AttentionRequest,
  ModelOption,
  ThreadDetail,
  ThreadDraft,
  ThreadSummary,
  TranscriptionConfigResponse,
  TurnProgress,
  UpdateThreadDraftRequest,
  VoiceTranscriptionJob,
} from "@codexnest/protocol";

import { annotationStorageKey, type PendingAnnotation } from "../annotations";
import { ApiClientError } from "../api";
import type { ForkOperationSummary } from "../forks";
import type { OptimisticMessage } from "../state";
import { Activity, ThreadPage, formatMessageTime, initialSessionSettings } from "./ThreadPage";

const connection = vi.hoisted(() => vi.fn());
const openDownloadUrl = vi.hoisted(() => vi.fn());
const deleteLocalDraft = vi.hoisted(() =>
  vi.fn<(settings: unknown, threadId: string) => Promise<void>>(() => Promise.resolve()),
);
const saveLocalDraft = vi.hoisted(() =>
  vi.fn(
    async (
      _settings: unknown,
      threadId: string,
      value: UpdateThreadDraftRequest,
      updatedAt = Date.now(),
    ) => ({ key: threadId, connectionKey: "test", threadId, value, updatedAt }),
  ),
);
const acknowledgePendingThread = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const releaseActiveThread = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock("../connection", () => ({ useConnection: connection }));
vi.mock("../downloads", () => ({ openDownloadUrl }));
vi.mock("../push", () => ({ acknowledgePendingThread, releaseActiveThread }));
vi.mock("../offline-store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  deleteLocalDraft,
  saveLocalDraft,
}));

const summary: ThreadSummary = {
  id: "thread",
  relation: { kind: "session", sessionId: "session" },
  projectId: "project",
  title: "Тестовая задача",
  preview: "",
  cwd: "/work/project",
  state: "idle",
  unread: false,
  unseen: false,
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  currentTurnId: null,
  queuedMessageCount: 0,
  browserStatus: "disabled",
  settings: { collaborationMode: "default" },
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
});

describe("initialSessionSettings", () => {
  const taskDefaults = { serviceTier: "fast", personality: "friendly" };

  it("ignores a legacy service-tier default when model metadata is missing", () => {
    expect(initialSessionSettings("high", [], taskDefaults)).toEqual({
      ...DEFAULT_SESSION_SETTINGS,
      reasoningEffort: "high",
      personality: "friendly",
    });
  });

  it("falls back from a stale model without carrying unsupported dependent defaults", () => {
    const staleModel: ModelOption = {
      id: "gpt",
      displayName: "GPT",
      description: "",
      isDefault: true,
      reasoningEfforts: [{ value: "low", description: null, isDefault: true }],
      serviceTiers: [],
      supportsPersonality: false,
    };

    expect(
      initialSessionSettings("high", [staleModel], { model: "retired", ...taskDefaults }),
    ).toEqual(DEFAULT_SESSION_SETTINGS);
  });

  it("uses the selected default model when it is available", () => {
    const model: ModelOption = {
      id: "gpt",
      displayName: "GPT",
      description: "",
      isDefault: true,
      reasoningEfforts: [{ value: "high", description: null, isDefault: true }],
      serviceTiers: [],
      supportsPersonality: false,
    };

    expect(initialSessionSettings("high", [model], { model: "gpt" })).toEqual({
      ...DEFAULT_SESSION_SETTINGS,
      model: "gpt",
      reasoningEffort: "high",
    });
  });
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
    const userArticle = screen.getByText("Сообщение").closest("article")!;
    expect(userArticle.querySelector(":scope > .message-body")?.nextElementSibling).toHaveClass(
      "message-footer",
    );
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
    const reasoningDetails = screen.getByText("Рассуждение").closest("details")!;
    expect(reasoningDetails).toHaveClass("activity-card");
    expect(screen.queryByText("Проверяю")).toBeNull();
    fireEvent.click(reasoningDetails.querySelector("summary")!);
    fireEvent(reasoningDetails, new Event("toggle"));
    expect(screen.getByText("Проверяю")).toBeInTheDocument();
    expect(screen.queryByText("Ход работы")).not.toBeInTheDocument();
  });

  it("stops animating unfinished steps when their checklist is no longer active", () => {
    const item = {
      type: "planChecklist" as const,
      id: "checklist",
      status: "inProgress" as const,
      explanation: "Проверяю",
      steps: [
        { step: "Готово", status: "completed" as const },
        { step: "Остановлено", status: "inProgress" as const },
        { step: "Позже", status: "pending" as const },
      ],
      timestamp: 1,
      afterItemId: null,
    };
    const view = render(<Activity item={item} />);

    expect(screen.getByText("Остановлено").closest("li")).toHaveClass("inProgress");
    expect(view.container.querySelector(".plan-checklist .spinner")).not.toBeNull();

    view.rerender(<Activity item={{ ...item, status: "completed" }} />);

    expect(screen.getByText("Готово").closest("li")).toHaveClass("completed");
    expect(screen.getByText("Остановлено").closest("li")).toHaveClass("pending");
    expect(view.container.querySelector(".plan-checklist .spinner")).toBeNull();
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

  it("preserves horizontal table scroll while a message is streaming", () => {
    const item = {
      type: "agentMessage" as const,
      id: "streaming-markdown",
      status: "inProgress" as const,
      text: "| Поле | Значение |\n| --- | --- |\n| Статус | Готово |\n\nНачало ответа",
      images: [],
      timestamp: null,
      phase: "commentary" as const,
    };
    const view = render(<Activity item={item} />);
    const tableScroll = view.container.querySelector<HTMLDivElement>(".markdown-table-scroll")!;
    tableScroll.scrollLeft = 180;

    view.rerender(<Activity item={{ ...item, text: `${item.text}\n\nНовый фрагмент` }} />);

    expect(view.container.querySelector(".markdown-table-scroll")).toBe(tableScroll);
    expect(tableScroll.scrollLeft).toBe(180);
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

  it("renders delivered subagent results as links in the timeline", () => {
    render(
      <MemoryRouter>
        <Activity
          item={{
            type: "orchestrationNotice",
            id: "orchestration",
            status: "completed",
            agents: [
              {
                threadId: "child",
                title: "Проверить интерфейс",
                nickname: "reviewer",
                outcome: "completed",
              },
            ],
            timestamp: Date.now(),
            afterItemId: null,
          }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Получен результат субагента")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "reviewer · Проверить интерфейс" })).toHaveAttribute(
      "href",
      "/threads/child",
    );
    expect(screen.getByText("Завершена")).toBeInTheDocument();
  });

  it("renders rich subagent results compactly with an accessible status and child link", () => {
    render(
      <MemoryRouter>
        <Activity
          item={{
            type: "orchestrationNotice",
            id: "orchestration-v2",
            status: "completed",
            agents: [
              {
                threadId: "child/v2",
                taskId: "task-v2",
                title: "Проверить интерфейс",
                nickname: "reviewer",
                outcome: "completed",
                result: {
                  outcome: "partial",
                  summary: "Карточка обновлена без отдельной панели.",
                  checks: [
                    { name: "Тесты клиента", outcome: "passed", details: "12 тестов" },
                    { name: "Снимок экрана", outcome: "notRun" },
                  ],
                },
                budgetReason: "tokenBudget",
                failureReason: "Визуальная проверка недоступна.",
                changedPaths: ["apps/client/src/components/ThreadPage.tsx"],
                changedPathCount: 24,
                workspaceIntegrationStatus: "integrated",
              },
            ],
            timestamp: Date.now(),
            afterItemId: null,
          }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "reviewer · Проверить интерфейс" })).toHaveAttribute(
      "href",
      "/threads/child%2Fv2",
    );
    expect(screen.getByLabelText("Статус результата: Частично")).toHaveTextContent("Частично");
    expect(screen.getByText("Карточка обновлена без отдельной панели.")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Проверки результата" })).toHaveTextContent(
      "Тесты клиентаПройдена12 тестовСнимок экранаНе запускалась",
    );
    expect(screen.getByText("Лимит").closest("div")).toHaveTextContent("Исчерпан бюджет токенов");
    expect(screen.getByText("Визуальная проверка недоступна.")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Изменённые файлы" })).toHaveTextContent(
      "apps/client/src/components/ThreadPage.tsx",
    );
    expect(screen.getByText("Показано 1 из 24")).toBeInTheDocument();
    expect(screen.getByText("Изменения интегрированы")).toBeInTheDocument();
  });

  it("falls back to the v1 outcome for a malformed partial rich result", () => {
    render(
      <MemoryRouter>
        <Activity
          item={
            {
              type: "orchestrationNotice",
              id: "orchestration-partial-result",
              status: "completed",
              agents: [
                {
                  threadId: "child",
                  title: "Legacy-compatible result",
                  nickname: null,
                  outcome: "completed",
                  result: { summary: "Outcome was omitted." },
                },
              ],
              timestamp: Date.now(),
              afterItemId: null,
            } as ActivityItem
          }
        />
      </MemoryRouter>,
    );

    expect(screen.getByLabelText("Статус результата: Завершена")).toHaveTextContent("Завершена");
  });

  it("renders a successful subagent launch as a linked orchestration card", () => {
    render(
      <MemoryRouter>
        <Activity
          item={{
            type: "subagentLaunch",
            id: "launch",
            status: "completed",
            title: "Проверить интерфейс",
            threadId: "child",
          }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Запущен субагент")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Проверить интерфейс" })).toHaveAttribute(
      "href",
      "/threads/child",
    );
    expect(screen.getByText("Запущен субагент").closest("article")).toHaveClass(
      "orchestration-notice",
    );
  });

  it("renders pending and failed subagent launches without broken links", () => {
    const view = render(
      <MemoryRouter>
        <Activity
          item={{
            type: "subagentLaunch",
            id: "launch",
            status: "inProgress",
            title: "Проверить интерфейс",
            threadId: null,
          }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Запуск субагента")).toBeInTheDocument();
    expect(screen.getByText("Выполняется")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();

    view.rerender(
      <MemoryRouter>
        <Activity
          item={{
            type: "subagentLaunch",
            id: "launch",
            status: "failed",
            title: "Проверить интерфейс",
            threadId: null,
          }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Не удалось запустить субагента")).toBeInTheDocument();
    expect(screen.getByText("Ошибка")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "Открыть изображение 1" })).toBeInTheDocument();
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
    const commandDetails = screen.getByText("npm test").closest("details")!;
    expect(commandDetails).toHaveClass("activity-card");
    expect(within(commandDetails).getByText("готово")).toHaveClass("sr-only");
    expect(commandDetails.querySelector(".activity-status svg")).not.toBeNull();
    fireEvent.click(within(commandDetails).getByText("npm test"));
    fireEvent(commandDetails, new Event("toggle"));
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
    const fileDetails = screen.getByText("Изменён src/App.tsx").closest("details")!;
    fileDetails.open = true;
    fireEvent(fileDetails, new Event("toggle"));
    expect(screen.getByText("+new line")).toBeInTheDocument();
  });

  it("keeps important compact activity states visible", () => {
    const item = {
      type: "command" as const,
      id: "command",
      kind: "command" as const,
      command: "npm test",
      cwd: "/work",
      output: "",
      exitCode: null,
    };
    const view = render(<Activity item={{ ...item, status: "inProgress" }} />);
    expect(screen.getByText("выполняется")).toBeVisible();

    view.rerender(<Activity item={{ ...item, status: "failed" }} />);
    expect(screen.getByText("ошибка")).toBeVisible();
  });

  it("shows failed activity only after its group is expanded", () => {
    const api = threadApi();
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
              type: "command",
              id: "failed-command",
              status: "failed",
              kind: "command",
              command: "npm test",
              cwd: "/work/project",
              output: "1 test failed",
              exitCode: 1,
            },
          ],
        },
      ],
    });
    renderThread();

    const groupSummary = screen.getByLabelText("Технические детали");
    const group = groupSummary.closest("details")!;

    expect(group).not.toHaveAttribute("open");
    expect(screen.getByText("Готово за 0с").closest("summary")).toBe(groupSummary);
    expect(groupSummary).not.toHaveTextContent("Ошибка");
    expect(within(group).queryByText("ошибка")).toBeNull();

    fireEvent.click(groupSummary);
    fireEvent(group, new Event("toggle"));

    expect(within(group).getByText("ошибка")).toBeVisible();
  });

  it("loads technical turn items only when their details are expanded", async () => {
    const api = threadApi();
    const context = mockThreadConnection(api, summary, {
      turns: [
        {
          id: "turn",
          status: "completed",
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
          progress: progress(),
          itemsLoaded: false,
          items: [
            {
              type: "agentMessage",
              id: "answer",
              status: "completed",
              text: "Готово",
              images: [],
              timestamp: 2,
              phase: "final_answer",
            },
          ],
        },
      ],
    });
    renderThread();

    expect(context.loadTurnItems).not.toHaveBeenCalled();
    const summaryRow = screen.getByLabelText("Технические детали");
    expect(screen.getByText("Готово за 0с").closest("summary")).toBe(summaryRow);
    fireEvent.click(summaryRow);
    await waitFor(() => expect(context.loadTurnItems).toHaveBeenCalledWith("thread", "turn"));
    fireEvent.click(summaryRow);
    fireEvent.click(summaryRow);
    expect(context.loadTurnItems).toHaveBeenCalledTimes(1);
  });

  it("keeps lazy-load retry inline", async () => {
    const context = mockThreadConnection(threadApi(), summary, {
      turns: [
        {
          id: "turn",
          status: "failed",
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
          progress: progress(),
          itemsLoaded: false,
          items: [],
        },
      ],
    });
    context.loadTurnItems
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    renderThread();

    fireEvent.click(screen.getByLabelText("Технические детали"));
    fireEvent.click(await screen.findByText("Повторить загрузку технических деталей"));
    await waitFor(() => expect(context.loadTurnItems).toHaveBeenCalledTimes(2));
  });

  it("keeps an opened activity journal open through streamed items", () => {
    const context = mockThreadConnection(threadApi(), summary, {
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
              type: "command",
              id: "command",
              status: "completed",
              kind: "command",
              command: "npm test",
              cwd: "/work",
              output: "passed",
              exitCode: 0,
            },
          ],
        },
      ],
    });
    const view = renderThread();
    const disclosure = screen.getByLabelText("Технические детали").closest("details")!;
    disclosure.open = true;
    fireEvent(disclosure, new Event("toggle"));
    expect(screen.getByText("npm test")).toBeInTheDocument();

    const currentTurn = context.state.details.thread.turns[0]!;
    context.state.details.thread = {
      ...context.state.details.thread,
      turns: [
        {
          ...currentTurn,
          items: [
            ...currentTurn.items,
            {
              type: "tool",
              id: "streamed-tool",
              status: "inProgress",
              title: "Проверка окружения",
              detail: "Детали проверки",
            },
          ],
        },
      ],
    };
    view.rerender(threadRoute());

    expect(disclosure).toHaveAttribute("open");
    expect(screen.getByText("Проверка окружения")).toBeInTheDocument();
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

  it("copies fenced code blocks separately from the whole message", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <Activity
        item={{
          type: "agentMessage",
          id: "agent",
          status: "completed",
          text: "Готовый промпт:\n\n```text\nПервая строка\nВторая строка\n```\n\n`inline`",
          images: [],
          timestamp: 1,
          phase: "final_answer",
        }}
      />,
    );

    expect(screen.getAllByRole("button", { name: "Копировать блок" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Копировать блок" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Первая строка\nВторая строка"));
    expect(screen.getByRole("button", { name: "Блок скопирован" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Копировать сообщение" })).toBeInTheDocument();
  });

  it("keeps a fenced code selection after showing annotation actions", async () => {
    render(
      <Activity
        item={{
          type: "agentMessage",
          id: "agent",
          status: "completed",
          text: "```text\nВыделенный кодовый фрагмент\n```",
          images: [],
          timestamp: 1,
          phase: "final_answer",
        }}
        annotationEnabled
      />,
    );

    const code = screen.getByText("Выделенный кодовый фрагмент");
    selectText(code, 0, 10);
    fireEvent.pointerUp(code);

    expect(await screen.findByRole("button", { name: "Аннотация" })).toBeInTheDocument();
    expect(screen.getByText("Выделенный кодовый фрагмент")).toBe(code);
    expect(window.getSelection()?.toString()).toBe("Выделенный");
    expect(window.getSelection()?.anchorNode?.isConnected).toBe(true);
  });

  it("creates an annotation from an exact text selection", async () => {
    const onCreate = vi.fn().mockReturnValue(true);
    render(
      <Activity
        item={{
          type: "agentMessage",
          id: "agent",
          status: "completed",
          text: "Выделенный фрагмент ответа",
          images: [],
          timestamp: 1,
          phase: "final_answer",
        }}
        annotationEnabled
        onCreateAnnotation={onCreate}
      />,
    );

    const text = screen.getByText("Выделенный фрагмент ответа");
    selectText(text, 0, 10);
    fireEvent.pointerUp(text);
    fireEvent.click(await screen.findByRole("button", { name: "Аннотация" }));
    expect(screen.queryByText("Новая аннотация")).toBeNull();
    expect(screen.getByPlaceholderText("Комментарий")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Сохранить аннотацию" })).toHaveTextContent("");
    expect(screen.getByRole("button", { name: "Удалить аннотацию" })).toHaveTextContent("");
    fireEvent.change(screen.getByRole("textbox", { name: "Комментарий к выделенному тексту" }), {
      target: { value: "Перепроверь это" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить аннотацию" }));

    expect(onCreate).toHaveBeenCalledWith({
      messageId: "agent",
      source: "agentMessage",
      quote: "Выделенный",
      startOffset: 0,
      endOffset: 10,
      comment: "Перепроверь это",
    });
  });

  it("copies only the selected fragment", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <Activity
        item={{
          type: "agentMessage",
          id: "agent",
          status: "completed",
          text: "Скопируй только это",
          images: [],
          timestamp: 1,
          phase: "final_answer",
        }}
        annotationEnabled
      />,
    );

    const text = screen.getByText("Скопируй только это");
    selectText(text, 9, 15);
    fireEvent.pointerUp(text);
    fireEvent.click(await screen.findByRole("button", { name: "Копировать" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("только"));
  });

  it("places selection actions below the selected range", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () =>
        ({
          top: 100,
          bottom: 120,
          left: 40,
          right: 80,
          width: 40,
          height: 20,
          x: 40,
          y: 100,
          toJSON: () => ({}),
        }) satisfies DOMRect,
    });
    try {
      render(
        <Activity
          item={{
            type: "agentMessage",
            id: "agent",
            status: "completed",
            text: "Выделение снизу",
            images: [],
            timestamp: 1,
            phase: "final_answer",
          }}
          annotationEnabled
        />,
      );

      const text = screen.getByText("Выделение снизу");
      selectText(text, 0, 9);
      fireEvent.pointerUp(text);

      expect((await screen.findByRole("button", { name: "Аннотация" })).parentElement).toHaveStyle({
        top: "128px",
      });
    } finally {
      if (descriptor) Object.defineProperty(Range.prototype, "getBoundingClientRect", descriptor);
      else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    }
  });

  it("edits and deletes an annotation through its numbered marker", async () => {
    const onUpdate = vi.fn().mockReturnValue(true);
    const onDelete = vi.fn().mockReturnValue(true);
    const annotation: PendingAnnotation = {
      id: "note",
      messageId: "agent",
      source: "agentMessage",
      quote: "фрагментом",
      startOffset: 8,
      endOffset: 18,
      comment: "Старый комментарий",
      createdAt: 1,
    };
    render(
      <Activity
        item={{
          type: "agentMessage",
          id: "agent",
          status: "completed",
          text: "Ответ с фрагментом",
          images: [],
          timestamp: 1,
          phase: "final_answer",
        }}
        annotations={[annotation]}
        onUpdateAnnotation={onUpdate}
        onDeleteAnnotation={onDelete}
      />,
    );

    const marker = await screen.findByRole("button", { name: "Аннотация 1" });
    fireEvent.click(marker);
    const editor = screen.getByRole("textbox", { name: "Комментарий к выделенному тексту" });
    expect(editor).toHaveValue("Старый комментарий");
    fireEvent.change(editor, { target: { value: "Новый комментарий" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить аннотацию" }));
    expect(onUpdate).toHaveBeenCalledWith("note", "Новый комментарий");

    fireEvent.click(marker);
    fireEvent.click(screen.getByRole("button", { name: "Удалить аннотацию" }));
    expect(onDelete).toHaveBeenCalledWith("note");
  });

  it("saves a non-empty new annotation on outside click and discards an empty one", async () => {
    const onCreate = vi.fn().mockReturnValue(true);
    render(
      <Activity
        item={{
          type: "agentMessage",
          id: "agent",
          status: "completed",
          text: "Фрагмент для пометки",
          images: [],
          timestamp: 1,
          phase: "final_answer",
        }}
        annotationEnabled
        onCreateAnnotation={onCreate}
      />,
    );

    const text = screen.getByText("Фрагмент для пометки");
    selectText(text, 0, 8);
    fireEvent.pointerUp(text);
    fireEvent.click(await screen.findByRole("button", { name: "Аннотация" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Комментарий к выделенному тексту" }), {
      target: { value: "Сохранить снаружи" },
    });
    fireEvent.pointerDown(document.body);

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ quote: "Фрагмент", comment: "Сохранить снаружи" }),
    );
    expect(screen.queryByRole("textbox", { name: "Комментарий к выделенному тексту" })).toBeNull();

    selectText(text, 9, 12);
    fireEvent.pointerUp(text);
    fireEvent.click(await screen.findByRole("button", { name: "Аннотация" }));
    fireEvent.pointerDown(document.body);

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("textbox", { name: "Комментарий к выделенному тексту" })).toBeNull();
  });

  it("does not erase an existing annotation when its input is cleared and closed outside", async () => {
    const onUpdate = vi.fn().mockReturnValue(true);
    const annotation: PendingAnnotation = {
      id: "note",
      messageId: "agent",
      source: "agentMessage",
      quote: "фрагментом",
      startOffset: 8,
      endOffset: 18,
      comment: "Сохранённый комментарий",
      createdAt: 1,
    };
    render(
      <Activity
        item={{
          type: "agentMessage",
          id: "agent",
          status: "completed",
          text: "Ответ с фрагментом",
          images: [],
          timestamp: 1,
          phase: "final_answer",
        }}
        annotations={[annotation]}
        onUpdateAnnotation={onUpdate}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Аннотация 1" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Комментарий к выделенному тексту" }), {
      target: { value: "" },
    });
    fireEvent.pointerDown(document.body);

    expect(onUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Аннотация 1" })).toBeInTheDocument();
  });

  it("keeps the editor open when saving on an outside click fails", async () => {
    const onCreate = vi.fn().mockReturnValue(false);
    render(
      <Activity
        item={{
          type: "agentMessage",
          id: "agent",
          status: "completed",
          text: "Фрагмент с ошибкой",
          images: [],
          timestamp: 1,
          phase: "final_answer",
        }}
        annotationEnabled
        onCreateAnnotation={onCreate}
      />,
    );

    const text = screen.getByText("Фрагмент с ошибкой");
    selectText(text, 0, 8);
    fireEvent.pointerUp(text);
    fireEvent.click(await screen.findByRole("button", { name: "Аннотация" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Комментарий к выделенному тексту" }), {
      target: { value: "Не потерять" },
    });
    fireEvent.pointerDown(document.body);

    expect(onCreate).toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Комментарий к выделенному тексту" })).toHaveValue(
      "Не потерять",
    );
  });

  it("shows a live turn timer and a final duration", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-21T12:00:05Z"));
      const runningSummary = {
        ...summary,
        state: "running" as const,
        currentTurnId: "running",
      };
      const running = {
        id: "running",
        status: "inProgress" as const,
        startedAt: Date.now() - 5_000,
        completedAt: null,
        durationMs: null,
        progress: { ...progress(), explanation: "  Проверяю изменения  " },
        items: [],
      };
      const context = mockThreadConnection(threadApi(), runningSummary, { turns: [running] });
      const view = renderThread();
      expect(screen.getByRole("status")).toHaveTextContent("Проверяю изменения");
      expect(screen.getByText("5с")).toHaveAttribute("aria-live", "off");
      act(() => vi.advanceTimersByTime(2_000));
      expect(screen.getByText("7с")).toBeInTheDocument();

      const completedSummary = { ...summary, state: "completed" as const };
      context.state.snapshot.threads = [completedSummary];
      context.state.details.thread = {
        ...context.state.details.thread,
        summary: completedSummary,
        turns: [
          {
            ...running,
            status: "completed",
            completedAt: running.startedAt + 8_000,
            durationMs: 8_000,
          },
        ],
      };
      view.rerender(threadRoute());
      expect(screen.getByText("Готово за 8с")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses outcome-specific labels with and without durations", () => {
    mockThreadConnection(threadApi(), summary, {
      turns: [
        {
          id: "completed",
          status: "completed",
          startedAt: 1_000,
          completedAt: 4_000,
          durationMs: 3_000,
          progress: progress(),
          items: [],
        },
        {
          id: "failed",
          status: "failed",
          startedAt: 1_000,
          completedAt: 5_000,
          durationMs: 4_000,
          progress: progress(),
          items: [],
        },
        {
          id: "interrupted",
          status: "interrupted",
          startedAt: null,
          completedAt: null,
          durationMs: null,
          progress: { ...progress(), startedAt: null },
          items: [],
        },
      ],
    });
    renderThread();

    expect(screen.getByText("Готово за 3с")).toBeInTheDocument();
    expect(screen.getByText("Ошибка через 4с")).toBeInTheDocument();
    expect(screen.getByText("Прервано")).toBeInTheDocument();
    expect(screen.queryByLabelText("Технические детали")).toBeNull();
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

  it("loads task-local Markdown images through a download ticket", async () => {
    const api = threadApi();
    api.createDownload.mockResolvedValueOnce({
      downloadUrl: "/downloads/ticket/chart.png",
      expiresAt: 61_000,
      fileName: "chart.png",
      size: 3,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const createObjectURL = vi.fn(() => "blob:https://codex.home.arpa/chart");
    const revokeObjectURL = vi.fn();
    const ObjectUrl = class extends URL {};
    Object.defineProperties(ObjectUrl, {
      createObjectURL: { value: createObjectURL },
      revokeObjectURL: { value: revokeObjectURL },
    });
    vi.stubGlobal("URL", ObjectUrl);
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
              text: "![График](</work/project/artifacts/chart.png>)",
              images: [],
              timestamp: 2,
              phase: "final_answer",
            },
          ],
        },
      ],
    });

    const view = renderThread();

    await waitFor(() =>
      expect(api.createDownload).toHaveBeenCalledWith(
        "thread",
        "/work/project/artifacts/chart.png",
      ),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(api.createDownload).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://codex.home.arpa/downloads/ticket/chart.png",
    );
    expect(fetchMock.mock.calls[0]![1]).toEqual({ cache: "no-store" });
    const preview = await screen.findByRole("button", { name: "Открыть изображение График" });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(screen.getByRole("img", { name: "График" })).toHaveAttribute(
      "src",
      "blob:https://codex.home.arpa/chart",
    );

    fireEvent.click(preview);
    expect(await screen.findByRole("dialog", { name: "Просмотр изображений" })).toBeInTheDocument();
    expect(api.createDownload).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:https://codex.home.arpa/chart");
  });

  it("shows a retryable error when a file ticket cannot be issued", async () => {
    const api = threadApi();
    api.createDownload
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce({ downloadUrl: "/downloads/retry/file.bin", expiresAt: 61_000 });
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
              text: "[Скачать файл](/work/project/file.bin)",
              images: [],
              timestamp: 2,
              phase: "final_answer",
            },
          ],
        },
      ],
    });
    renderThread();

    const downloadLink = screen.getByRole("link", { name: "Скачать файл" });
    fireEvent.click(downloadLink);
    expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось скачать файл");

    fireEvent.click(downloadLink);
    await waitFor(() => expect(openDownloadUrl).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("opens previewable agent files inline and keeps unsupported files downloadable", async () => {
    const api = threadApi();
    api.createDownload
      .mockResolvedValueOnce({
        downloadUrl: "/downloads/ticket/report.md",
        expiresAt: 61_000,
        fileName: "report.md",
        size: 8,
      })
      .mockResolvedValueOnce({
        downloadUrl: "/downloads/ticket/report.md",
        expiresAt: 61_000,
        fileName: "report.md",
        size: 8,
      });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("# Report", { status: 200 })));
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
              text: "[universe.rs:183](/work/project/src/universe.rs)\n[Готовый отчёт](/work/project/output/report.md)",
              images: [],
              timestamp: 2,
              phase: "final_answer",
            },
          ],
        },
      ],
    });
    renderThread();

    expect(screen.getByRole("link", { name: "universe.rs:183" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Открыть report.md" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Скачать report.md" }));
    await waitFor(() =>
      expect(openDownloadUrl).toHaveBeenCalledWith(
        "https://codex.home.arpa",
        "/downloads/ticket/report.md",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Открыть report.md" }));
    expect(await screen.findByRole("heading", { name: "Report" })).toBeInTheDocument();
    expect(screen.getByText("Готовый отчёт")).toBeInTheDocument();
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
    const renameDialog = screen.getByRole("dialog", { name: "Переименовать" });
    const renameInput = within(renameDialog).getByRole("textbox", { name: "Название" });
    expect(renameInput).toHaveFocus();
    fireEvent.change(renameInput, {
      target: { value: "Новое имя" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(api.updateThread).toHaveBeenCalledWith("thread", { name: "Новое имя" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Архивировать" }));
    expect(api.archive).toHaveBeenCalledWith("thread", true);
  });

  it.each([
    ["disabled", "Включить браузер", "Включить браузер", "false"],
    ["disconnected", "Браузер включён", "Выключить браузер", "true"],
    ["connected", "Браузер подключён", "Выключить браузер", "true"],
  ] as const)(
    "shows the %s browser state as a single accessible header button",
    (browserStatus, visibleLabel, accessibleLabel, pressed) => {
      const api = threadApi();
      mockThreadConnection(api, { ...summary, browserStatus });
      renderThread();

      const button = screen.getByRole("button", { name: accessibleLabel });
      expect(button).toHaveTextContent(visibleLabel);
      expect(button).toHaveAttribute("aria-pressed", pressed);
      expect(button).toHaveClass(`browser-session-status-${browserStatus}`);
      expect(button).toHaveAttribute("title", accessibleLabel);
    },
  );

  it("waits for the browser update response, dispatches it, and blocks a second request", async () => {
    const api = threadApi();
    const browserThread = { ...summary, browserStatus: "disabled" as const };
    const updatedThread = { ...browserThread, browserStatus: "disconnected" as const };
    let resolveUpdate: ((thread: ThreadSummary) => void) | undefined;
    api.updateThread.mockImplementationOnce(
      () => new Promise<ThreadSummary>((resolve) => (resolveUpdate = resolve)),
    );
    const context = mockThreadConnection(api, browserThread);
    renderThread();

    const button = screen.getByRole("button", { name: "Включить браузер" });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(api.updateThread).toHaveBeenCalledOnce();
    expect(api.updateThread).toHaveBeenCalledWith("thread", { browserEnabled: true });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveTextContent("Включить браузер");
    expect(context.dispatch).not.toHaveBeenCalled();

    await act(async () => resolveUpdate?.(updatedThread));

    expect(context.dispatch).toHaveBeenCalledWith({ type: "thread", thread: updatedThread });
  });

  it("requests browser opt-out from a pressed state", async () => {
    const api = threadApi();
    const browserThread = { ...summary, browserStatus: "connected" as const };
    const updatedThread = { ...browserThread, browserStatus: "disabled" as const };
    api.updateThread.mockResolvedValueOnce(updatedThread);
    const context = mockThreadConnection(api, browserThread);
    renderThread();

    fireEvent.click(screen.getByRole("button", { name: "Выключить браузер" }));

    await waitFor(() =>
      expect(api.updateThread).toHaveBeenCalledWith("thread", { browserEnabled: false }),
    );
    expect(context.dispatch).toHaveBeenCalledWith({ type: "thread", thread: updatedThread });
  });

  it.each([
    ["active turn", "idle", "active-turn"],
    ["running state", "running", null],
    ["queued state", "queued", null],
    ["attention state", "needsAttention", null],
  ] as const)("locks browser switching for %s", (_label, state, currentTurnId) => {
    const api = threadApi();
    mockThreadConnection(api, { ...summary, state, currentTurnId });
    renderThread();

    const button = screen.getByRole("button", { name: "Включить браузер" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute(
      "title",
      "Дождитесь завершения текущего хода, чтобы изменить доступ браузера",
    );
    fireEvent.click(button);
    expect(api.updateThread).not.toHaveBeenCalled();
  });

  it.each([
    ["archived", { archived: true }],
    [
      "subagent",
      {
        relation: {
          kind: "subagent" as const,
          sessionId: "session",
          parentThreadId: "parent",
          nickname: null,
          role: null,
        },
      },
    ],
  ])("hides browser switching for %s sessions", (_label, patch) => {
    const api = threadApi();
    mockThreadConnection(api, { ...summary, ...patch });
    renderThread();

    expect(screen.queryByRole("button", { name: "Включить браузер" })).not.toBeInTheDocument();
  });

  it("blocks an exact duplicate of the active turn user message and preserves the draft", async () => {
    const api = threadApi();
    const running = { ...summary, state: "running" as const, currentTurnId: "active-turn" };
    mockThreadConnection(api, running, {
      turns: [
        {
          id: "active-turn",
          status: "inProgress",
          startedAt: 1,
          completedAt: null,
          durationMs: null,
          progress: progress(),
          items: [
            {
              type: "userMessage",
              id: "active-message",
              status: "completed",
              text: "Повтори проверку",
              images: [],
              timestamp: 1,
              phase: null,
            },
          ],
        },
      ],
    });
    renderThread();
    const textarea = screen.getByRole("textbox", { name: "Направить текущую задачу" });

    fireEvent.change(textarea, { target: { value: "  Повтори проверку  " } });
    fireEvent.click(screen.getByRole("button", { name: "Добавить в очередь" }));

    expect(await screen.findByText("Это сообщение уже отправлено")).toBeInTheDocument();
    expect(textarea).toHaveValue("  Повтори проверку  ");
    expect(api.startTurn).not.toHaveBeenCalled();
    expect(api.enqueue).not.toHaveBeenCalled();
    expect(api.updateThreadSettings).not.toHaveBeenCalled();
  });

  it("treats the latest root user message as active while a Team parent runs between turns", async () => {
    const api = threadApi();
    const teamParent = {
      ...summary,
      state: "running" as const,
      settings: { collaborationMode: "team" as const },
    };
    mockThreadConnection(api, teamParent, {
      turns: [
        {
          id: "root-turn",
          status: "completed",
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
          progress: progress(),
          items: [
            {
              type: "userMessage",
              id: "root-message",
              status: "completed",
              text: "Оркестрируй задачу",
              images: [],
              timestamp: 1,
              phase: null,
            },
          ],
        },
      ],
    });
    renderThread();
    const textarea = screen.getByRole("textbox", { name: "Направить текущую задачу" });

    fireEvent.change(textarea, { target: { value: "Оркестрируй задачу" } });
    fireEvent.click(screen.getByRole("button", { name: "Добавить в очередь" }));

    expect(await screen.findByText("Это сообщение уже отправлено")).toBeInTheDocument();
    expect(textarea).toHaveValue("Оркестрируй задачу");
    expect(api.startTurn).not.toHaveBeenCalled();
    expect(api.enqueue).not.toHaveBeenCalled();
  });

  it.each(["queued", "optimistic"] as const)(
    "blocks an exact duplicate of an active %s message",
    async (source) => {
      const api = threadApi();
      const context = mockThreadConnection(api, summary, {
        queuedMessages:
          source === "queued"
            ? [
                {
                  id: "queued-message",
                  threadId: "thread",
                  text: "Не дублируй",
                  images: [],
                  createdAt: 1,
                  status: "queued",
                },
              ]
            : [],
      });
      if (source === "optimistic") {
        context.state.optimisticMessages.thread = [
          {
            id: "optimistic-message",
            threadId: "thread",
            text: "Не дублируй",
            images: [],
            createdAt: 1,
            destination: "queue",
            turnId: null,
          },
        ];
      }
      renderThread();
      const textarea = screen.getByRole("textbox", { name: "Сообщение для Codex" });
      fireEvent.change(textarea, { target: { value: "Не дублируй" } });

      fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

      expect(await screen.findByText("Это сообщение уже отправлено")).toBeInTheDocument();
      expect(api.startTurn).not.toHaveBeenCalled();
      expect(textarea).toHaveValue("Не дублируй");
    },
  );

  it("allows a completed message to be sent again", async () => {
    const api = threadApi();
    mockThreadConnection(api, summary, {
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
              type: "userMessage",
              id: "completed-message",
              status: "completed",
              text: "Запусти снова",
              images: [],
              timestamp: 1,
              phase: null,
            },
          ],
        },
      ],
    });
    renderThread();

    fireEvent.change(screen.getByRole("textbox", { name: "Сообщение для Codex" }), {
      target: { value: "Запусти снова" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    await waitFor(() =>
      expect(api.startTurn).toHaveBeenCalledWith(
        "thread",
        expect.objectContaining({ input: "Запусти снова" }),
      ),
    );
  });

  it("acknowledges the thread notification as soon as its route opens", async () => {
    mockThreadConnection(threadApi(), summary);

    const view = renderThread();

    await waitFor(() => expect(acknowledgePendingThread).toHaveBeenCalledWith("thread"));
    expect(acknowledgePendingThread).toHaveBeenCalledOnce();

    view.unmount();
    expect(releaseActiveThread).toHaveBeenCalledWith("thread");
  });

  it("sends annotation-only drafts as a visible user message and clears them on success", async () => {
    const api = threadApi();
    const annotation = pendingAnnotation();
    localStorage.setItem(annotationStorageKey("thread"), JSON.stringify([annotation]));
    const context = mockThreadConnection(api, summary, {
      turns: [completedAgentTurn()],
    });
    renderThread();

    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    await waitFor(() =>
      expect(api.startTurn).toHaveBeenCalledWith(
        "thread",
        expect.objectContaining({
          input: expect.stringContaining("## Аннотации к предыдущему ответу агента"),
          clientMessageId: expect.any(String),
        }),
      ),
    );
    expect(api.startTurn.mock.calls[0]?.[1].input).toContain("> фрагмент ответа");
    expect(api.startTurn.mock.calls[0]?.[1].input).toContain("Уточни формулировку");
    expect(
      context.dispatch.mock.calls.find(([action]) => action.type === "optimistic.add")?.[0].message
        .text,
    ).toContain("### Аннотация 1");
    await waitFor(() => expect(localStorage.getItem(annotationStorageKey("thread"))).toBeNull());
  });

  it("persists a comment on the server and restores it from the numbered marker", async () => {
    const api = threadApi();
    mockThreadConnection(api, summary, { turns: [completedAgentTurn()] });
    renderThread();

    const text = screen.getByText("Готовый фрагмент ответа");
    selectText(text, 8, 16);
    fireEvent.pointerUp(text);
    fireEvent.click(await screen.findByRole("button", { name: "Аннотация" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Комментарий к выделенному тексту" }), {
      target: { value: "Локальный комментарий" },
    });
    fireEvent.pointerDown(document.body);

    const marker = await screen.findByRole("button", { name: "Аннотация 1" });
    await waitFor(() =>
      expect(api.updateThreadDraft).toHaveBeenCalledWith(
        "thread",
        expect.objectContaining({
          annotations: [expect.objectContaining({ comment: "Локальный комментарий" })],
        }),
        { keepalive: false },
      ),
    );
    fireEvent.click(marker);
    expect(screen.getByRole("textbox", { name: "Комментарий к выделенному тексту" })).toHaveValue(
      "Локальный комментарий",
    );
  });

  it("keeps server-backed annotations when sending fails", async () => {
    const api = threadApi();
    api.startTurn.mockRejectedValueOnce(new Error("Сеть недоступна"));
    const annotation = pendingAnnotation();
    localStorage.setItem(annotationStorageKey("thread"), JSON.stringify([annotation]));
    mockThreadConnection(api, summary, { turns: [completedAgentTurn()] });
    renderThread();

    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    expect(await screen.findByText("Сеть недоступна")).toBeInTheDocument();
    expect(api.updateThreadDraft).toHaveBeenCalledWith(
      "thread",
      expect.objectContaining({ annotations: [annotation] }),
      { keepalive: false },
    );
    expect(screen.getByRole("button", { name: "Аннотация 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Отправить" })).toBeEnabled();
  });

  it("offers annotation actions only on the latest completed agent response", async () => {
    const api = threadApi();
    mockThreadConnection(api, summary, {
      turns: [
        {
          ...completedAgentTurn(),
          id: "older-turn",
          items: [{ ...completedAgentTurn().items[0]!, id: "older", text: "Старый ответ" }],
        },
        {
          ...completedAgentTurn(),
          id: "latest-turn",
          items: [{ ...completedAgentTurn().items[0]!, id: "latest", text: "Новый ответ" }],
        },
      ],
    });
    renderThread();

    const older = screen.getByText("Старый ответ");
    selectText(older, 0, 6);
    fireEvent.pointerUp(older);
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 100)));
    expect(screen.queryByRole("button", { name: "Аннотация" })).toBeNull();

    const latest = screen.getByText("Новый ответ");
    selectText(latest, 0, 5);
    fireEvent.pointerUp(latest);
    expect(await screen.findByRole("button", { name: "Аннотация" })).toBeInTheDocument();
  });

  it("queues annotation-only drafts and clears them after queue acceptance", async () => {
    const api = threadApi();
    const annotation = pendingAnnotation();
    localStorage.setItem(annotationStorageKey("thread"), JSON.stringify([annotation]));
    const running = { ...summary, state: "running" as const, currentTurnId: "running-turn" };
    mockThreadConnection(api, running, {
      turns: [
        completedAgentTurn(),
        {
          id: "running-turn",
          status: "inProgress",
          startedAt: 3,
          completedAt: null,
          durationMs: null,
          progress: progress(),
          items: [],
        },
      ],
    });
    renderThread();

    fireEvent.click(screen.getByRole("button", { name: "Добавить в очередь" }));

    await waitFor(() =>
      expect(api.enqueue).toHaveBeenCalledWith(
        "thread",
        expect.objectContaining({ input: expect.stringContaining("### Аннотация 1") }),
      ),
    );
    expect(localStorage.getItem(annotationStorageKey("thread"))).toBeNull();
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

  it("offers a fork only on the last non-empty completed agent reply of each completed turn", () => {
    const api = threadApi();
    const context = mockThreadConnection(api, summary, {
      turns: [
        {
          ...completedAgentTurn(),
          id: "eligible-turn",
          items: [
            { ...completedAgentTurn().items[0]!, id: "earlier", text: "Ранний ответ" },
            { ...completedAgentTurn().items[0]!, id: "last", text: "Последний ответ" },
            { ...completedAgentTurn().items[0]!, id: "empty", text: "  " },
          ],
        },
        {
          ...completedAgentTurn(),
          id: "failed-turn",
          status: "failed",
          items: [{ ...completedAgentTurn().items[0]!, id: "failed", text: "Ошибка" }],
        },
        {
          ...completedAgentTurn(),
          id: "active-turn",
          status: "inProgress",
          completedAt: null,
          items: [{ ...completedAgentTurn().items[0]!, id: "active", text: "Работаю" }],
        },
      ],
    });
    const view = renderThread();

    const fork = screen.getByRole("button", { name: "Создать ответвление отсюда" });
    expect(fork.closest("article")).toHaveTextContent("Последний ответ");
    expect(fork.closest("article")).not.toHaveTextContent("Ранний ответ");
    expect(fork.querySelector("svg")).not.toBeNull();

    const child = {
      ...summary,
      relation: {
        kind: "subagent" as const,
        sessionId: "child",
        parentThreadId: "parent",
        nickname: null,
        role: null,
      },
    };
    context.state.snapshot.threads = [child];
    context.state.details.thread.summary = child;
    view.rerender(threadRoute());
    expect(screen.queryByRole("button", { name: "Создать ответвление отсюда" })).toBeNull();
  });

  it("links a fork to its parent and shows a non-link fallback when the parent is unavailable", () => {
    const fork = {
      ...summary,
      relation: { kind: "session" as const, sessionId: "fork-tree", forkedFromId: "parent" },
    };
    const parent = { ...summary, id: "parent", title: "Родительская задача" };
    const context = mockThreadConnection(threadApi(), fork);
    context.state.snapshot.threads = [fork, parent];
    const view = renderThread();

    expect(screen.getByText("Проект")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Ответвление от Родительская задача" }),
    ).toHaveAttribute("href", "/threads/parent");

    context.state.snapshot.threads = [fork];
    view.rerender(threadRoute());

    expect(screen.queryByRole("link", { name: /Ответвление от/ })).toBeNull();
    expect(screen.getByText("Ответвление · Родитель недоступен")).toBeInTheDocument();
  });

  it("lists only direct forks by work priority, keeps archived forks last, and supports a middle node", () => {
    const middle = {
      ...summary,
      relation: {
        kind: "session" as const,
        sessionId: "fork-tree",
        forkedFromId: "grandparent",
      },
    };
    const grandparent = { ...summary, id: "grandparent", title: "Исходная задача" };
    const child = (
      id: string,
      title: string,
      state: ThreadSummary["state"],
      updatedAt: number,
      archived = false,
    ): ThreadSummary => ({
      ...summary,
      id,
      title,
      state,
      updatedAt,
      archived,
      relation: { kind: "session", sessionId: "fork-tree", forkedFromId: "thread" },
    });
    const children = [
      child("completed", "Недавно завершена", "completed", 100),
      child("queued", "В очереди", "queued", 8),
      child("running", "Выполняется", "running", 9),
      child("attention", "Нужно решение", "needsAttention", 10),
      child("idle", "Старая открытая", "idle", 7),
      child("archived", "Архивная", "completed", 1_000, true),
    ];
    const indirect = {
      ...child("grandchild", "Внук", "running", 2_000),
      relation: {
        kind: "session" as const,
        sessionId: "fork-tree",
        forkedFromId: "running",
      },
    };
    const context = mockThreadConnection(threadApi(), middle);
    context.state.snapshot.threads = [middle, grandparent, ...children, indirect];
    render(forkThreadRoute());

    expect(screen.getByRole("link", { name: "Ответвление от Исходная задача" })).toBeVisible();
    const trigger = screen.getByLabelText("Показать ответвления: 6");
    fireEvent.click(trigger);
    const popover = screen.getByText("Ответвления").parentElement!;
    const links = within(popover).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "Нужно решение",
      "Выполняется",
      "В очереди",
      "Недавно завершена",
      "Старая открытая",
      "АрхивнаяАрхив",
    ]);
    expect(within(popover).queryByText("Внук")).toBeNull();

    fireEvent.click(within(popover).getByRole("link", { name: /Нужно решение/ }));
    expect(screen.getByTestId("fork-location")).toHaveTextContent("/threads/attention:true");
  });

  it("offers a fork on a completed plan alongside both implementation choices", async () => {
    const api = threadApi();
    const planThread = {
      ...summary,
      settings: { collaborationMode: "plan" as const },
    };
    mockThreadConnection(api, planThread, completedPlanDetail());
    renderThread();

    const fork = screen.getByRole("button", { name: "Создать ответвление отсюда" });
    expect(fork.closest("article")).toHaveClass("plan");
    expect(screen.getByRole("button", { name: "Да, реализуй этот план" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Запустить в режиме оркестратора" }),
    ).toBeInTheDocument();

    fireEvent.click(fork);

    await waitFor(() =>
      expect(api.estimateFork).toHaveBeenCalledWith("thread", {
        lastTurnId: "plan-turn",
        agentMessageId: "plan",
      }),
    );
    expect(screen.getByRole("dialog", { name: "Создать ветку" })).toBeVisible();
  });

  it("creates one reliable operation, dispatches it, and navigates to the pending route", async () => {
    let resolveFork: ((value: { operation: ForkOperationSummary }) => void) | undefined;
    const api = threadApi();
    api.createForkOperation.mockReturnValue(
      new Promise<{ operation: ForkOperationSummary }>((resolve) => {
        resolveFork = resolve;
      }),
    );
    const context = mockThreadConnection(api, summary, {
      turns: [
        { ...completedAgentTurn(), id: "first-turn" },
        {
          ...completedAgentTurn(),
          id: "second-turn",
          items: [{ ...completedAgentTurn().items[0]!, id: "second-answer" }],
        },
      ],
    });
    const operation: ForkOperationSummary = {
      id: "fork-operation",
      sourceThreadId: "thread",
      lastTurnId: "second-turn",
      agentMessageId: "second-answer",
      mode: "compressed",
      status: "preparing",
      title: "",
      createdAt: 3,
      updatedAt: 3,
      targetThreadId: null,
      queuedMessageCount: 0,
      estimate: null,
      error: null,
    };
    render(forkThreadRoute());

    const buttons = screen.getAllByRole("button", { name: "Создать ответвление отсюда" });
    fireEvent.click(buttons[1]!);
    await screen.findByRole("dialog", { name: "Создать ветку" });
    await waitFor(() => expect(screen.getByRole("radio", { name: /Компактная/ })).toBeChecked());
    const create = screen.getByRole("button", { name: "Создать ветку" });
    fireEvent.click(create);
    fireEvent.click(create);
    expect(api.createForkOperation).toHaveBeenCalledOnce();
    expect(api.createForkOperation).toHaveBeenCalledWith("thread", {
      operationId: expect.any(String),
      lastTurnId: "second-turn",
      agentMessageId: "second-answer",
      mode: "compressed",
    });
    expect(create).toBeDisabled();

    await act(async () => resolveFork?.({ operation }));

    expect(context.dispatch).toHaveBeenCalledWith({ type: "forkOperation", operation });
    await waitFor(() =>
      expect(screen.getByTestId("fork-location")).toHaveTextContent(
        "/fork-operations/fork-operation:true",
      ),
    );
  });

  it("surfaces operation creation errors without navigating and restores Create", async () => {
    const api = threadApi();
    api.createForkOperation.mockRejectedValue(new Error("Не удалось создать fork"));
    mockThreadConnection(api, summary, { turns: [completedAgentTurn()] });
    render(forkThreadRoute());

    fireEvent.click(screen.getByRole("button", { name: "Создать ответвление отсюда" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: /Компактная/ })).toBeChecked());
    fireEvent.click(screen.getByRole("button", { name: "Создать ветку" }));

    expect(await screen.findByText("Не удалось создать fork")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Создать ветку" })).toBeEnabled();
    expect(screen.getByTestId("fork-location")).toHaveTextContent("/threads/thread:false");
  });

  it("treats a newer in-progress detail turn as running when the snapshot is stale", () => {
    const staleCompleted = {
      ...summary,
      state: "completed" as const,
      unread: true,
      updatedAt: 2_000,
    };
    const context = mockThreadConnection(threadApi(), staleCompleted, {
      turns: [
        {
          id: "new-turn",
          status: "inProgress",
          startedAt: 2_000,
          completedAt: null,
          durationMs: null,
          progress: { ...progress(), startedAt: 2_000 },
          items: [],
        },
      ],
    });
    context.state.details.thread.summary = {
      ...staleCompleted,
      state: "running",
      unread: false,
      updatedAt: 2_000,
      currentTurnId: "new-turn",
    };

    renderThread();

    expect(screen.queryByRole("button", { name: "Закончить" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Направить текущую задачу" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Остановить задачу" })).toBeInTheDocument();
  });

  it("keeps an interrupted session purple until the user finishes it", () => {
    const api = threadApi();
    const interrupted = {
      ...summary,
      state: "interrupted" as const,
      unread: true,
      updatedAt: 123,
    };
    const context = mockThreadConnection(api, interrupted, {
      turns: [
        {
          id: "interrupted-turn",
          status: "interrupted",
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
          progress: progress(),
          items: [],
        },
      ],
    });
    const view = renderThread();

    expect(api.markRead).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Закончить" }));
    expect(api.markRead).toHaveBeenCalledWith("thread", { observedUpdatedAt: 123 });

    const finished = { ...interrupted, unread: false };
    context.state.snapshot.threads = [finished];
    context.state.details.thread.summary = finished;
    view.rerender(threadRoute());
    expect(screen.queryByRole("button", { name: "Закончить" })).toBeNull();
  });

  it("keeps a failed session pending until the user finishes it", () => {
    const api = threadApi();
    mockThreadConnection(
      api,
      {
        ...summary,
        state: "failed",
        unread: true,
        updatedAt: 123,
      },
      {
        turns: [
          {
            id: "failed-turn",
            status: "failed",
            startedAt: 1,
            completedAt: 2,
            durationMs: 1,
            progress: progress(),
            items: [],
          },
        ],
      },
    );

    renderThread();

    expect(api.markRead).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Закончить" }));
    expect(api.markRead).toHaveBeenCalledWith("thread", { observedUpdatedAt: 123 });
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

  it("does not expose permanent session deletion", () => {
    const api = threadApi();
    mockThreadConnection(api, { ...summary, title: "Без названия", preview: "" });
    renderThread();

    fireEvent.click(screen.getByLabelText("Действия с задачей"));
    expect(screen.queryByRole("button", { name: "Удалить" })).toBeNull();
  });

  it("shows a subagent transcript as read-only and links back to its parent", () => {
    const api = threadApi();
    const child: ThreadSummary = {
      ...summary,
      title: "Worker",
      relation: {
        kind: "subagent",
        sessionId: "child-session",
        parentThreadId: "parent",
        nickname: "reviewer",
        role: "worker",
      },
    };
    const context = mockThreadConnection(api, child, {
      olderTurnsCursor: "parent-history",
      turns: [
        {
          id: "child-turn",
          status: "completed",
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
          progress: progress(),
          items: [
            {
              type: "userMessage",
              id: "input",
              status: "completed",
              text: "Проверь результат",
              images: [],
              timestamp: 1,
              phase: null,
            },
            {
              type: "reasoning",
              id: "reasoning",
              status: "completed",
              text: "Скрытое рассуждение",
              images: [],
              timestamp: 1,
              phase: null,
            },
            {
              type: "agentMessage",
              id: "commentary",
              status: "completed",
              text: "Проверяю результат",
              images: [],
              timestamp: 1,
              phase: "commentary",
            },
            {
              type: "command",
              id: "command",
              status: "completed",
              kind: "command",
              command: "npm test",
              cwd: "/work",
              output: "passed",
              exitCode: 0,
            },
            {
              type: "tool",
              id: "tool",
              status: "completed",
              title: "Внутренний инструмент",
              detail: "Служебные детали",
            },
            {
              type: "plan",
              id: "plan",
              status: "completed",
              text: "Скрытый план",
              images: [],
              timestamp: 1,
              phase: null,
            },
            {
              type: "fileChange",
              id: "file",
              status: "completed",
              path: "/work/file.ts",
              patch: "+change",
            },
            {
              type: "planChecklist",
              id: "checklist",
              status: "completed",
              explanation: "Скрытый checklist",
              steps: [{ step: "Скрытый шаг", status: "completed" }],
              timestamp: 1,
              afterItemId: null,
            },
            {
              type: "userInputResponse",
              id: "response",
              status: "completed",
              entries: [
                {
                  header: "Скрытый ответ",
                  question: "Скрытый вопрос",
                  answers: ["Скрытое значение"],
                },
              ],
              timestamp: 1,
              afterItemId: null,
            },
            {
              type: "error",
              id: "error",
              status: "failed",
              message: "Скрытая ошибка",
            },
            {
              type: "agentMessage",
              id: "answer",
              status: "completed",
              text: "Результат субагента",
              images: [],
              timestamp: 2,
              phase: "final_answer",
            },
          ],
        },
        {
          id: "technical-only",
          status: "completed",
          startedAt: 3,
          completedAt: 4,
          durationMs: 1,
          progress: progress(),
          items: [
            {
              type: "tool",
              id: "technical-tool",
              status: "completed",
              title: "Только техническое действие",
              detail: "",
            },
          ],
        },
      ],
    });
    context.state.snapshot.threads.push({
      ...summary,
      id: "parent",
      title: "Главная сессия",
    });

    const view = renderThread();

    const input = screen.getByText("Проверь результат").closest("article")!;
    const commentary = screen.getByText("Проверяю результат").closest("article")!;
    const answer = screen.getByText("Результат субагента").closest("article")!;
    expect(input).toHaveClass("userMessage");
    expect(commentary).toHaveClass("agentMessage");
    expect(answer).toHaveClass("agentMessage");
    expect(
      input.compareDocumentPosition(commentary) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      commentary.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText("Результат субагента")).toBeInTheDocument();
    for (const hidden of [
      "Скрытое рассуждение",
      "Внутренний инструмент",
      "Скрытый план",
      "Скрытый checklist",
      "Скрытый шаг",
      "Скрытый ответ",
      "Скрытая ошибка",
      "Только техническое действие",
    ]) {
      expect(screen.queryByText(hidden)).toBeNull();
    }
    expect(view.container.querySelectorAll(".turn")).toHaveLength(2);
    expect(view.container.querySelectorAll(".turn-activity-static")).toHaveLength(2);
    expect(screen.getAllByText("Готово за 0с")).toHaveLength(2);
    expect(screen.queryByLabelText("Технические детали")).toBeNull();
    expect(view.container.querySelector(".turn-timing")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Сообщение для Codex" })).toBeNull();
    expect(screen.queryByLabelText("Действия с задачей")).toBeNull();
    expect(
      screen.getByText(
        "Субагент управляется родительской сессией. Здесь доступен только просмотр.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Открыть родительскую сессию/ })).toHaveAttribute(
      "href",
      "/threads/parent",
    );
    expect(api.readGoal).not.toHaveBeenCalled();
    expect(api.updateThreadDraft).not.toHaveBeenCalled();
    const scroll = view.container.querySelector(".conversation-scroll") as HTMLDivElement;
    scroll.scrollTop = 0;
    fireEvent.scroll(scroll);
    expect(context.loadOlderDetail).not.toHaveBeenCalled();
  });

  it("keeps live status and approval requests in the filtered subagent view", () => {
    const api = threadApi();
    const child: ThreadSummary = {
      ...summary,
      state: "running",
      currentTurnId: "child-turn",
      relation: {
        kind: "subagent",
        sessionId: "child-session",
        parentThreadId: "parent",
        nickname: null,
        role: "worker",
      },
    };
    mockThreadConnection(api, child, {
      turns: [
        {
          id: "child-turn",
          status: "inProgress",
          startedAt: Date.now() - 1_000,
          completedAt: null,
          durationMs: null,
          progress: progress(),
          items: [
            {
              type: "tool",
              id: "running-tool",
              status: "inProgress",
              title: "Скрытый активный инструмент",
              detail: "",
            },
          ],
        },
      ],
      attention: [
        {
          id: "child-attention",
          threadId: "thread",
          turnId: "child-turn",
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

    renderThread();

    expect(screen.queryByText("Скрытый активный инструмент")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Codex работает");
    expect(screen.queryByLabelText("Технические детали")).toBeNull();
    expect(screen.getByRole("region", { name: "Требуется внимание" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Разрешить один раз" })).toBeInTheDocument();
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

  it("keeps the inspector closed until the user opens it on wide screens", () => {
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
    mockThreadConnection(threadApi(), summary);
    renderThread();

    expect(screen.queryByLabelText("Сведения о задаче")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Показать сведения" }));
    expect(screen.getByLabelText("Сведения о задаче")).toBeInTheDocument();
  });

  it("loads semantic artifacts lazily without loading historical turns", async () => {
    const api = threadApi();
    api.readThreadArtifacts.mockResolvedValueOnce({
      capability: "explicit",
      artifacts: [
        {
          id: "artifact-latest",
          label: "Свежий отчёт",
          path: "/work/project/reports/latest.md",
          relativePath: "reports/latest.md",
          fileName: "latest.md",
          turnId: "latest",
          createdAt: 1,
        },
      ],
    });
    const context = mockThreadConnection(api, summary, {
      olderTurnsCursor: "older-1",
      turns: [
        {
          id: "latest",
          status: "completed",
          startedAt: 30,
          completedAt: 40,
          durationMs: 10,
          progress: progress(),
          items: [
            {
              type: "agentMessage",
              id: "latest-answer",
              status: "completed",
              text: "[universe.rs:183](/work/project/src/universe.rs)",
              images: [],
              timestamp: 40,
              phase: "final_answer",
            },
            {
              type: "reasoning",
              id: "reasoning-link",
              status: "completed",
              text: "[Проверка](/work/project/checks/reasoning.log)",
              images: [],
              timestamp: 39,
              phase: null,
            },
            {
              type: "plan",
              id: "plan-link",
              status: "completed",
              text: "[Пункт плана](/work/project/plan.md)",
              images: [],
              timestamp: 38,
              phase: null,
            },
          ],
        },
      ],
    });
    renderThread();

    fireEvent.click(screen.getByRole("button", { name: "Показать сведения" }));
    expect(api.readThreadArtifacts).not.toHaveBeenCalled();
    expect(context.loadOlderDetail).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "Артефакты" }));

    await waitFor(() => expect(api.readThreadArtifacts).toHaveBeenCalledWith("thread"));
    expect(context.loadOlderDetail).not.toHaveBeenCalled();
    const inspector = screen.getByLabelText("Сведения о задаче");
    expect(within(inspector).getByText("reports/latest.md")).toBeInTheDocument();
    expect(within(inspector).queryByText("src/universe.rs")).not.toBeInTheDocument();
    expect(within(inspector).queryByText("checks/reasoning.log")).not.toBeInTheDocument();
    expect(within(inspector).queryByText("plan.md")).not.toBeInTheDocument();
    expect(within(inspector).getByRole("tab", { name: "Артефакты, 1" })).toBeInTheDocument();
  });

  it("refreshes semantic artifacts when a turn completes while the tab is open", async () => {
    const api = threadApi();
    api.readThreadArtifacts
      .mockResolvedValueOnce({ capability: "explicit", artifacts: [] })
      .mockResolvedValueOnce({
        capability: "explicit",
        artifacts: [
          {
            id: "artifact-result",
            label: "Результат",
            path: "/work/project/result.pdf",
            relativePath: "result.pdf",
            fileName: "result.pdf",
            turnId: "turn",
            createdAt: 1,
          },
        ],
      });
    const running = { ...summary, state: "running" as const, currentTurnId: "turn" };
    const context = mockThreadConnection(api, running);
    const view = renderThread();

    fireEvent.click(screen.getByRole("button", { name: "Показать сведения" }));
    fireEvent.click(screen.getByRole("tab", { name: "Артефакты" }));
    await waitFor(() => expect(api.readThreadArtifacts).toHaveBeenCalledTimes(1));

    const completed = {
      ...running,
      state: "completed" as const,
      currentTurnId: null,
      updatedAt: 3,
    };
    context.state.snapshot.threads = [completed];
    context.state.details.thread.summary = completed;
    view.rerender(threadRoute());

    await waitFor(() => expect(api.readThreadArtifacts).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Результат")).toBeInTheDocument();
  });

  it("returns from an inspector artifact preview to the artifact shelf", async () => {
    const api = threadApi();
    api.createDownload.mockResolvedValueOnce({
      downloadUrl: "/downloads/ticket/report.md",
      expiresAt: 61_000,
      fileName: "report.md",
      size: 8,
    });
    api.readThreadArtifacts.mockResolvedValueOnce({
      capability: "explicit",
      artifacts: [
        {
          id: "artifact-report",
          label: "Отчёт",
          path: "/work/project/report.md",
          relativePath: "report.md",
          fileName: "report.md",
          turnId: "turn",
          createdAt: 1,
        },
      ],
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("# Report", { status: 200 })));
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
              id: "answer",
              status: "completed",
              text: "[Отчёт](/work/project/report.md)",
              images: [],
              timestamp: 2,
              phase: "final_answer",
            },
          ],
        },
      ],
    });
    renderThread();

    fireEvent.click(screen.getByRole("button", { name: "Показать сведения" }));
    fireEvent.click(screen.getByRole("tab", { name: "Артефакты" }));
    await screen.findByRole("tab", { name: "Артефакты, 1" });
    const inspector = screen.getByLabelText("Сведения о задаче");
    fireEvent.click(within(inspector).getByRole("button", { name: "Открыть report.md" }));

    expect(await screen.findByRole("heading", { name: "Report" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Вернуться к артефактам" }));

    const reopened = await screen.findByLabelText("Сведения о задаче");
    const artifactButton = within(reopened).getByRole("button", { name: "Открыть report.md" });
    await waitFor(() => expect(artifactButton).toHaveFocus());
  });

  it("forces an authoritative session refresh from the header", async () => {
    const context = mockThreadConnection(threadApi(), summary);
    renderThread();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Принудительно обновить сессию",
      }),
    );

    expect(
      screen.getByRole("button", {
        name: "Обновляем состояние сессии",
      }),
    ).toBeDisabled();
    await waitFor(() => expect(context.forceRefreshDetail).toHaveBeenCalledWith("thread"));
    expect(
      await screen.findByRole("button", {
        name: "Принудительно обновить сессию",
      }),
    ).toBeEnabled();
  });

  it("keeps a known session after a refresh returns not found", async () => {
    const context = mockThreadConnection(threadApi(), summary);
    context.forceRefreshDetail.mockRejectedValue(
      new ApiClientError("not_found", "Thread not found", 404),
    );
    renderThread();

    fireEvent.click(screen.getByRole("button", { name: "Принудительно обновить сессию" }));

    await waitFor(() => expect(context.forceRefreshDetail).toHaveBeenCalledWith("thread"));
    expect(context.dispatch).not.toHaveBeenCalledWith({
      type: "thread.remove",
      threadId: "thread",
    });
    expect(screen.getByText("Тестовая задача")).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "Включить командный режим" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Модель и уровень рассуждений" })).toBeDisabled();
  });

  it("stops a running task with Escape", async () => {
    const api = threadApi();
    mockThreadConnection(api, {
      ...summary,
      state: "running",
      currentTurnId: "turn",
    });
    renderThread();

    const textbox = screen.getByRole("textbox", { name: "Направить текущую задачу" });
    fireEvent.keyDown(textbox, { key: "Escape" });

    await waitFor(() => expect(api.interrupt).toHaveBeenCalledWith("thread", "turn"));
    expect(api.interrupt).toHaveBeenCalledTimes(1);
  });

  it("stops a Team orchestration while the parent is between turns", async () => {
    const api = threadApi();
    mockThreadConnection(api, {
      ...summary,
      state: "running",
      currentTurnId: null,
      settings: { ...summary.settings, collaborationMode: "team" },
    });
    renderThread();

    fireEvent.click(screen.getByRole("button", { name: "Остановить задачу" }));

    await waitFor(() => expect(api.interrupt).toHaveBeenCalledWith("thread", undefined));
  });

  it("explains why a running Team orchestration cannot be disabled", async () => {
    const api = threadApi();
    const warning =
      "Нельзя выключить Team, пока субагенты работают или их результаты ещё не обработаны. Попросите главного агента завершить или отменить их.";
    api.updateThreadSettings.mockRejectedValueOnce(new Error(warning));
    mockThreadConnection(api, {
      ...summary,
      state: "running",
      currentTurnId: null,
      settings: { ...summary.settings, collaborationMode: "team" },
    });
    renderThread();

    const team = screen.getByRole("button", { name: "Выключить командный режим" });
    expect(team).toBeEnabled();
    expect(screen.getByRole("button", { name: "Включить режим планирования" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Модель и уровень рассуждений" })).toBeDisabled();

    fireEvent.click(team);

    await waitFor(() =>
      expect(api.updateThreadSettings).toHaveBeenCalledWith("thread", {
        collaborationMode: "default",
      }),
    );
    expect(await screen.findByText(warning)).toBeInTheDocument();
    expect(team).toHaveAttribute("aria-pressed", "true");
  });

  it("restores the complete draft and debounces rapid text into one latest local and server save", async () => {
    vi.useFakeTimers();
    try {
      const api = threadApi();
      const annotation = pendingAnnotation();
      mockThreadConnection(api, summary, {
        turns: [completedAgentTurn()],
        draft: {
          input: "Сохранённый текст",
          images: [
            {
              id: "draft-image",
              name: "draft.png",
              url: "data:image/png;base64,AA==",
            },
          ],
          goalMode: true,
          annotations: [annotation],
          updatedAt: 10,
        },
      });
      renderThread();

      const textbox = screen.getByRole("textbox", { name: "Сообщение для Codex" });
      expect(textbox).toHaveValue("Сохранённый текст");
      expect(screen.getByAltText("draft.png")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Выключить режим цели" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(screen.getByRole("button", { name: "Аннотация 1" })).toBeInTheDocument();

      fireEvent.change(textbox, { target: { value: "О" } });
      fireEvent.change(textbox, { target: { value: "Обновлённый" } });
      fireEvent.change(textbox, { target: { value: "Обновлённый текст" } });
      expect(saveLocalDraft).not.toHaveBeenCalled();
      expect(api.updateThreadDraft).not.toHaveBeenCalled();

      await act(async () => vi.advanceTimersByTimeAsync(499));
      expect(saveLocalDraft).not.toHaveBeenCalled();
      expect(api.updateThreadDraft).not.toHaveBeenCalled();

      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(saveLocalDraft).toHaveBeenCalledTimes(1);
      expect(saveLocalDraft).toHaveBeenCalledWith(
        api.settings,
        "thread",
        expect.objectContaining({
          input: "Обновлённый текст",
          images: [expect.objectContaining({ name: "draft.png" })],
          goalMode: true,
          annotations: [annotation],
        }),
        expect.any(Number),
      );
      expect(api.updateThreadDraft).toHaveBeenCalledTimes(1);
      expect(api.updateThreadDraft).toHaveBeenCalledWith(
        "thread",
        expect.objectContaining({
          input: "Обновлённый текст",
          images: [expect.objectContaining({ name: "draft.png" })],
          goalMode: true,
          annotations: [annotation],
        }),
        { keepalive: false },
      );
      expect(saveLocalDraft.mock.invocationCallOrder[0]!).toBeLessThan(
        api.updateThreadDraft.mock.invocationCallOrder[0]!,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps completed agent and plan history memoized across input and unrelated state", () => {
    let agentTextReads = 0;
    let planTextReads = 0;
    const agentMessage: Parameters<typeof Activity>[0]["item"] = {
      ...completedAgentTurn().items[0]!,
      get text() {
        agentTextReads += 1;
        return "Старый ответ";
      },
    };
    const planMessage: Parameters<typeof Activity>[0]["item"] = {
      type: "plan",
      id: "stable-plan",
      status: "completed",
      get text() {
        planTextReads += 1;
        return "# Стабильный план";
      },
      images: [],
      timestamp: 2,
      phase: null,
    };
    mockThreadConnection(
      threadApi(),
      { ...summary, settings: { collaborationMode: "plan" } },
      {
        turns: [
          { ...completedAgentTurn(), id: "agent-turn", items: [agentMessage] },
          { ...completedAgentTurn(), id: "plan-turn", items: [planMessage] },
        ],
      },
    );
    const view = renderThread();
    const readsAfterInitialRender = { agent: agentTextReads, plan: planTextReads };

    const textbox = screen.getByRole("textbox", { name: "Сообщение для Codex" });
    fireEvent.change(textbox, {
      target: { value: "Новый черновик" },
    });
    expect({ agent: agentTextReads, plan: planTextReads }).toEqual(readsAfterInitialRender);

    const scroll = view.container.querySelector(".conversation-scroll") as HTMLDivElement;
    Object.defineProperties(scroll, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 100 },
    });
    scroll.scrollTop = 0;
    fireEvent.scroll(scroll);

    expect(
      screen.getByRole("button", { name: "Прокрутить к последнему сообщению" }),
    ).toBeInTheDocument();
    expect(textbox).toHaveValue("Новый черновик");
    expect({ agent: agentTextReads, plan: planTextReads }).toEqual(readsAfterInitialRender);
  });

  it("flushes the latest text immediately when the document becomes hidden", async () => {
    const api = threadApi();
    mockThreadConnection(api, summary);
    renderThread();
    const textbox = screen.getByRole("textbox", { name: "Сообщение для Codex" });

    fireEvent.change(textbox, { target: { value: "Черновик" } });
    fireEvent.change(textbox, { target: { value: "Последний скрытый черновик" } });
    expect(saveLocalDraft).not.toHaveBeenCalled();
    expect(api.updateThreadDraft).not.toHaveBeenCalled();

    const previousVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() => expect(saveLocalDraft).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(api.updateThreadDraft).toHaveBeenCalledWith(
          "thread",
          expect.objectContaining({ input: "Последний скрытый черновик" }),
          { keepalive: true },
        ),
      );
    } finally {
      if (previousVisibility) {
        Object.defineProperty(document, "visibilityState", previousVisibility);
      } else {
        delete (document as unknown as Record<string, unknown>).visibilityState;
      }
    }
  });

  it("coalesces draft revisions queued behind a slow save", async () => {
    const api = threadApi();
    const saves: Array<{
      draft: UpdateThreadDraftRequest;
      resolve(value: ThreadDraft | null): void;
    }> = [];
    api.updateThreadDraft.mockImplementation(
      (_id, draft) =>
        new Promise<ThreadDraft | null>((resolve) => {
          saves.push({ draft, resolve });
        }),
    );
    const context = mockThreadConnection(api, summary);
    renderThread();
    const textbox = screen.getByRole("textbox", { name: "Сообщение для Codex" });

    fireEvent.change(textbox, { target: { value: "Первая версия" } });
    await new Promise((resolve) => window.setTimeout(resolve, 520));
    await waitFor(() => expect(saves).toHaveLength(1));

    fireEvent.change(textbox, { target: { value: "Вторая версия" } });
    await new Promise((resolve) => window.setTimeout(resolve, 520));
    fireEvent.change(textbox, { target: { value: "Последняя версия" } });
    await new Promise((resolve) => window.setTimeout(resolve, 520));
    expect(saves).toHaveLength(1);

    await act(async () => {
      saves[0]!.resolve({ ...saves[0]!.draft, updatedAt: 10 });
      await Promise.resolve();
    });
    await waitFor(() => expect(saves).toHaveLength(2));
    expect(saves[1]!.draft.input).toBe("Последняя версия");
    expect(
      context.dispatch.mock.calls.some(
        ([action]) => action.type === "draft" && action.draft?.input === "Первая версия",
      ),
    ).toBe(false);

    await act(async () => {
      saves[1]!.resolve({ ...saves[1]!.draft, updatedAt: 20 });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(context.dispatch).toHaveBeenCalledWith({
        type: "draft",
        threadId: "thread",
        draft: expect.objectContaining({ input: "Последняя версия" }),
      }),
    );
    expect(saves).toHaveLength(2);
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

  it("does not roll back a delivered message when local draft cleanup rejects", async () => {
    deleteLocalDraft.mockRejectedValueOnce(new Error("IndexedDB недоступен"));
    const api = threadApi();
    const context = mockThreadConnection(api, summary);
    renderThread();
    const textbox = screen.getByRole("textbox", { name: "Сообщение для Codex" });
    fireEvent.change(textbox, { target: { value: "Уже доставлено" } });

    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    await waitFor(() => expect(api.startTurn).toHaveBeenCalledOnce());
    await waitFor(() => expect(textbox).toHaveValue(""));
    expect(screen.queryByText("IndexedDB недоступен")).not.toBeInTheDocument();
    expect(context.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "optimistic.remove",
      }),
    );
  });

  it("keeps task settings in the composer without permission controls", async () => {
    const api = threadApi();
    mockThreadConnection(api, summary);
    renderThread();

    expect(
      screen.queryByRole("combobox", { name: "Уровень подтверждений" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Модель и уровень рассуждений" }));
    const modelDialog = screen.getByRole("dialog", { name: "Настройки модели" });
    expect(within(modelDialog).getByRole("radiogroup", { name: "Модель" })).toBeInTheDocument();
    expect(
      within(modelDialog).getByRole("radiogroup", { name: "Уровень рассуждений" }),
    ).toBeInTheDocument();
    fireEvent.click(within(modelDialog).getByRole("button", { name: "Закрыть" }));
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
    expect(api.sendQueuedNow).not.toHaveBeenCalled();
  });

  it.each([
    { modifier: "Meta", keys: { metaKey: true } },
    { modifier: "Control", keys: { ctrlKey: true } },
  ])("sends the new message immediately with $modifier+Enter", async ({ keys }) => {
    const api = threadApi();
    const running = { ...summary, state: "running" as const, currentTurnId: "turn" };
    const context = mockThreadConnection(api, running, {
      queuedMessages: [
        {
          id: "older-message",
          threadId: "thread",
          text: "Старое сообщение",
          createdAt: 1,
          status: "queued",
        },
      ],
    });
    context.sendReliable.mockImplementation(async (threadId, body) => {
      await api.enqueue(threadId, body);
      return "delivered";
    });
    renderThread();
    const textarea = screen.getByRole("textbox", { name: "Направить текущую задачу" });

    fireEvent.change(textarea, { target: { value: "Сразу" } });
    fireEvent.keyDown(textarea, { key: "Enter", ...keys });

    await waitFor(() => expect(api.sendQueuedNow).toHaveBeenCalledOnce());
    const clientMessageId = api.enqueue.mock.calls[0]?.[1].clientMessageId;
    expect(clientMessageId).toEqual(expect.any(String));
    expect(api.sendQueuedNow).toHaveBeenCalledWith("thread", clientMessageId);
    expect(api.sendQueuedNow).not.toHaveBeenCalledWith("thread", "older-message");
  });

  it("sends queued messages oldest first with modifier Enter when the composer is empty", async () => {
    const api = threadApi();
    const running = { ...summary, state: "running" as const, currentTurnId: "turn" };
    const first = {
      id: "first-message",
      threadId: "thread",
      text: "Первое",
      createdAt: 1,
      status: "queued" as const,
    };
    const second = {
      id: "second-message",
      threadId: "thread",
      text: "Второе",
      createdAt: 2,
      status: "queued" as const,
    };
    const context = mockThreadConnection(api, running, { queuedMessages: [first, second] });
    const view = renderThread();
    const textarea = screen.getByRole("textbox", { name: "Направить текущую задачу" });

    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    await waitFor(() => expect(api.sendQueuedNow).toHaveBeenCalledWith("thread", first.id));
    expect(api.enqueue).not.toHaveBeenCalled();

    context.state.details.thread.queuedMessages = [second];
    view.rerender(threadRoute());
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

    await waitFor(() => expect(api.sendQueuedNow).toHaveBeenCalledTimes(2));
    expect(api.sendQueuedNow.mock.calls).toEqual([
      ["thread", first.id],
      ["thread", second.id],
    ]);
  });

  it("does not skip a dispatching message at the head of the queue", () => {
    const api = threadApi();
    const running = { ...summary, state: "running" as const, currentTurnId: "turn" };
    mockThreadConnection(api, running, {
      queuedMessages: [
        {
          id: "first-message",
          threadId: "thread",
          text: "Первое",
          createdAt: 1,
          status: "dispatching",
        },
        {
          id: "second-message",
          threadId: "thread",
          text: "Второе",
          createdAt: 2,
          status: "queued",
        },
      ],
    });
    renderThread();

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Направить текущую задачу" }), {
      key: "Enter",
      metaKey: true,
    });

    expect(api.sendQueuedNow).not.toHaveBeenCalled();
  });

  it("keeps an accepted immediate message queued when send-now fails", async () => {
    const api = threadApi();
    api.sendQueuedNow.mockRejectedValueOnce(new Error("offline"));
    const running = { ...summary, state: "running" as const, currentTurnId: "turn" };
    const context = mockThreadConnection(api, running);
    context.sendReliable.mockImplementation(async (threadId, body) => {
      await api.enqueue(threadId, body);
      return "delivered";
    });
    renderThread();
    const textarea = screen.getByRole("textbox", { name: "Направить текущую задачу" });

    fireEvent.change(textarea, { target: { value: "Сразу" } });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });

    expect(
      await screen.findByText("Не удалось отправить сразу — сообщение осталось в очереди"),
    ).toBeInTheDocument();
    expect(textarea).toHaveValue("");
    expect(context.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "optimistic.remove" }),
    );
  });

  it("does not request send-now while reliable delivery is pending", async () => {
    const api = threadApi();
    const running = { ...summary, state: "running" as const, currentTurnId: "turn" };
    const context = mockThreadConnection(api, running);
    context.sendReliable.mockResolvedValueOnce("pending");
    renderThread();
    const textarea = screen.getByRole("textbox", { name: "Направить текущую задачу" });

    fireEvent.change(textarea, { target: { value: "После подключения" } });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

    await waitFor(() => expect(context.sendReliable).toHaveBeenCalledOnce());
    expect(api.sendQueuedNow).not.toHaveBeenCalled();
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
    mockThreadConnection(api, planThread, completedPlanDetail());
    renderThread();

    expect(screen.queryByRole("button", { name: /Отклонить/ })).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Запустить в режиме оркестратора" }),
    ).toBeInTheDocument();
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

  it("lets only one completed-plan implementation button start at a time", async () => {
    const api = threadApi();
    const planThread = {
      ...summary,
      settings: { collaborationMode: "plan" as const },
    };
    let resolveSettings: ((thread: ThreadSummary) => void) | undefined;
    api.updateThreadSettings.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSettings = resolve;
        }),
    );
    mockThreadConnection(api, planThread, completedPlanDetail());
    renderThread();
    const defaultButton = screen.getByRole("button", { name: "Да, реализуй этот план" });
    const teamButton = screen.getByRole("button", { name: "Запустить в режиме оркестратора" });

    act(() => {
      defaultButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      teamButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(api.updateThreadSettings).toHaveBeenCalledTimes(1);
    expect(api.updateThreadSettings).toHaveBeenCalledWith("thread", {
      collaborationMode: "default",
    });
    expect(screen.getByText("Это сообщение уже отправлено")).toBeInTheDocument();

    resolveSettings?.({ ...planThread, settings: { collaborationMode: "default" } });
    await waitFor(() => expect(api.startTurn).toHaveBeenCalledOnce());
  });

  it("does not mutate Plan settings when its implementation message is already active", async () => {
    const api = threadApi();
    const planThread = {
      ...summary,
      settings: { collaborationMode: "plan" as const },
    };
    const context = mockThreadConnection(api, planThread, completedPlanDetail());
    context.state.optimisticMessages.thread = [
      {
        id: "active-plan-acceptance",
        threadId: "thread",
        text: "Да, реализуй этот план",
        images: [],
        createdAt: 3,
        destination: "turn",
        turnId: null,
      },
    ];
    renderThread();

    fireEvent.click(screen.getByRole("button", { name: "Да, реализуй этот план" }));

    expect(await screen.findByText("Это сообщение уже отправлено")).toBeInTheDocument();
    expect(api.updateThreadSettings).not.toHaveBeenCalled();
    expect(api.startTurn).not.toHaveBeenCalled();
  });

  it("releases a failed completed-plan claim so acceptance can be retried", async () => {
    const api = threadApi();
    api.startTurn.mockRejectedValueOnce(new Error("Codex недоступен"));
    const planThread = {
      ...summary,
      settings: { collaborationMode: "plan" as const },
    };
    mockThreadConnection(api, planThread, completedPlanDetail());
    renderThread();
    const button = screen.getByRole("button", { name: "Да, реализуй этот план" });

    fireEvent.click(button);
    await waitFor(() =>
      expect(api.updateThreadSettings).toHaveBeenNthCalledWith(2, "thread", {
        collaborationMode: "plan",
      }),
    );

    fireEvent.click(button);

    await waitFor(() => expect(api.startTurn).toHaveBeenCalledTimes(2));
    expect(api.updateThreadSettings).toHaveBeenNthCalledWith(3, "thread", {
      collaborationMode: "default",
    });
  });

  it("starts a completed plan in orchestrator mode", async () => {
    const api = threadApi();
    const planThread = {
      ...summary,
      settings: { collaborationMode: "plan" as const },
    };
    mockThreadConnection(api, planThread, completedPlanDetail());
    renderThread();

    fireEvent.click(screen.getByRole("button", { name: "Запустить в режиме оркестратора" }));

    await waitFor(() =>
      expect(api.updateThreadSettings).toHaveBeenCalledWith("thread", {
        collaborationMode: "team",
      }),
    );
    expect(api.startTurn).toHaveBeenCalledWith(
      "thread",
      expect.objectContaining({
        input: "Да, реализуй этот план в режиме оркестратора",
        clientMessageId: expect.any(String),
      }),
    );
  });

  it("returns to Plan mode when orchestrator implementation fails to start", async () => {
    const api = threadApi();
    api.startTurn.mockRejectedValueOnce(new Error("Codex недоступен"));
    const planThread = {
      ...summary,
      settings: { collaborationMode: "plan" as const },
    };
    mockThreadConnection(api, planThread, completedPlanDetail());
    renderThread();

    fireEvent.click(screen.getByRole("button", { name: "Запустить в режиме оркестратора" }));

    await waitFor(() =>
      expect(api.updateThreadSettings).toHaveBeenNthCalledWith(2, "thread", {
        collaborationMode: "plan",
      }),
    );
    expect(screen.getByText("Codex недоступен")).toBeInTheDocument();
  });

  it("does not migrate an incompatible Plan session when starting the orchestrator", async () => {
    const api = threadApi();
    api.updateThreadSettings.mockRejectedValueOnce(
      new Error("Эта сессия создана до появления managed Team tools. Создайте новую Team-сессию."),
    );
    const planThread = {
      ...summary,
      settings: { collaborationMode: "plan" as const },
    };
    mockThreadConnection(api, planThread, completedPlanDetail());
    renderThread();

    fireEvent.click(screen.getByRole("button", { name: "Запустить в режиме оркестратора" }));

    expect(
      await screen.findByText(
        "Эта сессия создана до появления managed Team tools. Создайте новую Team-сессию.",
      ),
    ).toBeInTheDocument();
    expect(api.startTurn).not.toHaveBeenCalled();
    expect(api.updateThreadSettings).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "Создать новую Team-сессию" }),
    ).not.toBeInTheDocument();
  });

  it("sends plan annotations as revision feedback and blocks plan acceptance", async () => {
    const api = threadApi();
    const planThread = {
      ...summary,
      settings: { collaborationMode: "plan" as const },
    };
    const annotation = pendingAnnotation({
      messageId: "plan",
      source: "plan",
      quote: "Сделать",
      startOffset: 7,
      endOffset: 14,
    });
    localStorage.setItem(annotationStorageKey("thread"), JSON.stringify([annotation]));
    mockThreadConnection(api, planThread, completedPlanDetail());
    renderThread();

    expect(screen.getByRole("button", { name: "Да, реализуй этот план" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Запустить в режиме оркестратора" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    await waitFor(() =>
      expect(api.startTurn).toHaveBeenCalledWith(
        "thread",
        expect.objectContaining({ input: expect.stringContaining("### Аннотация 1") }),
      ),
    );
    expect(api.updateThreadSettings).not.toHaveBeenCalled();
  });

  it("docks queued messages above the composer and supports queue actions", async () => {
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
        {
          id: "second",
          threadId: "thread",
          text: "Следующее сообщение",
          createdAt: 2,
          status: "queued",
        },
      ],
    });
    renderThread();

    const queue = screen.getByRole("region", { name: "Очередь сообщений" });
    expect(queue.closest("form")).toHaveClass("composer");
    expect(queue.closest(".timeline")).toBeNull();
    expect(
      Array.from(queue.querySelectorAll("[data-message-id]")).map((node) =>
        node.getAttribute("data-message-id"),
      ),
    ).toEqual(["queued", "second"]);
    expect(
      Array.from(queue.querySelectorAll(".queued-message-order")).map((node) => node.textContent),
    ).toEqual(["01", "02"]);
    expect(queue.querySelector(".queued-messages-count")).toHaveTextContent("·2");
    expect(screen.getAllByText("В очереди")).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Изменить сообщение в очереди" })[0]!);
    fireEvent.change(screen.getByRole("textbox", { name: "Текст сообщения в очереди" }), {
      target: { value: "Исправленная срочная правка" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(api.updateQueued).toHaveBeenCalledWith("thread", "queued", {
        input: "Исправленная срочная правка",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "Текст сообщения в очереди" })).toBeNull(),
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Изменить сообщение в очереди" })[0]!);
    fireEvent.change(screen.getByRole("textbox", { name: "Текст сообщения в очереди" }), {
      target: { value: "Не сохранять" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(api.updateQueued).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getAllByRole("button", { name: "Удалить сообщение из очереди" })[0]!);
    await waitFor(() => expect(api.deleteQueued).toHaveBeenCalledWith("thread", "queued"));

    fireEvent.click(screen.getAllByRole("button", { name: "Отправить сейчас" })[0]!);
    await waitFor(() => expect(api.sendQueuedNow).toHaveBeenCalledWith("thread", "queued"));
  });

  it("disables queue actions until optimistic messages are confirmed", () => {
    const api = threadApi();
    const running = { ...summary, state: "running" as const, currentTurnId: "turn" };
    const context = mockThreadConnection(api, running);
    context.state.optimisticMessages.thread = [
      {
        id: "optimistic",
        threadId: "thread",
        text: "Добавляется",
        images: [],
        createdAt: 1,
        destination: "queue",
        turnId: null,
      },
    ];
    renderThread();

    expect(screen.getByText("Добавляется…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Изменить сообщение в очереди" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Удалить сообщение из очереди" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Отправить сейчас" })).toBeDisabled();
  });

  it("shows chronological plan checklists inside the turn without a composer status pill", () => {
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
              id: "turn-plan-checklist-started",
              status: "inProgress",
              explanation: "Читаем код",
              steps: [
                { step: "Прочитать код", status: "inProgress" },
                { step: "Исправить чат", status: "pending" },
                { step: "Запустить тесты", status: "pending" },
              ],
              timestamp: Date.now() - 2_000,
              afterItemId: null,
            },
            {
              type: "agentMessage",
              id: "progress-message",
              status: "completed",
              text: "Код прочитан",
              images: [],
              timestamp: Date.now() - 1_000,
              phase: "commentary",
            },
            {
              type: "planChecklist",
              id: "turn-plan-checklist-next",
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
    const view = renderThread();

    expect(screen.getAllByText("Ход работы")).toHaveLength(2);
    expect(screen.getByText("Код прочитан")).toBeInTheDocument();
    expect(screen.getAllByText("Прочитать код")).toHaveLength(2);
    expect(screen.getAllByText("Исправить чат")).toHaveLength(2);
    expect(screen.getAllByText("Запустить тесты")).toHaveLength(2);
    expect(screen.getAllByRole("checkbox")).toHaveLength(6);
    expect(screen.getAllByRole("checkbox")[0]).not.toBeChecked();
    expect(screen.getAllByRole("checkbox")[3]).toBeChecked();
    const cards = view.container.querySelectorAll(".plan-checklist");
    expect(cards[0]).toHaveTextContent("Читаем код");
    expect(cards[1]).toHaveTextContent("Проверяем изменения");
    expect(screen.getAllByText("Проверяем изменения").length).toBeGreaterThanOrEqual(1);
    expect(document.querySelector(".turn-progress")).toBeNull();
  });

  it("shows a final checklist above its separate final answer", () => {
    const api = threadApi();
    const completed = { ...summary, state: "completed" as const };
    mockThreadConnection(api, completed, {
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
              id: "final-answer",
              status: "completed",
              text: "Итоговый ответ",
              images: [],
              timestamp: 2,
              phase: "final_answer",
            },
            {
              type: "planChecklist",
              id: "final-checklist",
              status: "completed",
              explanation: "Работа завершена",
              steps: [{ step: "Проверить результат", status: "completed" }],
              timestamp: 3,
              afterItemId: "unrendered-reasoning-item",
            },
          ],
        },
      ],
    });
    const view = renderThread();

    const checklist = screen.getByText("Проверить результат").closest("article");
    const answer = screen.getByText("Итоговый ответ").closest("article");
    const timing = view.container.querySelector(".turn-activity-row");
    expect(checklist).toHaveClass("plan-checklist");
    expect(checklist).toHaveTextContent("Работа завершена");
    expect(answer).toHaveClass("agentMessage");
    expect(checklist).not.toBe(answer);
    expect(checklist!.compareDocumentPosition(answer!) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(answer!.compareDocumentPosition(timing!) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
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
    expect(screen.queryByLabelText("Технические детали")).toBeNull();
    expect(view.container.querySelector(".turn-activity-static")).not.toBeNull();
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

  it("renders a reliable optimistic message before the running indicator", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
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
      destination: "queue",
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
    expect(message).toHaveAttribute("data-message-id", optimistic.id);

    await act(async () => resolveStart?.({ turnId: "turn" }));
    delete (HTMLElement.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
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

  it("shows a button away from the latest message and smoothly scrolls back", () => {
    const api = threadApi();
    mockThreadConnection(api, summary);
    const view = renderThread();
    const scroll = view.container.querySelector(".conversation-scroll") as HTMLDivElement;
    const scrollTo = vi.fn();
    Object.defineProperties(scroll, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 500 },
      scrollTo: { configurable: true, value: scrollTo },
    });

    scroll.scrollTop = 250;
    fireEvent.scroll(scroll);

    const button = screen.getByRole("button", {
      name: "Прокрутить к последнему сообщению",
    });
    fireEvent.click(button);
    expect(scrollTo).toHaveBeenCalledWith({ top: 1_000, behavior: "smooth" });

    scroll.scrollTop = 400;
    fireEvent.scroll(scroll);
    expect(screen.queryByRole("button", { name: "Прокрутить к последнему сообщению" })).toBeNull();
  });

  it("stops following a streamed response when the user scrolls upward", () => {
    const running = { ...summary, state: "running" as const, currentTurnId: "turn" };
    const item = {
      type: "agentMessage" as const,
      id: "streaming-answer",
      status: "inProgress" as const,
      text: "Первая часть ответа",
      images: [],
      timestamp: 1,
      phase: "commentary" as const,
    };
    const context = mockThreadConnection(threadApi(), running, {
      turns: [
        {
          id: "turn",
          status: "inProgress",
          startedAt: 1,
          completedAt: null,
          durationMs: null,
          progress: progress(),
          items: [item],
        },
      ],
    });
    const view = renderThread();
    const scroll = view.container.querySelector(".conversation-scroll") as HTMLDivElement;
    const scrollTo = vi.fn();
    Object.defineProperties(scroll, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 500 },
      scrollTo: { configurable: true, value: scrollTo },
    });
    scroll.scrollTop = 500;
    fireEvent.scroll(scroll);

    fireEvent.touchStart(scroll, { touches: [{ clientX: 100, clientY: 200 }] });
    fireEvent.touchMove(scroll, { touches: [{ clientX: 102, clientY: 230 }] });
    scroll.scrollTop = 470;
    fireEvent.scroll(scroll);

    expect(
      screen.getByRole("button", { name: "Прокрутить к последнему сообщению" }),
    ).toBeInTheDocument();

    context.state.details.thread = {
      ...context.state.details.thread,
      turns: [
        {
          ...context.state.details.thread.turns[0],
          items: [{ ...item, text: `${item.text}. Продолжение` }],
        },
      ],
    };
    view.rerender(threadRoute());

    expect(scrollTo).not.toHaveBeenCalled();
    expect(scroll.scrollTop).toBe(470);
  });

  it("reloads the open chat after a reconnect snapshot without duplicating the initial read", async () => {
    const api = threadApi();
    const context = mockThreadConnection(api, summary);
    const view = renderThread();
    await waitFor(() => expect(context.refreshDetail).toHaveBeenCalledTimes(1));

    context.streamRecoveryEpoch += 1;
    view.rerender(threadRoute());

    await waitFor(() => expect(context.refreshDetail).toHaveBeenCalledTimes(2));
    expect(context.refreshDetail).toHaveBeenLastCalledWith("thread", { force: true });
  });

  it("reloads the open chat as soon as the native app returns to the foreground", async () => {
    const api = threadApi();
    const context = mockThreadConnection(api, summary);
    const view = renderThread();
    await waitFor(() => expect(context.refreshDetail).toHaveBeenCalledTimes(1));

    context.foregroundEpoch += 1;
    view.rerender(threadRoute());

    await waitFor(() => expect(context.refreshDetail).toHaveBeenCalledTimes(2));
    expect(context.refreshDetail).toHaveBeenLastCalledWith("thread", { force: true });
  });

  it("marks an unseen open thread as viewed only while the app is active", async () => {
    const api = threadApi();
    const unseen = {
      ...summary,
      state: "completed" as const,
      unread: true,
      unseen: true,
      updatedAt: 123,
    };
    const context = mockThreadConnection(api, unseen);
    context.appActive = false;
    const view = renderThread();

    expect(api.markViewed).not.toHaveBeenCalled();
    context.appActive = true;
    view.rerender(threadRoute());

    await waitFor(() =>
      expect(api.markViewed).toHaveBeenCalledWith("thread", { observedUpdatedAt: 123 }),
    );
  });

  it("deduplicates viewed marks per thread version and marks a newer outcome", async () => {
    const api = threadApi();
    const unseen = {
      ...summary,
      state: "completed" as const,
      unread: true,
      unseen: true,
      updatedAt: 123,
    };
    const context = mockThreadConnection(api, unseen);
    const view = renderThread();
    await waitFor(() => expect(api.markViewed).toHaveBeenCalledTimes(1));

    view.rerender(threadRoute());
    expect(api.markViewed).toHaveBeenCalledTimes(1);

    const newer = { ...unseen, updatedAt: 456 };
    context.state.snapshot.threads = [newer];
    context.state.details.thread = { ...context.state.details.thread, summary: newer };
    view.rerender(threadRoute());

    await waitFor(() => expect(api.markViewed).toHaveBeenCalledTimes(2));
    expect(api.markViewed).toHaveBeenLastCalledWith("thread", { observedUpdatedAt: 456 });
  });

  it("retries a failed viewed mark after the connection recovers", async () => {
    const api = threadApi();
    api.markViewed.mockRejectedValueOnce(new Error("offline"));
    const unseen = {
      ...summary,
      state: "completed" as const,
      unread: true,
      unseen: true,
      updatedAt: 123,
    };
    const context = mockThreadConnection(api, unseen);
    const view = renderThread();
    await waitFor(() => expect(api.markViewed).toHaveBeenCalledTimes(1));
    await act(async () => Promise.resolve());

    context.state.network = "offline";
    view.rerender(threadRoute());
    context.state.network = "connected";
    view.rerender(threadRoute());

    await waitFor(() => expect(api.markViewed).toHaveBeenCalledTimes(2));
  });

  it("retries one completed chat read when only a plan is available", () => {
    vi.useFakeTimers();
    try {
      const completed = { ...summary, state: "completed" as const, updatedAt: 3 };
      const context = mockThreadConnection(threadApi(), completed, {
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
                type: "plan",
                id: "plan",
                status: "completed",
                text: "План",
                images: [],
                timestamp: 2,
                phase: null,
              },
            ],
          },
        ],
      });
      renderThread();

      expect(context.refreshDetail).toHaveBeenCalledTimes(1);
      act(() => vi.advanceTimersByTime(499));
      expect(context.refreshDetail).toHaveBeenCalledTimes(1);
      act(() => vi.advanceTimersByTime(1));
      expect(context.refreshDetail).toHaveBeenCalledTimes(2);
      expect(context.refreshDetail).toHaveBeenLastCalledWith("thread", { force: true });
      act(() => vi.advanceTimersByTime(5_000));
      expect(context.refreshDetail).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a completed chat that already has a final answer", () => {
    vi.useFakeTimers();
    try {
      const completed = { ...summary, state: "completed" as const, updatedAt: 3 };
      const context = mockThreadConnection(threadApi(), completed, {
        turns: [completedAgentTurn()],
      });
      renderThread();

      expect(context.refreshDetail).toHaveBeenCalledTimes(1);
      act(() => vi.advanceTimersByTime(500));
      expect(context.refreshDetail).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending completed chat retry when the page closes", () => {
    vi.useFakeTimers();
    try {
      const completed = { ...summary, state: "completed" as const, updatedAt: 3 };
      const context = mockThreadConnection(threadApi(), completed, {
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
                type: "plan",
                id: "plan",
                status: "completed",
                text: "План",
                images: [],
                timestamp: 2,
                phase: null,
              },
            ],
          },
        ],
      });
      const view = renderThread();

      expect(context.refreshDetail).toHaveBeenCalledTimes(1);
      view.unmount();
      act(() => vi.advanceTimersByTime(500));
      expect(context.refreshDetail).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forces an authoritative refresh only when turn details disagree", async () => {
    const api = threadApi();
    const running = { ...summary, state: "running" as const, currentTurnId: "missing-turn" };
    const context = mockThreadConnection(api, running, {
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
              text: "Одобренный план",
              images: [],
              timestamp: 2,
              phase: null,
            },
          ],
        },
      ],
    });
    const view = renderThread();

    expect(screen.getByText("Codex работает")).toBeInTheDocument();
    await waitFor(() =>
      expect(context.refreshDetail).toHaveBeenCalledWith("thread", { authoritative: true }),
    );
    expect(context.forceRefreshDetail).not.toHaveBeenCalled();

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
    await waitFor(() => expect(context.refreshDetail).toHaveBeenCalledTimes(3));

    context.state.details.thread = {
      ...context.state.details.thread,
      turns: [
        {
          ...context.state.details.thread.turns[0]!,
          status: "completed",
          completedAt: Date.now(),
        },
      ],
    };
    view.rerender(threadRoute());
    expect(context.refreshDetail).toHaveBeenCalledTimes(3);
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

  it("offers an explicit retry for a recording retained after reload", async () => {
    const api = threadApi();
    const initialDraft: ThreadDraft = {
      input: "Текущий черновик",
      images: [],
      goalMode: false,
      annotations: [],
      updatedAt: 20,
    };
    const context = mockThreadConnection(api, summary, { draft: initialDraft });
    context.pendingVoiceRecordingThreadIds = ["thread"];
    context.pendingVoiceRecordingErrors = {
      thread: "The draft changed before voice upload",
    };
    render(voiceThreadRoute());

    const retry = await screen.findByRole("button", { name: "Повторить сохранённую запись" });
    expect(
      screen.getByText(
        "Черновик изменился; сохранённая запись не была потеряна. Повторите восстановление.",
      ),
    ).toBeTruthy();
    fireEvent.click(retry);

    await waitFor(() => expect(context.retryPendingVoiceRecording).toHaveBeenCalledOnce());
    expect(context.retryPendingVoiceRecording).toHaveBeenCalledWith({
      threadId: "thread",
      mode: "draft",
      draft: expect.objectContaining({ input: "Текущий черновик" }),
      draftUpdatedAt: expect.any(Number),
    });
  });

  it("uploads voice for its source session and leaves other sessions usable", async () => {
    installMediaRecorder(async () => {
      return { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    });
    let resolveAccepted:
      | ((value: {
          id: string;
          threadId: string;
          mode: "send";
          status: "queued";
          createdAt: number;
          startedAt: null;
          audioDurationMs: number;
          estimatedTotalSeconds: null;
          error: null;
        }) => void)
      | undefined;
    const api = threadApi();
    api.createVoiceTranscription.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAccepted = resolve;
        }),
    );
    const initialDraft: ThreadDraft = {
      input: "Начало конец",
      images: [],
      goalMode: false,
      annotations: [],
      updatedAt: 1,
    };
    const context = mockThreadConnection(api, summary, { draft: initialDraft });
    const other = { ...summary, id: "other", title: "Другая задача" };
    const details = context.state.details as Record<string, ThreadDetail>;
    context.state.snapshot.threads = [summary, other];
    details.other = {
      summary: other,
      turns: [],
      queuedMessages: [],
      olderTurnsCursor: null,
      draft: null,
    };
    render(voiceThreadRoute());

    const textarea = (await screen.findByRole("textbox", {
      name: "Сообщение для Codex",
    })) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea).toHaveValue("Начало конец"));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Включить автоотправку голосового ввода",
      }),
    );
    expect(localStorage.getItem("codexnest.voiceInputMode")).toBe("send");
    textarea.setSelectionRange(7, 7);
    fireEvent.select(textarea);
    fireEvent.click(screen.getByRole("button", { name: "Начать запись" }));
    await screen.findByRole("button", { name: "Остановить запись" });
    fireEvent.click(screen.getByRole("link", { name: "Открыть B" }));

    await screen.findByRole("heading", { name: "Другая задача" });
    await waitFor(() => expect(api.createVoiceTranscription).toHaveBeenCalledOnce());
    expect(context.queueVoiceRecording).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread",
        draft: expect.objectContaining({ input: "Начало конец" }),
      }),
    );
    expect(api.updateThreadDraft).not.toHaveBeenCalled();
    expect(api.createVoiceTranscription).toHaveBeenCalledWith(
      "thread",
      expect.objectContaining({ type: "audio/webm;codecs=opus" }),
      expect.objectContaining({
        mode: "send",
        selectionStart: 7,
        selectionEnd: 7,
        draftUpdatedAt: expect.any(Number),
      }),
    );
    expect(screen.getByRole("button", { name: "Начать запись" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).not.toHaveAttribute(
      "readonly",
    );
    resolveAccepted?.({
      id: "voice",
      threadId: "thread",
      mode: "send",
      status: "queued",
      createdAt: Date.now(),
      startedAt: null,
      audioDurationMs: 1,
      estimatedTotalSeconds: null,
      error: null,
    });
  });

  it.each([
    { running: false, autoSend: false, expectedMode: "draft", chatProgress: false },
    { running: false, autoSend: true, expectedMode: "send", chatProgress: true },
    { running: true, autoSend: false, expectedMode: "queue", chatProgress: true },
    { running: true, autoSend: true, expectedMode: "steer", chatProgress: true },
  ] as const)(
    "routes voice to $expectedMode when running=$running and autoSend=$autoSend",
    async ({ running, autoSend, expectedMode, chatProgress }) => {
      installMediaRecorder(async () => {
        return { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
      });
      const api = threadApi();
      api.createVoiceTranscription.mockImplementation(() => new Promise(() => undefined));
      const thread = running
        ? { ...summary, state: "running" as const, currentTurnId: "turn" }
        : summary;
      mockThreadConnection(api, thread, {
        draft: {
          input: "Черновик",
          images: [],
          goalMode: false,
          annotations: [],
          updatedAt: 1,
        },
      });
      const view = render(voiceThreadRoute());
      await waitFor(() =>
        expect(
          screen.getByRole("textbox", {
            name: running ? "Направить текущую задачу" : "Сообщение для Codex",
          }),
        ).toHaveValue("Черновик"),
      );
      if (autoSend) {
        fireEvent.click(
          screen.getByRole("button", {
            name: "Включить автоотправку голосового ввода",
          }),
        );
      }

      fireEvent.click(screen.getByRole("button", { name: "Начать запись" }));
      fireEvent.click(await screen.findByRole("button", { name: "Остановить запись" }));

      await waitFor(() =>
        expect(api.createVoiceTranscription).toHaveBeenCalledWith(
          "thread",
          expect.any(Blob),
          expect.objectContaining({ mode: expectedMode }),
        ),
      );
      expect(Boolean(view.container.querySelector(".voice-transcription-message"))).toBe(
        chatProgress,
      );
    },
  );

  it("uses the agent state at recording stop rather than recording start", async () => {
    installMediaRecorder(async () => {
      return { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    });
    const api = threadApi();
    api.createVoiceTranscription.mockImplementation(() => new Promise(() => undefined));
    const context = mockThreadConnection(api, summary);
    const view = render(voiceThreadRoute());

    fireEvent.click(screen.getByRole("button", { name: "Начать запись" }));
    const stop = await screen.findByRole("button", { name: "Остановить запись" });
    const running = { ...summary, state: "running" as const, currentTurnId: "turn" };
    context.state.snapshot.threads = [running];
    context.state.details.thread.summary = running;
    view.rerender(voiceThreadRoute());
    fireEvent.click(stop);

    await waitFor(() =>
      expect(api.createVoiceTranscription).toHaveBeenCalledWith(
        "thread",
        expect.any(Blob),
        expect.objectContaining({ mode: "queue" }),
      ),
    );
  });

  it("blocks for a remote voice job without presenting it as a local recording", async () => {
    const context = mockThreadConnection(threadApi(), summary);
    context.state.snapshot.voiceTranscriptions = [
      {
        id: "voice",
        threadId: "thread",
        mode: "draft",
        status: "queued",
        createdAt: Date.now(),
        startedAt: null,
        audioDurationMs: 2_000,
        estimatedTotalSeconds: null,
        error: null,
      },
    ];
    const view = render(voiceThreadRoute());

    const microphone = view.container.querySelector<HTMLButtonElement>("button.microphone");
    expect(microphone).not.toBeNull();
    expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).toHaveAttribute(
      "readonly",
    );
    expect(microphone!).toBeDisabled();
    expect(within(microphone!).queryByText("0:00")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Отменить обработку записи" }));
    await waitFor(() =>
      expect(context.api.cancelVoiceTranscription).toHaveBeenCalledWith("thread"),
    );
  });

  it.each(["send", "queue", "steer"] as const)(
    "restores a %s transcription countdown as a user bubble",
    async (mode) => {
      const context = mockThreadConnection(threadApi(), {
        ...summary,
        state: "completed",
        unread: true,
      });
      context.state.snapshot.voiceTranscriptions = [
        {
          id: "voice",
          threadId: "thread",
          mode,
          status: "queued",
          createdAt: Date.now(),
          startedAt: null,
          audioDurationMs: 2_000,
          estimatedTotalSeconds: 10,
          error: null,
        },
      ];
      const view = render(voiceThreadRoute());

      const queued = await screen.findByRole("status", { name: "На сервере · ожидание" });
      expect(queued).toHaveTextContent("0:00");

      context.state.snapshot.voiceTranscriptions[0] = {
        ...context.state.snapshot.voiceTranscriptions[0]!,
        status: "transcribing",
        startedAt: Date.now() - 2_000,
      };
      view.rerender(voiceThreadRoute());

      const progress = await screen.findByRole("status", { name: "Распознаём" });
      expect(progress).toHaveClass("message", "userMessage", "voice-transcription-message");
      expect(progress).toHaveTextContent("Распознаём");
      expect(progress).toHaveTextContent("≈0:08");
      expect(view.container.querySelector(".composer .microphone")).not.toHaveClass("timing");
      expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).toHaveAttribute(
        "readonly",
      );
      expect(screen.queryByRole("button", { name: "Закончить" })).toBeNull();
    },
  );

  it("hides an automatic transcription bubble once its queued message materializes", () => {
    const context = mockThreadConnection(threadApi(), summary, {
      queuedMessages: [
        {
          id: "voice",
          threadId: "thread",
          text: "Распознанный текст",
          createdAt: Date.now(),
          status: "queued",
        },
      ],
    });
    context.state.snapshot.voiceTranscriptions = [
      {
        id: "voice",
        threadId: "thread",
        mode: "send",
        status: "applying",
        createdAt: Date.now() - 3_000,
        startedAt: Date.now() - 2_000,
        audioDurationMs: 2_000,
        estimatedTotalSeconds: 2,
        error: null,
      },
    ];
    const view = render(voiceThreadRoute());

    expect(view.container.querySelector(".voice-transcription-message")).toBeNull();
    expect(screen.getByText("Распознанный текст")).toBeInTheDocument();
  });

  it("restores a failed voice job without keeping the composer locked", async () => {
    installMediaRecorder(async () => {
      return { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    });
    const context = mockThreadConnection(threadApi(), summary);
    context.state.snapshot.voiceTranscriptions = [
      {
        id: "voice",
        threadId: "thread",
        mode: "draft",
        status: "failed",
        createdAt: Date.now(),
        startedAt: Date.now(),
        audioDurationMs: 2_000,
        estimatedTotalSeconds: null,
        error: "No speech was detected in the recording",
      },
    ];
    render(voiceThreadRoute());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "В записи не обнаружена речь. Проверьте микрофон и запишите ещё раз.",
    );
    expect(alert).toHaveClass("voice-transcription-error");
    expect(alert.querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).not.toHaveAttribute(
      "readonly",
    );
    expect(screen.getByRole("button", { name: "Начать запись" })).toBeEnabled();
  });

  it("refreshes the draft after a background transcription completes", async () => {
    const context = mockThreadConnection(threadApi(), summary);
    const view = render(voiceThreadRoute());
    await screen.findByRole("textbox", { name: "Сообщение для Codex" });
    context.refreshDetail.mockClear();

    context.state.voiceRemovals.thread = {
      jobId: "voice-draft",
      outcome: "draft",
    };
    view.rerender(voiceThreadRoute());

    await waitFor(() =>
      expect(context.refreshDetail).toHaveBeenCalledWith("thread", { force: true }),
    );
  });

  it("clears text and images after background auto-send before refreshing the draft", async () => {
    let finishLocalDraftDelete: (() => void) | undefined;
    deleteLocalDraft.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishLocalDraftDelete = resolve;
        }),
    );
    const api = threadApi();
    const context = mockThreadConnection(api, summary, {
      draft: {
        input: "Текст и голос",
        images: [
          {
            id: "voice-image",
            name: "screenshot.png",
            url: "data:image/png;base64,AA==",
          },
        ],
        goalMode: false,
        annotations: [],
        updatedAt: 1,
      },
    });
    const view = render(voiceThreadRoute());
    const textarea = await screen.findByRole("textbox", {
      name: "Сообщение для Codex",
    });
    await waitFor(() => expect(textarea).toHaveValue("Текст и голос"));
    expect(screen.getByAltText("screenshot.png")).toBeInTheDocument();
    context.dispatch.mockClear();
    context.refreshDetail.mockClear();

    context.state.voiceRemovals.thread = {
      jobId: "voice-send",
      outcome: "send",
    };
    view.rerender(voiceThreadRoute());

    await waitFor(() => expect(textarea).toHaveValue(""));
    expect(screen.queryByAltText("screenshot.png")).toBeNull();
    expect(context.dispatch).toHaveBeenCalledWith({
      type: "draft",
      threadId: "thread",
      draft: null,
    });
    expect(deleteLocalDraft).toHaveBeenCalledWith(api.settings, "thread");
    expect(context.refreshDetail).not.toHaveBeenCalled();

    await act(async () => finishLocalDraftDelete?.());

    expect(context.refreshDetail).toHaveBeenCalledWith("thread", { force: true });
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
        <Route path="/" element={<div>Нет открытых сессий</div>} />
      </Routes>
    </MemoryRouter>
  );
}

function forkThreadRoute() {
  return (
    <MemoryRouter initialEntries={["/threads/thread"]}>
      <Routes>
        <Route
          path="/threads/:threadId"
          element={
            <>
              <ThreadPage onOpenNavigation={() => undefined} />
              <ForkLocation />
            </>
          }
        />
        <Route path="/fork-operations/:operationId" element={<ForkLocation />} />
      </Routes>
    </MemoryRouter>
  );
}

function ForkLocation() {
  const location = useLocation();
  return (
    <output data-testid="fork-location">
      {location.pathname}:
      {String((location.state as { focusComposer?: unknown } | null)?.focusComposer === true)}
    </output>
  );
}

function voiceThreadRoute() {
  return (
    <MemoryRouter initialEntries={["/threads/thread"]}>
      <Link to="/threads/thread">Открыть A</Link>
      <Link to="/threads/other">Открыть B</Link>
      <Routes>
        <Route
          path="/threads/:threadId"
          element={
            <ThreadPage
              transcriptionConfig={transcriptionConfig}
              transcriptionProvider="local"
              onOpenNavigation={() => undefined}
            />
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

const transcriptionConfig: TranscriptionConfigResponse = {
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
    sampleCount: 5,
    estimatedFixedProcessingMs: 2_000,
    estimatedProcessingMsPerAudioSecond: 4_000,
  },
};

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

function completedPlanDetail(): NonNullable<Parameters<typeof mockThreadConnection>[2]> {
  return {
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
  };
}

function threadApi() {
  return {
    settings: { baseUrl: "https://codex.home.arpa", token: "secret" },
    createDownload: vi.fn().mockResolvedValue({
      downloadUrl: "/downloads/ticket/file.bin",
      expiresAt: Date.now() + 60_000,
    }),
    estimateFork: vi.fn().mockResolvedValue({
      sourceBytes: 1_000,
      compressed: {
        available: true,
        estimatedBytes: 300,
        estimatedSeconds: { minSeconds: 1, maxSeconds: 2 },
        unavailableReason: null,
      },
      exact: {
        available: true,
        estimatedBytes: 1_000,
        estimatedSeconds: { minSeconds: 2, maxSeconds: 4 },
        unavailableReason: null,
      },
    }),
    createForkOperation: vi.fn().mockResolvedValue({
      operation: {
        id: "operation",
        sourceThreadId: "thread",
        lastTurnId: "turn",
        agentMessageId: "answer",
        mode: "compressed",
        status: "preparing",
        title: "",
        createdAt: 1,
        updatedAt: 1,
        targetThreadId: null,
        queuedMessageCount: 0,
        estimate: null,
        error: null,
      },
    }),
    startTurn: vi.fn().mockResolvedValue({ turnId: "turn" }),
    updateThreadDraft: vi
      .fn()
      .mockImplementation((_id, draft) =>
        Promise.resolve(
          draft.input || draft.images.length || draft.goalMode || draft.annotations.length
            ? { ...draft, updatedAt: Date.now() }
            : null,
        ),
      ),
    enqueue: vi.fn().mockResolvedValue({ id: "queued" }),
    sendQueuedNow: vi.fn().mockResolvedValue({ turnId: "turn" }),
    updateQueued: vi.fn().mockResolvedValue({ id: "queued" }),
    deleteQueued: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn().mockResolvedValue(undefined),
    updateThread: vi.fn().mockResolvedValue(summary),
    updateThreadSettings: vi.fn().mockImplementation((_id, patch) =>
      Promise.resolve({
        ...summary,
        settings: { ...summary.settings, ...patch },
      }),
    ),
    archive: vi.fn().mockResolvedValue(undefined),
    markRead: vi.fn().mockResolvedValue(undefined),
    markViewed: vi.fn().mockResolvedValue(undefined),
    readGitChanges: vi
      .fn()
      .mockResolvedValue({ state: "clean", filesChanged: 0, additions: 0, deletions: 0 }),
    readThreadArtifacts: vi.fn().mockResolvedValue({ capability: "explicit", artifacts: [] }),
    readGoal: vi.fn().mockResolvedValue(null),
    updateGoal: vi.fn().mockResolvedValue(null),
    clearGoal: vi.fn().mockResolvedValue(undefined),
    transcribe: vi.fn().mockResolvedValue({
      text: "голос",
      timingEstimate: {
        sampleCount: 5,
        estimatedFixedProcessingMs: 2_000,
        estimatedProcessingMsPerAudioSecond: 4_000,
      },
    }),
    createVoiceTranscription: vi.fn().mockResolvedValue({
      id: "voice",
      threadId: "thread",
      mode: "draft",
      status: "queued",
      createdAt: Date.now(),
      startedAt: null,
      audioDurationMs: 1_000,
      estimatedTotalSeconds: null,
      error: null,
    }),
    cancelVoiceTranscription: vi.fn().mockResolvedValue(undefined),
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
      itemsLoaded?: boolean;
    }>;
    queuedMessages: Array<{
      id: string;
      threadId: string;
      text: string;
      images?: string[];
      createdAt: number;
      status: "queued" | "dispatching";
    }>;
    olderTurnsCursor: string | null;
    draft: ThreadDetail["draft"];
    attention: AttentionRequest[];
  }> = {},
) {
  const detail = {
    summary: thread,
    turns: detailPatch.turns ?? [],
    queuedMessages: detailPatch.queuedMessages ?? [],
    olderTurnsCursor: detailPatch.olderTurnsCursor ?? null,
    draft: detailPatch.draft ?? null,
  };
  const value = {
    api,
    appActive: true,
    foregroundEpoch: 0,
    streamRecoveryEpoch: 0,
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
        voiceTranscriptions: [] as VoiceTranscriptionJob[],
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
      voiceRemovals: {} as Record<
        string,
        { jobId: string; outcome: "draft" | "send" | "cancelled" }
      >,
      network: "connected",
      snapshotEpoch: 1,
    },
    refreshDetail: vi.fn().mockResolvedValue(detail),
    forceRefreshDetail: vi.fn().mockResolvedValue(detail),
    loadOlderDetail: vi.fn().mockResolvedValue(detail),
    loadTurnItems: vi.fn().mockResolvedValue(undefined),
    sendReliable: vi
      .fn()
      .mockImplementation((threadId, body) =>
        thread.currentTurnId ? api.enqueue(threadId, body) : api.startTurn(threadId, body),
      ),
    queueVoiceRecording: vi.fn().mockImplementation((recording) =>
      api.createVoiceTranscription(recording.threadId, recording.audio, {
        recordingDurationMs: recording.durationMs,
        mode: recording.mode,
        selectionStart: recording.selectionStart,
        selectionEnd: recording.selectionEnd,
        draftUpdatedAt: recording.draftUpdatedAt,
        clientUploadId: recording.id,
      }),
    ),
    pendingVoiceRecordingThreadIds: [] as string[],
    pendingVoiceRecordingErrors: {} as Record<string, string>,
    retryPendingVoiceRecording: vi.fn().mockResolvedValue(undefined),
    dispatch: vi.fn(),
  };
  connection.mockReturnValue(value);
  return value;
}

function pendingAnnotation(overrides: Partial<PendingAnnotation> = {}): PendingAnnotation {
  return {
    id: "annotation",
    messageId: "agent-answer",
    source: "agentMessage",
    quote: "фрагмент ответа",
    startOffset: 8,
    endOffset: 23,
    comment: "Уточни формулировку",
    createdAt: 1,
    ...overrides,
  };
}

function completedAgentTurn() {
  return {
    id: "completed-turn",
    status: "completed" as const,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
    progress: progress(),
    items: [
      {
        type: "agentMessage" as const,
        id: "agent-answer",
        status: "completed" as const,
        text: "Готовый фрагмент ответа",
        images: [],
        timestamp: 2,
        phase: "final_answer" as const,
      },
    ],
  };
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

function selectText(element: HTMLElement, start: number, end: number) {
  const node = element.firstChild!;
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}
