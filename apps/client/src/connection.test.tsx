import { useEffect } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppSnapshot, ThreadDetail, ThreadSummary } from "@codexnest/protocol";

import { ConnectionProvider, useConnection } from "./connection";

const capacitor = vi.hoisted(() => ({ native: false }));
const addAppListener = vi.hoisted(() => vi.fn());

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => capacitor.native },
}));
vi.mock("@capacitor/app", () => ({ App: { addListener: addAppListener } }));

const summary: ThreadSummary = {
  id: "thread",
  relation: { kind: "session", sessionId: "session" },
  projectId: null,
  title: "Thread",
  preview: "",
  cwd: "/work",
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

describe("ConnectionProvider", () => {
  beforeEach(() => {
    capacitor.native = false;
    addAppListener.mockReset();
    FakeWebSocket.instances = [];
  });

  afterEach(() => vi.useRealTimers());

  it("deduplicates concurrent reads of the same thread page", async () => {
    const detail: ThreadDetail = {
      summary,
      turns: [],
      queuedMessages: [],
      olderTurnsCursor: null,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(detail), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const requests: Array<Promise<ThreadDetail>> = [];

    function Probe() {
      const { refreshDetail } = useConnection();
      useEffect(() => {
        requests.push(refreshDetail("thread"), refreshDetail("thread"));
      }, [refreshDetail]);
      return null;
    }

    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <Probe />
      </ConnectionProvider>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await expect(Promise.all(requests)).resolves.toEqual([detail, detail]);
    view.unmount();
  });

  it("ignores an older forced detail request that finishes last", async () => {
    const responses: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          responses.push(resolve);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const requests: Array<Promise<ThreadDetail>> = [];

    const detail = (text: string): ThreadDetail => ({
      summary,
      turns: [
        {
          id: "turn",
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
              id: "agent",
              status: "completed",
              text,
              images: [],
              timestamp: 2,
              phase: "final_answer",
            },
          ],
        },
      ],
      queuedMessages: [],
      olderTurnsCursor: null,
    });

    function Probe() {
      const { refreshDetail, state } = useConnection();
      useEffect(() => {
        requests.push(
          refreshDetail("thread", { force: true }),
          refreshDetail("thread", { force: true }),
        );
      }, [refreshDetail]);
      return (
        <span>
          {state.details.thread?.turns[0]?.items[0]?.type === "agentMessage"
            ? state.details.thread.turns[0].items[0].text
            : ""}
        </span>
      );
    }

    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <Probe />
      </ConnectionProvider>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://codexnest.example/api/v1/threads/thread"),
      expect.objectContaining({ cache: "no-store" }),
    );

    act(() => responses[1]?.(new Response(JSON.stringify(detail("Новый ответ")))));
    expect(await screen.findByText("Новый ответ")).toBeInTheDocument();
    act(() => responses[0]?.(new Response(JSON.stringify(detail("Старый ответ")))));
    await expect(Promise.all(requests)).resolves.toHaveLength(2);
    expect(screen.getByText("Новый ответ")).toBeInTheDocument();
    expect(screen.queryByText("Старый ответ")).toBeNull();
    view.unmount();
  });

  it("refreshes a native app on resume even before WebView visibility catches up", async () => {
    capacitor.native = true;
    let appStateListener: ((state: { isActive: boolean }) => void) | undefined;
    addAppListener.mockImplementation((_event, listener) => {
      appStateListener = listener;
      return Promise.resolve({ remove: vi.fn().mockResolvedValue(undefined) });
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(snapshot(1, [])), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });

    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <SnapshotProbe />
      </ConnectionProvider>,
    );
    await waitFor(() =>
      expect(addAppListener).toHaveBeenCalledWith("appStateChange", expect.any(Function)),
    );

    act(() => appStateListener?.({ isActive: true }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        new URL("https://codexnest.example/api/v1/sync"),
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(await screen.findByText("snapshot:1")).toBeInTheDocument();
    view.unmount();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });

  it("closes an unresponsive socket after a heartbeat and isolates its late events", () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <SnapshotProbe />
      </ConnectionProvider>,
    );
    const first = FakeWebSocket.instances[0]!;

    act(() => {
      first.open();
      first.receive({ type: "snapshot", snapshot: snapshot(1) });
    });
    expect(first.sent).toContain(JSON.stringify({ type: "authenticate", token: "token" }));

    act(() => vi.advanceTimersByTime(15_000));
    expect(first.sent.at(-1)).toBe(JSON.stringify({ type: "ping" }));
    act(() => vi.advanceTimersByTime(10_000));
    expect(first.readyState).toBe(FakeWebSocket.CLOSED);

    act(() => vi.advanceTimersByTime(1_300));
    const second = FakeWebSocket.instances[1]!;
    act(() => {
      second.open();
      second.receive({ type: "snapshot", snapshot: snapshot(2) });
      first.receive({ invalid: true });
    });
    expect(second.readyState).toBe(FakeWebSocket.OPEN);
    expect(screen.getByText("snapshot:2")).toBeInTheDocument();
    view.unmount();
  });

  it("keeps a synced snapshot ahead of buffered events from the current stream", async () => {
    capacitor.native = true;
    let appStateListener: ((state: { isActive: boolean }) => void) | undefined;
    let resolveSync: ((response: Response) => void) | undefined;
    addAppListener.mockImplementation((_event, listener) => {
      appStateListener = listener;
      return Promise.resolve({ remove: vi.fn().mockResolvedValue(undefined) });
    });
    const synced = { ...summary, title: "Синхронизировано" };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveSync = resolve;
          }),
      ),
    );
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <ThreadTitleProbe />
      </ConnectionProvider>,
    );
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      socket.open();
      socket.receive({ type: "snapshot", snapshot: snapshot(1) });
    });
    await waitFor(() =>
      expect(addAppListener).toHaveBeenCalledWith("appStateChange", expect.any(Function)),
    );

    act(() => appStateListener?.({ isActive: true }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const resumedSocket = FakeWebSocket.instances[1]!;
    act(() => {
      resolveSync?.(new Response(JSON.stringify(snapshot(3, [synced])), { status: 200 }));
    });
    expect(await screen.findByText("Синхронизировано")).toBeInTheDocument();
    act(() => {
      resumedSocket.open();
      resumedSocket.receive({ type: "snapshot", snapshot: snapshot(1) });
      resumedSocket.receive({
        type: "event",
        sequence: 2,
        event: { type: "thread.upserted", thread: { ...summary, title: "Устарело" } },
      });
    });

    expect(screen.getByText("Синхронизировано")).toBeInTheDocument();
    expect(screen.queryByText("Устарело")).toBeNull();
    view.unmount();
  });
});

function snapshot(sequence: number, threads: ThreadSummary[] = [summary]): AppSnapshot {
  return {
    sequence,
    uiLanguage: "ru",
    connection: { state: "ready", message: null, syncedAt: null },
    projects: [],
    threads,
    attention: [],
    models: [],
    pushConfigured: false,
  };
}

function SnapshotProbe() {
  const { state } = useConnection();
  return <span>snapshot:{state.snapshot?.sequence ?? "none"}</span>;
}

function ThreadTitleProbe() {
  const { state } = useConnection();
  return <span>{state.snapshot?.threads[0]?.title ?? "none"}</span>;
}

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  receive(frame: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}
