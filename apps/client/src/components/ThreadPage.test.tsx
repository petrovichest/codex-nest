import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import type {
  AttentionRequest,
  ThreadDetail,
  ThreadDraft,
  ThreadSummary,
  TurnProgress,
  UpdateThreadDraftRequest,
} from "@codexnest/protocol";

import { annotationStorageKey, type PendingAnnotation } from "../annotations";
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
  unseen: false,
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
  localStorage.clear();
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

  it("keeps the inspector closed until the user opens it on wide screens", () => {
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
    mockThreadConnection(threadApi(), summary);
    renderThread();

    expect(screen.queryByLabelText("Сведения о задаче")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Показать сведения" }));
    expect(screen.getByLabelText("Сведения о задаче")).toBeInTheDocument();
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

  it("restores the complete server draft and debounces text autosave", async () => {
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

    fireEvent.change(textbox, { target: { value: "Обновлённый текст" } });
    expect(api.updateThreadDraft).not.toHaveBeenCalled();
    await new Promise((resolve) => window.setTimeout(resolve, 520));
    await waitFor(() =>
      expect(api.updateThreadDraft).toHaveBeenCalledWith(
        "thread",
        expect.objectContaining({
          input: "Обновлённый текст",
          images: [expect.objectContaining({ name: "draft.png" })],
          goalMode: true,
          annotations: [annotation],
        }),
        { keepalive: false },
      ),
    );
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

    expect(screen.getByRole("button", { name: "Да, реализуй этот план" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    await waitFor(() =>
      expect(api.startTurn).toHaveBeenCalledWith(
        "thread",
        expect.objectContaining({ input: expect.stringContaining("### Аннотация 1") }),
      ),
    );
    expect(api.updateThreadSettings).not.toHaveBeenCalled();
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
    expect(message).toHaveAttribute("data-message-id", optimistic.id);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "nearest" });

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

  it("reloads the open chat for a reconnect snapshot epoch", async () => {
    const api = threadApi();
    const context = mockThreadConnection(api, summary);
    const view = renderThread();
    await waitFor(() => expect(context.refreshDetail).toHaveBeenCalledTimes(1));

    context.state.snapshotEpoch += 1;
    view.rerender(threadRoute());

    await waitFor(() => expect(context.refreshDetail).toHaveBeenCalledTimes(2));
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
        <Route path="/" element={<div>Нет открытых сессий</div>} />
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
