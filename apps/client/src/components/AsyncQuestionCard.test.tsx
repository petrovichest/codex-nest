import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  asyncQuestionReplyMessageId,
  type ActivityItem,
  type ThreadDetail,
} from "@codexnest/protocol";

import { initialState } from "../state";
import { AsyncQuestionCard } from "./AsyncQuestionCard";

const connection = vi.hoisted(() => vi.fn());
vi.mock("../connection", () => ({ useConnection: connection }));

const item: Extract<ActivityItem, { text: string }> = {
  type: "agentMessage",
  id: "live-item",
  text: "",
  status: "completed",
  images: [],
  timestamp: 1,
  phase: "commentary",
  delivery: "async",
  questionKey: "stable-key",
  questions: [{ title: "Как проверять?", options: ["Быстро", "Подробно"] }],
};
const replyId = asyncQuestionReplyMessageId("thread", "turn", "stable-key");

function setup() {
  const state = structuredClone(initialState);
  state.details.thread = {
    turns: [],
    queuedMessages: [],
    draft: {
      input: "Основной черновик",
      images: [],
      annotations: [],
      goalMode: false,
      updatedAt: 1,
    },
  } as unknown as ThreadDetail;
  const context = {
    state,
    dispatch: vi.fn(),
    api: { sendQueuedNow: vi.fn().mockResolvedValue({ turnId: "turn" }) },
    sendReliable: vi.fn().mockImplementation(async (_id, _body, committed) => {
      committed();
      return "delivered";
    }),
    retryReliableMessage: vi.fn().mockResolvedValue(undefined),
  };
  connection.mockReturnValue(context);
  return context;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("AsyncQuestionCard", () => {
  it("preserves answer choices while direct input is unavailable", async () => {
    const context = setup();
    context.state.details.thread!.summary = {
      canAcceptDirectInput: false,
    } as ThreadDetail["summary"];
    context.state.details.thread!.version = { instanceId: "instance", sequence: 6 };
    context.state.snapshot = {
      instanceId: "instance",
      sequence: 5,
      threads: [{ id: "thread", canAcceptDirectInput: true }],
    } as NonNullable<typeof context.state.snapshot>;
    const view = render(
      <AsyncQuestionCard item={item} threadId="thread" turnId="turn" readOnly={false} />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Подробно" }));
    expect(screen.getByRole("button", { name: "Ответить" })).toBeDisabled();
    expect(context.sendReliable).not.toHaveBeenCalled();
    context.state.details.thread!.summary.canAcceptDirectInput = true;
    view.rerender(
      <AsyncQuestionCard item={item} threadId="thread" turnId="turn" readOnly={false} />,
    );
    expect(screen.getByRole("radio", { name: "Подробно" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Ответить" }));
    await waitFor(() => expect(context.sendReliable).toHaveBeenCalledOnce());
  });
  it("requires an explicit submit and preserves the main draft", async () => {
    const context = setup();
    const draft = structuredClone(context.state.details.thread!.draft);
    const view = render(
      <AsyncQuestionCard item={item} threadId="thread" turnId="turn" readOnly={false} />,
    );
    expect(screen.getByRole("radio", { name: "Быстро" })).toBeChecked();
    expect(context.sendReliable).not.toHaveBeenCalled();
    const submit = screen.getByRole("button", { name: "Ответить" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    await waitFor(() => expect(context.sendReliable).toHaveBeenCalledOnce());
    expect(context.sendReliable).toHaveBeenCalledWith(
      "thread",
      {
        input: "Как проверять?\nБыстро",
        clientMessageId: replyId,
        replyToAsyncQuestion: { turnId: "turn", itemId: "live-item" },
      },
      expect.any(Function),
    );
    expect(context.state.details.thread!.draft).toEqual(draft);
    expect(screen.getByRole("status")).toHaveTextContent("Ответ сохранён на устройстве");
    context.state.details.thread!.queuedMessages = [
      {
        id: replyId,
        threadId: "thread",
        text: "Как проверять?\nБыстро",
        createdAt: 1,
        status: "queued",
      },
    ];
    view.rerender(
      <AsyncQuestionCard item={item} threadId="thread" turnId="turn" readOnly={false} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Ответ принят сервером");
    expect(screen.queryByText("Ответ доставлен Codex")).not.toBeInTheDocument();
  });

  it("sends choices and custom text together and keeps them after an unsaved failure", async () => {
    const context = setup();
    context.sendReliable.mockRejectedValueOnce(new Error("Не удалось сохранить сообщение"));
    const multiple = {
      ...item,
      questions: [...item.questions!, { title: "Что проверить?", options: null }],
    };
    render(<AsyncQuestionCard item={multiple} threadId="thread" turnId="turn" readOnly={false} />);
    expect(screen.getByRole("button", { name: "Ответить" })).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: "Свой ответ" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Как проверять?" }), {
      target: { value: "Вручную" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Что проверить?" }), {
      target: { value: "Черновик" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ответить" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("textbox", { name: "Что проверить?" })).toHaveValue("Черновик");
    fireEvent.click(screen.getByRole("button", { name: "Ответить" }));
    await waitFor(() => expect(context.sendReliable).toHaveBeenCalledTimes(2));
    expect(context.sendReliable.mock.calls[1]?.[1]).toMatchObject({
      input: "Как проверять?\nВручную\n\nЧто проверить?\nЧерновик",
      clientMessageId: replyId,
    });
  });

  it("recognizes a delivered reply after item renumbering and a later turn", () => {
    const context = setup();
    context.state.details.thread!.turns = [
      {
        id: "follow-up",
        status: "completed",
        startedAt: 1,
        completedAt: 2,
        durationMs: 1,
        progress: {
          startedAt: 1,
          explanation: null,
          steps: [],
          filesChanged: 0,
          additions: 0,
          deletions: 0,
        },
        items: [
          {
            type: "userMessage",
            id: replyId,
            text: "Как проверять?\nПодробно",
            status: "completed",
            images: [],
            phase: null,
            timestamp: 2,
          },
        ],
      },
    ];
    render(
      <AsyncQuestionCard
        item={{ ...item, id: "item-12" }}
        threadId="thread"
        turnId="turn"
        readOnly={false}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Ответ доставлен Codex");
    expect(screen.queryByRole("button", { name: "Ответить" })).not.toBeInTheDocument();
    expect(context.sendReliable).not.toHaveBeenCalled();
  });

  it("shows a saved failure after remount and retries its original message", async () => {
    const context = setup();
    context.state.optimisticMessages.thread = [
      {
        id: replyId,
        threadId: "thread",
        text: "Как проверять?\nБыстро",
        images: [],
        createdAt: 1,
        destination: "queue",
        turnId: null,
        deliveryError: { message: "Не отправлено", retryable: false },
      },
    ];
    render(<AsyncQuestionCard item={item} threadId="thread" turnId="turn" readOnly={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Повторить отправку" }));
    await waitFor(() =>
      expect(context.retryReliableMessage).toHaveBeenCalledWith("thread", replyId),
    );
    expect(context.sendReliable).not.toHaveBeenCalled();
  });

  it("renders read-only questions without submitting or selecting answers", () => {
    const context = setup();
    render(<AsyncQuestionCard item={item} threadId="thread" turnId="turn" readOnly />);
    expect(screen.getByText("Как проверять?")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(context.sendReliable).not.toHaveBeenCalled();
  });
});
