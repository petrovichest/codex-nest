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
    const createThread = vi.fn().mockResolvedValue({
      thread: { id: "created" },
      turnId: "turn",
    });
    connection.mockReturnValue({
      api: { createThread },
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

    fireEvent.change(screen.getByRole("textbox", { name: "Сообщение для Codex" }), {
      target: { value: "Обнови интерфейс" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    await waitFor(() =>
      expect(createThread).toHaveBeenCalledWith({
        projectId: "project",
        input: "Обнови интерфейс",
        settings: {
          collaborationMode: "default",
        },
      }),
    );
    expect(await screen.findByText("Созданная задача")).toBeInTheDocument();
  });

  it("offers project creation and disables sending without projects", () => {
    const onNewProject = vi.fn();
    connection.mockReturnValue({
      api: { createThread: vi.fn() },
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
});
