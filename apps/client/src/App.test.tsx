import { fireEvent, render, screen } from "@testing-library/react";
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
}
