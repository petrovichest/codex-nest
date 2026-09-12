import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SearchHistoryView } from "./ThreadPage";
import type { SearchTarget } from "./ThreadSearchDialog";
import type { ThreadSearchTurn } from "@codexnest/protocol";

const connection = vi.hoisted(() => vi.fn());
vi.mock("../connection", () => ({ useConnection: connection }));
const target: SearchTarget = {
  threadId: "thread",
  query: "needle",
  instanceId: "instance",
  occurrence: {
    turnId: "old",
    itemId: "match",
    snippet: "needle",
    snippetMatchRange: { start: 0, end: 6 },
    turnCursor: "cursor",
  },
};
const result: ThreadSearchTurn = {
  instanceId: "instance",
  turn: {
    id: "old",
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
        type: "agentMessage",
        id: "match",
        text: "Исторический ответ",
        images: [],
        phase: "final_answer",
        status: "completed",
        timestamp: 2,
      },
    ],
  },
};

describe("SearchHistoryView", () => {
  it("keeps targeted history separate from canonical details and ignores live tail updates", async () => {
    const api = { readSearchTurn: vi.fn().mockResolvedValue(result) };
    const state = {
      snapshot: { instanceId: "instance", sequence: 1 },
      details: { thread: { turns: ["latest"], olderTurnsCursor: "canonical" } },
    };
    connection.mockReturnValue({ api, state });
    const view = render(<SearchHistoryView target={target} onReturn={vi.fn()} />);
    expect(await screen.findByText("Исторический ответ")).toBeInTheDocument();
    expect(view.container.querySelector(".search-history-match")).toHaveAttribute(
      "data-search-item-id",
      "match",
    );
    state.snapshot.sequence++;
    view.rerender(<SearchHistoryView target={target} onReturn={vi.fn()} />);
    expect(api.readSearchTurn).toHaveBeenCalledExactlyOnceWith("thread", "old", "cursor");
    expect(state.details.thread).toEqual({ turns: ["latest"], olderTurnsCursor: "canonical" });
  });

  it("drops a stale target response and offers a fallback for changed server history", async () => {
    let resolve!: (value: ThreadSearchTurn) => void;
    const api = {
      readSearchTurn: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<ThreadSearchTurn>((done) => {
              resolve = done;
            }),
        )
        .mockRejectedValueOnce(new Error("Search result changed")),
    };
    connection.mockReturnValue({ api, state: { snapshot: { instanceId: "instance" } } });
    const view = render(<SearchHistoryView target={target} onReturn={vi.fn()} />);
    view.rerender(
      <SearchHistoryView
        target={{ ...target, occurrence: { ...target.occurrence, turnId: "other" } }}
        onReturn={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Search result changed"),
    );
    await act(async () => resolve(result));
    expect(screen.queryByText("Исторический ответ")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "К текущему диалогу" })).toBeEnabled();
  });
});
