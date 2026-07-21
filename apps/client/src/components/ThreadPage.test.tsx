import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import type { ThreadSummary } from "@codexnest/protocol";

import { Activity, ThreadPage } from "./ThreadPage";

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
  settings: { collaborationMode: "default" },
};

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
});

describe("Activity", () => {
  it("renders user and agent messages without legacy labels", () => {
    const { rerender } = render(
      <Activity
        item={{ type: "userMessage", id: "user", status: "completed", text: "Сообщение" }}
      />,
    );
    expect(screen.getByText("Сообщение").closest("article")).toHaveClass("userMessage");
    expect(screen.queryByText("Вы")).not.toBeInTheDocument();

    rerender(
      <Activity item={{ type: "agentMessage", id: "agent", status: "completed", text: "Ответ" }} />,
    );
    expect(screen.getByText("Ответ").closest("article")).toHaveClass("agentMessage");
    expect(screen.queryByText("Codex")).not.toBeInTheDocument();
  });

  it("keeps command output and file patches in compact details", () => {
    const { rerender } = render(
      <Activity
        item={{
          type: "command",
          id: "command",
          status: "completed",
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

  it("steers and interrupts a running task", async () => {
    const api = threadApi();
    mockThreadConnection(api, { ...summary, state: "running", currentTurnId: "turn" });
    renderThread();

    fireEvent.change(screen.getByRole("textbox", { name: "Направить текущую задачу" }), {
      target: { value: "Сначала проверь тесты" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Направить" }));
    await waitFor(() =>
      expect(api.steer).toHaveBeenCalledWith("thread", {
        turnId: "turn",
        input: "Сначала проверь тесты",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Остановить задачу" }));
    expect(api.interrupt).toHaveBeenCalledWith("thread", "turn");
    expect(screen.getByRole("button", { name: "Включить режим планирования" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Модель" })).toBeDisabled();
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
});

function renderThread() {
  return render(
    <MemoryRouter initialEntries={["/threads/thread"]}>
      <Routes>
        <Route
          path="/threads/:threadId"
          element={<ThreadPage onOpenNavigation={() => undefined} />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

function threadApi() {
  return {
    startTurn: vi.fn().mockResolvedValue({ turnId: "turn" }),
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
  };
}

function mockThreadConnection(api: ReturnType<typeof threadApi>, thread: ThreadSummary) {
  connection.mockReturnValue({
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
        threads: [thread],
        attention: [],
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
      details: { thread: { summary: thread, turns: [] } },
      network: "connected",
      snapshotEpoch: 1,
    },
    refreshDetail: vi.fn().mockResolvedValue({ summary: thread, turns: [] }),
    dispatch: vi.fn(),
  });
}
