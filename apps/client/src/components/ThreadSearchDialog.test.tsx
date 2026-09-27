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
  api.searchThreads.mockImplementation(async (_term, archived, _cursor, scope) => ({
    data: archived || scope === "titles" ? [] : [{ thread, snippet: "Нужный фрагмент" }],
    nextCursor: archived || scope === "titles" ? null : "next",
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

function submitSearch(query = "хедеры") {
  fireEvent.change(screen.getByRole("textbox", { name: "Текст для поиска" }), {
    target: { value: query },
  });
  fireEvent.click(screen.getByRole("button", { name: "Найти" }));
}

describe("ThreadSearchDialog", () => {
  it.each([false, true])("opens a title-only match directly (archived: %s)", async (archived) => {
    const found = {
      ...thread,
      archived,
      title: "Обновить хедеры MEXC и задеплоить",
      preview: "надо обновить хедерсы",
    };
    api.searchThreads.mockImplementation(async (_term, groupArchived, _cursor, scope) => ({
      data:
        groupArchived === archived && scope === "titles" ? [{ thread: found, snippet: "" }] : [],
      nextCursor: null,
    }));
    render(
      <MemoryRouter>
        <ThreadSearchDialog open onClose={vi.fn()} onNavigate={vi.fn()} />
        <LocationProbe />
      </MemoryRouter>,
    );
    submitSearch();
    const group = within(screen.getByRole("region", { name: archived ? "Архив" : "Не в архиве" }));
    fireEvent.click(await group.findByRole("button", { name: /Обновить хедеры/ }));
    expect(screen.getAllByText(found.title)).toHaveLength(1);
    expect(screen.getByLabelText("route")).toHaveTextContent("/threads/outside:null");
    expect(api.searchOccurrences).not.toHaveBeenCalled();
  });

  it("finishes title pagination before messages and deduplicates across sources and pages", async () => {
    const titles = Array.from({ length: 21 }, (_, i) => ({
      thread: { ...thread, id: `title-${i}`, title: `Название ${i}`, updatedAt: 1000 - i },
      snippet: "",
    }));
    const message = {
      thread: { ...thread, id: "message", title: "Переписка", updatedAt: 2000 },
      snippet: "Фрагмент",
    };
    api.searchThreads.mockImplementation(async (_term, archived, cursor, scope) => {
      if (archived)
        return { data: [], nextCursor: scope === "titles" && !cursor ? "archive-next" : null };
      if (scope === "titles")
        return cursor
          ? { data: [titles[20]], nextCursor: null }
          : { data: titles.slice(0, 20), nextCursor: "titles-next" };
      return cursor
        ? {
            data: [
              message,
              titles[0],
              { ...message, thread: { ...message.thread, id: "last", title: "Последняя" } },
            ],
            nextCursor: null,
          }
        : { data: [titles[0], message, message], nextCursor: "messages-next" };
    });
    render(
      <MemoryRouter>
        <ThreadSearchDialog open onClose={vi.fn()} onNavigate={vi.fn()} />
      </MemoryRouter>,
    );
    submitSearch();
    const active = within(screen.getByRole("region", { name: "Не в архиве" }));
    const archive = within(screen.getByRole("region", { name: "Архив" }));
    await active.findByText("Название 19");
    expect(api.searchThreads).toHaveBeenCalledTimes(2);
    expect(archive.queryByText("Совпадений нет")).not.toBeInTheDocument();
    fireEvent.click(active.getByRole("button", { name: "Показать ещё" }));
    await active.findByText("Переписка");
    expect(api.searchThreads.mock.calls.slice(2)).toEqual([
      ["хедеры", false, "titles-next", "titles"],
      ["хедеры", false, undefined, "messages"],
    ]);
    expect(
      active
        .getAllByRole("button")
        .slice(0, -1)
        .map((button) => button.querySelector(".search-result-title")?.textContent),
    ).toEqual([...titles.map((entry) => entry.thread.title), "Переписка"]);
    fireEvent.click(active.getByRole("button", { name: "Показать ещё" }));
    await active.findByText("Последняя");
    expect(active.getAllByText("Название 0")).toHaveLength(1);
    expect(active.getAllByText("Переписка")).toHaveLength(1);
    expect(active.queryByRole("button", { name: "Показать ещё" })).not.toBeInTheDocument();
    fireEvent.click(archive.getByRole("button", { name: "Показать ещё" }));
    await archive.findByText("Совпадений нет");
    expect(api.searchThreads.mock.calls.slice(-2)).toEqual([
      ["хедеры", true, "archive-next", "titles"],
      ["хедеры", true, undefined, "messages"],
    ]);
  });

  it("retains results and retries only the failed source and cursor", async () => {
    let failTitles = true;
    let failMessages = true;
    api.searchThreads.mockImplementation(async (_term, archived, cursor, scope) => {
      if (archived) return { data: [], nextCursor: null };
      if (scope === "titles") {
        if (!cursor) return { data: [{ thread, snippet: "" }], nextCursor: "titles-next" };
        if (failTitles) {
          failTitles = false;
          throw new Error("Ошибка названий");
        }
        return { data: [], nextCursor: null };
      }
      if (failMessages) {
        failMessages = false;
        throw new Error("Ошибка сообщений");
      }
      return { data: [], nextCursor: null };
    });
    render(
      <MemoryRouter>
        <ThreadSearchDialog open onClose={vi.fn()} onNavigate={vi.fn()} />
      </MemoryRouter>,
    );
    submitSearch();
    const group = within(screen.getByRole("region", { name: "Не в архиве" }));
    await group.findByText(thread.title);
    fireEvent.click(group.getByRole("button", { name: "Показать ещё" }));
    await group.findByText("Ошибка названий");
    expect(group.getByText(thread.title)).toBeInTheDocument();
    fireEvent.click(group.getByRole("button", { name: "Повторить" }));
    await group.findByText("Ошибка сообщений");
    expect(group.getByText(thread.title)).toBeInTheDocument();
    fireEvent.click(group.getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(group.queryByRole("alert")).not.toBeInTheDocument());
    expect(api.searchThreads.mock.calls.filter((call) => !call[1])).toEqual([
      ["хедеры", false, undefined, "titles"],
      ["хедеры", false, "titles-next", "titles"],
      ["хедеры", false, "titles-next", "titles"],
      ["хедеры", false, undefined, "messages"],
      ["хедеры", false, undefined, "messages"],
    ]);
    expect(group.queryByText("Совпадений нет")).not.toBeInTheDocument();
    expect(group.queryByRole("button", { name: "Показать ещё" })).not.toBeInTheDocument();
  });

  it("discards pending title results when the instance changes", async () => {
    let resolveOld!: (page: ThreadSearchPage) => void;
    api.searchThreads.mockImplementationOnce(
      () =>
        new Promise<ThreadSearchPage>((resolve) => {
          resolveOld = resolve;
        }),
    );
    const view = () => (
      <MemoryRouter>
        <ThreadSearchDialog open onClose={vi.fn()} onNavigate={vi.fn()} />
      </MemoryRouter>
    );
    const rendered = render(view());
    submitSearch();
    connection.mockReturnValue({ api, state: { snapshot: { instanceId: "new-instance" } } });
    rendered.rerender(view());
    await act(async () => resolveOld({ data: [{ thread, snippet: "" }], nextCursor: null }));
    expect(screen.queryByText(thread.title)).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Текст для поиска" })).toHaveValue("");
    expect(api.searchThreads.mock.calls.filter((call) => !call[1])).toEqual([
      ["хедеры", false, undefined, "titles"],
    ]);
  });

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
      ["needle", false, undefined, "titles"],
      ["needle", true, undefined, "titles"],
      ["needle", false, undefined, "messages"],
      ["needle", true, undefined, "messages"],
    ]);
    expect(api.searchOccurrences).not.toHaveBeenCalled();
    api.searchThreads.mockResolvedValueOnce({ data: [], nextCursor: null });
    fireEvent.click(
      within(screen.getByRole("region", { name: "Не в архиве" })).getByRole("button", {
        name: "Показать ещё",
      }),
    );
    await waitFor(() =>
      expect(api.searchThreads).toHaveBeenLastCalledWith("needle", false, "next", "messages"),
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
    expect(api.searchThreads).toHaveBeenCalledTimes(6);
    expect(
      api.searchThreads.mock.calls.some(
        ([term, , , scope]) => term === "old" && scope === "messages",
      ),
    ).toBe(false);
  });
});
