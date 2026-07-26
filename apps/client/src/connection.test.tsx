import { useEffect } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppSnapshot, ThreadDetail, ThreadSummary } from "@codexnest/protocol";

import { ConnectionProvider, useConnection } from "./connection";

const capacitor = vi.hoisted(() => ({ native: false }));
const addAppListener = vi.hoisted(() => vi.fn());
const listPendingVoiceRecordings = vi.hoisted(() =>
  vi.fn<() => Promise<Array<{ id: string }>>>(() => Promise.resolve([])),
);
const deletePendingVoiceRecording = vi.hoisted(() =>
  vi.fn<(id: string) => Promise<void>>(() => Promise.resolve()),
);

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => capacitor.native },
}));
vi.mock("@capacitor/app", () => ({ App: { addListener: addAppListener } }));
vi.mock("./offline-store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listPendingVoiceRecordings,
  deletePendingVoiceRecording,
}));

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
    listPendingVoiceRecordings.mockReset();
    listPendingVoiceRecordings.mockResolvedValue([]);
    deletePendingVoiceRecording.mockReset();
    deletePendingVoiceRecording.mockResolvedValue();
    FakeWebSocket.instances = [];
  });

  afterEach(() => vi.useRealTimers());

  it("discards persisted voice recordings without uploading them in the background", async () => {
    listPendingVoiceRecordings.mockResolvedValueOnce([{ id: "stale-recording" }]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <span>ready</span>
      </ConnectionProvider>,
    );

    await waitFor(() =>
      expect(deletePendingVoiceRecording).toHaveBeenCalledWith("stale-recording"),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    view.unmount();
  });

  it("does not retry a failed voice upload after reconnecting", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: "transcription_unavailable", message: "offline" } }),
          { status: 503 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let queueRecording: ReturnType<typeof useConnection>["queueVoiceRecording"] | undefined;

    function Probe() {
      queueRecording = useConnection().queueVoiceRecording;
      return null;
    }

    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <Probe />
      </ConnectionProvider>,
    );

    await act(async () => {
      await expect(
        queueRecording!({
          id: "recording",
          threadId: "thread",
          audio: new Blob(["audio"], { type: "audio/webm" }),
          durationMs: 1_000,
          mode: "draft",
          selectionStart: 0,
          selectionEnd: 0,
          draftUpdatedAt: null,
          draft: { input: "", images: [], goalMode: false, annotations: [] },
        }),
      ).rejects.toThrow("offline");
    });
    expect(fetchMock).toHaveBeenCalledOnce();

    act(() => window.dispatchEvent(new Event("online")));
    await act(async () => Promise.resolve());
    expect(fetchMock).toHaveBeenCalledOnce();
    view.unmount();
  });

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

  it("deduplicates concurrent forced detail requests", async () => {
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
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://codexnest.example/api/v1/threads/thread"),
      expect.objectContaining({ cache: "no-store" }),
    );

    act(() => responses[0]?.(new Response(JSON.stringify(detail("Новый ответ")))));
    expect(await screen.findByText("Новый ответ")).toBeInTheDocument();
    await expect(Promise.all(requests)).resolves.toHaveLength(2);
    expect(screen.getByText("Новый ответ")).toBeInTheDocument();
    view.unmount();
  });

  it("falls back to an authoritative page when a cached delta cursor fails", async () => {
    const staleSummary = { ...summary, state: "completed" as const, updatedAt: 3 };
    const staleDetail: ThreadDetail = {
      summary: staleSummary,
      turns: [
        {
          id: "plan-turn",
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
              type: "plan",
              id: "old-plan",
              status: "completed",
              text: "Старый план",
              images: [],
              timestamp: 2,
              phase: null,
            },
          ],
        },
      ],
      queuedMessages: [],
      olderTurnsCursor: null,
      syncPoint: {
        cursor: "poisoned-cursor",
        anchorTurnId: "plan-turn",
        anchorRevision: "old-revision",
      },
    };
    const canonical: ThreadDetail = {
      summary: { ...staleSummary, updatedAt: 4 },
      turns: [
        ...staleDetail.turns,
        {
          id: "implemented-turn",
          status: "completed",
          startedAt: 3,
          completedAt: 4,
          durationMs: 1,
          progress: {
            startedAt: 3,
            explanation: null,
            steps: [],
            filesChanged: 1,
            additions: 2,
            deletions: 0,
          },
          items: [
            {
              type: "agentMessage",
              id: "final",
              status: "completed",
              text: "Канонический финальный ответ",
              images: [],
              timestamp: 4,
              phase: "final_answer",
            },
          ],
        },
      ],
      queuedMessages: [],
      olderTurnsCursor: null,
      syncPoint: {
        cursor: "fresh-cursor",
        anchorTurnId: "implemented-turn",
        anchorRevision: "fresh-revision",
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { code: "validation_failed", message: "Invalid cursor" },
          }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(canonical), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let refresh: (() => Promise<ThreadDetail>) | undefined;
    let seeded = false;

    function Probe() {
      const { dispatch, refreshDetail, state } = useConnection();
      useEffect(() => {
        if (seeded) return;
        seeded = true;
        dispatch({ type: "detail", detail: staleDetail, page: "latest" });
      }, [dispatch]);
      refresh = () => refreshDetail("thread", { force: true });
      const latest = state.details.thread?.turns.at(-1)?.items.at(-1);
      return <span>{latest && "text" in latest ? latest.text : ""}</span>;
    }

    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <Probe />
      </ConnectionProvider>,
    );
    expect(await screen.findByText("Старый план")).toBeInTheDocument();

    await act(async () => {
      await refresh?.();
    });

    expect(await screen.findByText("Канонический финальный ответ")).toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/api/v1/threads/thread/changes",
      "/api/v1/threads/thread",
    ]);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ cache: "no-store" }));
    view.unmount();
  });

  it("repairs a successful delta that is older than the completed thread summary", async () => {
    const completed = {
      ...summary,
      state: "completed" as const,
      currentTurnId: null,
      updatedAt: 20_000,
    };
    const staleDetail: ThreadDetail = {
      summary: completed,
      turns: [
        {
          id: "plan-turn",
          status: "completed",
          startedAt: 1_000,
          completedAt: 2_000,
          durationMs: 1_000,
          progress: {
            startedAt: 1_000,
            explanation: null,
            steps: [],
            filesChanged: 0,
            additions: 0,
            deletions: 0,
          },
          items: [
            {
              type: "plan",
              id: "old-plan",
              status: "completed",
              text: "Старый план",
              images: [],
              timestamp: 2_000,
              phase: null,
            },
          ],
        },
      ],
      queuedMessages: [],
      olderTurnsCursor: null,
      syncPoint: {
        cursor: "apparently-valid",
        anchorTurnId: "plan-turn",
        anchorRevision: "old-revision",
      },
    };
    const canonical: ThreadDetail = {
      summary: completed,
      turns: [
        ...staleDetail.turns,
        {
          id: "final-turn",
          status: "completed",
          startedAt: 19_000,
          completedAt: 20_000,
          durationMs: 1_000,
          progress: {
            startedAt: 19_000,
            explanation: null,
            steps: [],
            filesChanged: 1,
            additions: 2,
            deletions: 0,
          },
          items: [
            {
              type: "agentMessage",
              id: "final",
              status: "completed",
              text: "Свежий финальный ответ",
              images: [],
              timestamp: 20_000,
              phase: "final_answer",
            },
          ],
        },
      ],
      queuedMessages: [],
      olderTurnsCursor: null,
      syncPoint: {
        cursor: "fresh",
        anchorTurnId: "final-turn",
        anchorRevision: "fresh-revision",
      },
    };
    const unchangedDelta = {
      summary: completed,
      turns: [],
      queuedMessages: [],
      draft: null,
      continuationCursor: null,
      syncPoint: staleDetail.syncPoint,
      resetLatest: false,
      olderTurnsCursor: null,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(unchangedDelta), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(canonical), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let refresh: (() => Promise<ThreadDetail>) | undefined;
    let seeded = false;

    function Probe() {
      const { dispatch, refreshDetail, state } = useConnection();
      useEffect(() => {
        if (seeded) return;
        seeded = true;
        dispatch({ type: "detail", detail: staleDetail, page: "latest" });
      }, [dispatch]);
      refresh = () => refreshDetail("thread", { force: true });
      const latest = state.details.thread?.turns.at(-1)?.items.at(-1);
      return <span>{latest && "text" in latest ? latest.text : ""}</span>;
    }

    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <Probe />
      </ConnectionProvider>,
    );
    expect(await screen.findByText("Старый план")).toBeInTheDocument();

    await act(async () => {
      await refresh?.();
    });

    expect(screen.getByText("Свежий финальный ответ")).toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/api/v1/threads/thread/changes",
      "/api/v1/threads/thread",
    ]);
    view.unmount();
  });

  it("keeps retrying an inconsistent loaded detail until the canonical page recovers", async () => {
    vi.useFakeTimers();
    const running = {
      ...summary,
      state: "running" as const,
      currentTurnId: "live-turn",
      updatedAt: 3,
    };
    const staleDetail: ThreadDetail = {
      summary: running,
      turns: [],
      queuedMessages: [],
      olderTurnsCursor: null,
      syncPoint: {
        cursor: "stale-cursor",
        anchorTurnId: "old-turn",
        anchorRevision: "old-revision",
      },
    };
    const canonical: ThreadDetail = {
      summary: running,
      turns: [
        {
          id: "live-turn",
          status: "inProgress",
          startedAt: 3,
          completedAt: null,
          durationMs: null,
          progress: {
            startedAt: 3,
            explanation: null,
            steps: [],
            filesChanged: 0,
            additions: 0,
            deletions: 0,
          },
          items: [
            {
              type: "agentMessage",
              id: "live",
              status: "inProgress",
              text: "История восстановлена",
              images: [],
              timestamp: 3,
              phase: "commentary",
            },
          ],
        },
      ],
      queuedMessages: [],
      olderTurnsCursor: null,
      syncPoint: {
        cursor: "live-cursor",
        anchorTurnId: "live-turn",
        anchorRevision: "live-revision",
      },
    };
    const unavailable = () =>
      new Response(
        JSON.stringify({
          error: { code: "internal_error", message: "Temporary failure" },
        }),
        { status: 500 },
      );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(unavailable())
      .mockResolvedValueOnce(unavailable())
      .mockResolvedValueOnce(unavailable())
      .mockResolvedValueOnce(unavailable())
      .mockResolvedValueOnce(new Response(JSON.stringify(canonical), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let seeded = false;

    function Probe() {
      const { dispatch, state } = useConnection();
      useEffect(() => {
        if (seeded) return;
        seeded = true;
        dispatch({ type: "detail", detail: staleDetail, page: "latest" });
      }, [dispatch]);
      const latest = state.details.thread?.turns.at(-1)?.items.at(-1);
      return <span>{latest && "text" in latest ? latest.text : "Ожидание"}</span>;
    }

    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <Probe />
      </ConnectionProvider>,
    );
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(9_999);
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(screen.getByText("Ожидание")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(screen.getByText("История восстановлена")).toBeInTheDocument();
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
