import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

import type { AppSnapshot, ThreadSummary } from "@codexnest/protocol";

import { App } from "./App";

const connection = vi.hoisted(() => vi.fn());

vi.mock("./connection", () => ({ useConnection: connection }));
vi.mock("./push", () => ({ usePushNotifications: vi.fn() }));

const baseThread: ThreadSummary = {
  id: "newer",
  projectId: "project",
  title: "Новая задача в истории",
  preview: "",
  cwd: "/work/project",
  state: "idle",
  unread: false,
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 20,
  currentTurnId: null,
  settings: { collaborationMode: "default" },
};

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi
      .fn()
      .mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  );
  localStorage.clear();
});

describe("App routing and navigation", () => {
  it("opens the most recently updated non-archived task from the root route", async () => {
    const older = { ...baseThread, id: "older", title: "Старая задача", updatedAt: 10 };
    mockConnection(snapshot([older, baseThread]));

    renderApp("/");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Новая задача в истории" }),
    ).toBeInTheDocument();
  });

  it("opens the empty chat when only archived tasks exist", async () => {
    mockConnection(snapshot([{ ...baseThread, archived: true }]));

    renderApp("/");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Новая задача" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Что поручим Codex?")).toBeInTheDocument();
  });

  it("filters sidebar tasks locally", () => {
    const beta = { ...baseThread, id: "beta", title: "Исправить Beta", updatedAt: 10 };
    mockConnection(snapshot([baseThread, beta]));

    renderApp("/threads/newer");
    fireEvent.click(screen.getByRole("button", { name: "Поиск по задачам" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Поиск по задачам" }), {
      target: { value: "Beta" },
    });

    expect(screen.getByRole("link", { name: /Исправить Beta/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Новая задача в истории/ })).not.toBeInTheDocument();
  });
  it("creates an empty session from a project and opens it", async () => {
    const created = {
      ...baseThread,
      id: "created",
      title: "Без названия",
      updatedAt: 30,
      settings: { collaborationMode: "default" as const },
    };
    const api = mockConnection(snapshot([baseThread, created]));
    api.createProjectThread.mockResolvedValue({ thread: created });

    renderApp("/threads/newer");
    fireEvent.click(screen.getByRole("button", { name: "Создать новую сессию в проекте Проект" }));

    await waitFor(() => expect(api.createProjectThread).toHaveBeenCalledWith("project"));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Без названия" }),
    ).toBeInTheDocument();
  });

  it("shows a project-scoped error when session creation fails", async () => {
    const api = mockConnection(snapshot([baseThread]));
    api.createProjectThread.mockRejectedValue(new Error("Codex недоступен"));

    renderApp("/threads/newer");
    fireEvent.click(screen.getByRole("button", { name: "Создать новую сессию в проекте Проект" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Codex недоступен");
    expect(
      screen.getByRole("heading", { level: 1, name: "Новая задача в истории" }),
    ).toBeInTheDocument();
  });

  it("opens global Codex settings from the sidebar", async () => {
    const api = mockConnection(snapshot([baseThread]));
    renderApp("/threads/newer");

    fireEvent.click(screen.getByRole("link", { name: "Настройки" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Настройки" })).toBeInTheDocument();
    expect(api.readPermissionSettings).toHaveBeenCalledOnce();
  });
});

function renderApp(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App
        settings={{ baseUrl: "https://pi.local", token: "secret" }}
        onDisconnected={() => undefined}
      />
    </MemoryRouter>,
  );
}

function snapshot(threads: ThreadSummary[]): AppSnapshot {
  return {
    sequence: 1,
    connection: { state: "ready", message: null, syncedAt: null },
    projects: [
      {
        id: "project",
        displayName: "Проект",
        path: "/work/project",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      },
    ],
    threads,
    attention: [],
    models: [],
    pushConfigured: false,
  };
}

function mockConnection(appSnapshot: AppSnapshot) {
  const api = {
    markRead: vi.fn().mockResolvedValue(undefined),
    updateThread: vi.fn().mockResolvedValue(undefined),
    archive: vi.fn().mockResolvedValue(undefined),
    startTurn: vi.fn().mockResolvedValue({ turnId: "turn" }),
    steer: vi.fn().mockResolvedValue({ turnId: "turn" }),
    interrupt: vi.fn().mockResolvedValue(undefined),
    createThread: vi.fn(),
    createProjectThread: vi.fn(),
    readPermissionSettings: vi.fn().mockResolvedValue({
      preset: "auto",
      version: "version-1",
      overridden: false,
      message: null,
    }),
    updatePermissionSettings: vi.fn(),
  };
  connection.mockReturnValue({
    api,
    state: {
      snapshot: appSnapshot,
      details: Object.fromEntries(
        appSnapshot.threads.map((thread) => [thread.id, { summary: thread, turns: [] }]),
      ),
      network: "connected",
      error: null,
      snapshotEpoch: 1,
    },
    reconnect: vi.fn(),
    refreshDetail: vi.fn().mockImplementation(async (id: string) => ({
      summary: appSnapshot.threads.find((thread) => thread.id === id),
      turns: [],
    })),
  });
  return api;
}
