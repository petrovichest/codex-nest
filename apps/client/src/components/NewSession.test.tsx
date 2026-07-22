import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import type { Project } from "@codexnest/protocol";

import { NewSession } from "./NewSession";

const connection = vi.hoisted(() => vi.fn());

vi.mock("../connection", () => ({ useConnection: connection }));

const projects: Project[] = [
  {
    id: "project",
    displayName: "CodexNest",
    path: "/work/codex-nest",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  },
];

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
});

describe("NewSession", () => {
  it("creates a task from the empty chat and navigates to it", async () => {
    const dispatch = vi.fn();
    const createThread = vi.fn().mockResolvedValue({
      thread: { id: "created" },
      turnId: "turn",
    });
    connection.mockReturnValue({
      api: { createThread },
      dispatch,
      state: {
        snapshot: {
          connection: { state: "ready" },
          models: [],
        },
        network: "connected",
      },
    });

    render(
      <MemoryRouter initialEntries={["/new"]}>
        <Routes>
          <Route
            path="/new"
            element={
              <NewSession
                projects={projects}
                onOpenNavigation={() => undefined}
                onNewProject={() => undefined}
              />
            }
          />
          <Route path="/threads/:threadId" element={<div>Созданная задача</div>} />
        </Routes>
      </MemoryRouter>,
    );

    const textbox = screen.getByRole("textbox", { name: "Сообщение для Codex" });
    expect(textbox).toHaveFocus();
    fireEvent.change(textbox, {
      target: { value: "Обнови интерфейс" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    await waitFor(() =>
      expect(createThread).toHaveBeenCalledWith({
        projectId: "project",
        input: "Обнови интерфейс",
        clientMessageId: expect.any(String),
        settings: {
          collaborationMode: "default",
        },
      }),
    );
    expect(dispatch).toHaveBeenCalledWith({
      type: "optimistic.add",
      message: expect.objectContaining({
        threadId: "created",
        text: "Обнови интерфейс",
        turnId: "turn",
      }),
    });
    expect(await screen.findByText("Созданная задача")).toBeInTheDocument();
  });

  it("offers project creation and disables sending without projects", () => {
    const onNewProject = vi.fn();
    connection.mockReturnValue({
      api: { createThread: vi.fn() },
      dispatch: vi.fn(),
      state: { snapshot: { connection: { state: "ready" }, models: [] }, network: "connected" },
    });

    render(
      <MemoryRouter>
        <NewSession projects={[]} onOpenNavigation={() => undefined} onNewProject={onNewProject} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Добавить проект/ }));
    expect(onNewProject).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Отправить" })).toBeDisabled();
  });

  it("restores the last reasoning effort for a new session", async () => {
    const createThread = vi.fn().mockResolvedValue({
      thread: { id: "created" },
      turnId: "turn",
    });
    connection.mockReturnValue({
      api: { createThread },
      dispatch: vi.fn(),
      state: {
        snapshot: {
          connection: { state: "ready" },
          defaultReasoningEffort: "high",
          models: [
            {
              id: "gpt",
              displayName: "GPT",
              description: "",
              isDefault: true,
              reasoningEfforts: [
                { value: "medium", description: null, isDefault: true },
                { value: "high", description: null, isDefault: false },
              ],
              serviceTiers: [],
              supportsPersonality: false,
            },
          ],
        },
        network: "connected",
      },
    });

    render(
      <MemoryRouter>
        <NewSession
          projects={projects}
          onOpenNavigation={() => undefined}
          onNewProject={() => undefined}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("combobox", { name: "Уровень рассуждений" })).toHaveValue("high");
    fireEvent.change(screen.getByRole("textbox", { name: "Сообщение для Codex" }), {
      target: { value: "Продолжай глубоко рассуждать" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    await waitFor(() =>
      expect(createThread).toHaveBeenCalledWith({
        projectId: "project",
        input: "Продолжай глубоко рассуждать",
        clientMessageId: expect.any(String),
        settings: {
          collaborationMode: "default",
          reasoningEffort: "high",
        },
      }),
    );
  });

  it("keeps Plan and Goal mutually exclusive and starts a native goal", async () => {
    const createThread = vi.fn().mockResolvedValue({ thread: { id: "created" }, turnId: "turn" });
    connection.mockReturnValue({
      api: { createThread },
      dispatch: vi.fn(),
      state: {
        snapshot: {
          connection: { state: "ready" },
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
        },
        network: "connected",
      },
    });

    render(
      <MemoryRouter>
        <NewSession
          projects={projects}
          onOpenNavigation={() => undefined}
          onNewProject={() => undefined}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Включить режим планирования" }));
    expect(screen.getByRole("button", { name: "Выключить режим планирования" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Включить режим цели" }));
    expect(screen.getByRole("button", { name: "Включить режим планирования" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Сообщение для Codex" }), {
      target: { value: "Доведи проверяемый результат до конца" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Запустить цель" }));

    await waitFor(() =>
      expect(createThread).toHaveBeenCalledWith({
        projectId: "project",
        input: "Доведи проверяемый результат до конца",
        goal: true,
        clientMessageId: expect.any(String),
        settings: { collaborationMode: "default" },
      }),
    );
  });
});
