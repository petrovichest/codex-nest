import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadSearchOccurrence, ThreadSearchPage, ThreadSummary } from "@codexnest/protocol";
import { ThreadSearchDialog } from "./ThreadSearchDialog";

const connection = vi.hoisted(() => vi.fn());
vi.mock("../connection", () => ({ useConnection: connection }));
const thread = {
  id: "outside",
  title: "Старая задача",
  cwd: "/work/other",
  updatedAt: 1000,
  archived: false,
} as ThreadSummary;
const occurrence: ThreadSearchOccurrence = {
  turnId: "old-turn",
  itemId: "old-item",
  snippet: "😀совпадение",
  snippetMatchRange: { start: 2, end: 12 },
  turnCursor: "target-cursor",
};
const api = { searchThreads: vi.fn(), searchOccurrences: vi.fn() };

beforeEach(() => {
  vi.resetAllMocks();
  connection.mockReturnValue({ api, state: { snapshot: { instanceId: "instance" } } });
  api.searchThreads.mockImplementation(async (_term, archived) => ({
    data: archived ? [] : [{ thread, snippet: "Нужный фрагмент" }],
    nextCursor: archived ? null : "next",
  }));
  api.searchOccurrences.mockResolvedValue({ data: [occurrence], nextCursor: null });
});

function LocationProbe() {
  const location = useLocation();
  return (
    <output aria-label="route">
      {location.pathname}:{JSON.stringify(location.state)}
    </output>
  );
}

describe("ThreadSearchDialog", () => {
  it("submits only explicitly, paginates groups independently, and navigates via an occurrence cursor", async () => {
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <ThreadSearchDialog open onClose={onClose} onNavigate={vi.fn()} />
        <LocationProbe />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Текст для поиска" }), {
      target: { value: "needle" },
    });
    expect(api.searchThreads).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Найти" }));
    expect(await screen.findByText("Нужный фрагмент")).toBeInTheDocument();
    expect(api.searchThreads.mock.calls).toEqual([
      ["needle", false, undefined],
      ["needle", true, undefined],
    ]);
    expect(api.searchOccurrences).not.toHaveBeenCalled();
    api.searchThreads.mockResolvedValueOnce({ data: [], nextCursor: null });
    fireEvent.click(
      within(screen.getByRole("region", { name: "Не в архиве" })).getByRole("button", {
        name: "Показать ещё",
      }),
    );
    await waitFor(() =>
      expect(api.searchThreads).toHaveBeenLastCalledWith("needle", false, "next"),
    );
    fireEvent.click(screen.getByRole("button", { name: /Нужный фрагмент/ }));
    await waitFor(() =>
      expect(api.searchOccurrences).toHaveBeenCalledExactlyOnceWith("outside", "needle", undefined),
    );
    const match = await screen.findByText("совпадение");
    expect(match.tagName).toBe("MARK");
    fireEvent.click(match);
    expect(screen.getByLabelText("route")).toHaveTextContent("/threads/outside");
    expect(screen.getByLabelText("route")).toHaveTextContent('"turnCursor":"target-cursor"');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("ignores stale queries and retains results while the dialog is closed", async () => {
    let resolveOld!: (page: ThreadSearchPage) => void;
    api.searchThreads.mockImplementationOnce(
      () =>
        new Promise<ThreadSearchPage>((resolve) => {
          resolveOld = resolve;
        }),
    );
    const view = (open: boolean) => (
      <MemoryRouter>
        <ThreadSearchDialog open={open} onClose={vi.fn()} onNavigate={vi.fn()} />
      </MemoryRouter>
    );
    const rendered = render(view(true));
    const input = screen.getByRole("textbox", { name: "Текст для поиска" });
    fireEvent.change(input, { target: { value: "old" } });
    fireEvent.click(screen.getByRole("button", { name: "Найти" }));
    fireEvent.change(input, { target: { value: "new" } });
    fireEvent.click(screen.getByRole("button", { name: "Найти" }));
    await screen.findByText("Нужный фрагмент");
    await act(async () =>
      resolveOld({ data: [{ thread, snippet: "Устаревший фрагмент" }], nextCursor: null }),
    );
    expect(screen.queryByText("Устаревший фрагмент")).not.toBeInTheDocument();
    rendered.rerender(view(false));
    rendered.rerender(view(true));
    expect(screen.getByText("Нужный фрагмент")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Текст для поиска" })).toHaveValue("new");
    expect(api.searchThreads).toHaveBeenCalledTimes(4);
  });
});
