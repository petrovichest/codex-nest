import { useEffect } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppSnapshot, ThreadDetail, ThreadSummary } from "@codexnest/protocol";

import { ConnectionProvider, useConnection } from "./connection";
import type { PendingVoiceRecording } from "./offline-store";

const capacitor = vi.hoisted(() => ({ native: false }));
const addAppListener = vi.hoisted(() => vi.fn());
const listPendingVoiceRecordings = vi.hoisted(() =>
  vi.fn<() => Promise<PendingVoiceRecording[]>>(() => Promise.resolve([])),
);
const deletePendingVoiceRecording = vi.hoisted(() =>
  vi.fn<(id: string) => Promise<void>>(() => Promise.resolve()),
);
const loadPendingVoiceRecording = vi.hoisted(() => vi.fn(() => Promise.resolve(null)));
const putPendingVoiceRecording = vi.hoisted(() =>
  vi.fn<(recording: PendingVoiceRecording) => Promise<boolean>>(() => Promise.resolve(true)),
);
const observeNativeNotificationEvent = vi.hoisted(() => vi.fn());
const observeNativeNotificationSnapshot = vi.hoisted(() => vi.fn());
const setNativeNotificationAppActive = vi.hoisted(() => vi.fn());

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => capacitor.native },
}));
vi.mock("@capacitor/app", () => ({ App: { addListener: addAppListener } }));
vi.mock("./push", () => ({
  observeNativeNotificationEvent,
  observeNativeNotificationSnapshot,
  setNativeNotificationAppActive,
}));
vi.mock("./offline-store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listPendingVoiceRecordings,
  deletePendingVoiceRecording,
  loadPendingVoiceRecording,
  putPendingVoiceRecording,
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
  browserStatus: "disabled",
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
    loadPendingVoiceRecording.mockReset();
    loadPendingVoiceRecording.mockResolvedValue(null);
    putPendingVoiceRecording.mockReset();
    putPendingVoiceRecording.mockResolvedValue(true);
    observeNativeNotificationEvent.mockReset();
    observeNativeNotificationSnapshot.mockReset();
    setNativeNotificationAppActive.mockReset();
    FakeWebSocket.instances = [];
  });

  afterEach(() => vi.useRealTimers());

  it("uploads a persisted voice recording after reload and deletes it only after acceptance", async () => {
    listPendingVoiceRecordings.mockResolvedValue([
      {
        id: "stale-recording",
        connectionKey: "saved-connection",
        threadId: "thread",
        audio: new Blob(["audio"], { type: "audio/webm" }),
        durationMs: 1_000,
        mode: "draft",
        selectionStart: 0,
        selectionEnd: 0,
        draftUpdatedAt: null,
        draft: { input: "", images: [], goalMode: false, annotations: [] },
        localDraftUpdatedAt: 1,
        serverDraftUpdatedAt: null,
        createdAt: 1,
        attempts: 1,
        lastError: "offline",
      },
    ]);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
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
    expect(fetchMock).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("keeps a recovered recording without endlessly retrying a stale draft conflict", async () => {
    listPendingVoiceRecordings.mockResolvedValue([
      {
        id: "conflicted-recording",
        connectionKey: "saved-connection",
        threadId: "thread",
        audio: new Blob(["audio"], { type: "audio/webm" }),
        durationMs: 1_000,
        mode: "draft",
        selectionStart: 0,
        selectionEnd: 0,
        draftUpdatedAt: 10,
        draft: { input: "Старый черновик", images: [], goalMode: false, annotations: [] },
        localDraftUpdatedAt: 1,
        serverDraftUpdatedAt: 11,
        createdAt: 1,
        attempts: 1,
        lastError: "offline",
      },
    ]);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "draft_conflict", message: "The draft changed before voice upload" },
        }),
        { status: 409 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let pendingThreadIds: readonly string[] = [];
    let pendingErrors: Readonly<Record<string, string>> = {};
    let retryRecording: ReturnType<typeof useConnection>["retryPendingVoiceRecording"] | undefined;

    function Probe() {
      const connection = useConnection();
      pendingThreadIds = connection.pendingVoiceRecordingThreadIds;
      pendingErrors = connection.pendingVoiceRecordingErrors;
      retryRecording = connection.retryPendingVoiceRecording;
      return null;
    }

    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <Probe />
      </ConnectionProvider>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await new Promise((resolve) => window.setTimeout(resolve, 1_500));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(putPendingVoiceRecording).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "conflicted-recording",
        attempts: 2,
        lastError: "The draft changed before voice upload",
      }),
    );
    expect(deletePendingVoiceRecording).not.toHaveBeenCalledWith("conflicted-recording");
    expect(pendingThreadIds).toEqual(["thread"]);
    expect(pendingErrors).toEqual({
      thread: "The draft changed before voice upload",
    });

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { code: "draft_conflict", message: "The draft changed before voice upload" },
          }),
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            input: "Текущий черновик",
            images: [],
            goalMode: false,
            annotations: [],
            updatedAt: 21,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await act(async () => {
      await retryRecording!({
        threadId: "thread",
        mode: "draft",
        draft: { input: "Текущий черновик", images: [], goalMode: false, annotations: [] },
        draftUpdatedAt: 20,
      });
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toEqual(
      new URL("https://codexnest.example/api/v1/threads/thread/draft?expectedUpdatedAt=20"),
    );
    expect(
      putPendingVoiceRecording.mock.calls.some(
        ([recording]) =>
          recording.draft.input === "Текущий черновик" &&
          !Object.prototype.hasOwnProperty.call(recording, "serverDraftUpdatedAt"),
      ),
    ).toBe(true);
    await waitFor(() => expect(pendingThreadIds).toEqual([]));
    expect(pendingErrors).toEqual({});
    expect(deletePendingVoiceRecording).toHaveBeenCalledWith("conflicted-recording");
    view.unmount();
  });

  it("persists a new voice recording before upload and retains it after a failed upload", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("null", { status: 200 }))
      .mockResolvedValueOnce(
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
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toEqual(
      new URL("https://codexnest.example/api/v1/threads/thread/draft?expectedUpdatedAt=none"),
    );
    expect(putPendingVoiceRecording).toHaveBeenCalled();
    expect(putPendingVoiceRecording.mock.invocationCallOrder[0]).toBeLessThan(
      fetchMock.mock.invocationCallOrder[0]!,
    );
    expect(deletePendingVoiceRecording).not.toHaveBeenCalledWith("recording");

    act(() => window.dispatchEvent(new Event("online")));
    await act(async () => Promise.resolve());
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

  it("deduplicates concurrent technical item reads", async () => {
    const response = { threadId: "thread", turnId: "turn", items: [] };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const requests: Array<Promise<void>> = [];

    function Probe() {
      const { loadTurnItems } = useConnection();
      useEffect(() => {
        requests.push(loadTurnItems("thread", "turn"), loadTurnItems("thread", "turn"));
      }, [loadTurnItems]);
      return null;
    }

    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <Probe />
      </ConnectionProvider>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await expect(Promise.all(requests)).resolves.toEqual([undefined, undefined]);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://codexnest.example/api/v1/threads/thread/turns/turn/items"),
      expect.objectContaining({ method: "GET" }),
    );
    view.unmount();
  });

  it("applies the authoritative snapshot and replaces the full detail on a manual refresh", async () => {
    const refreshedSummary = {
      ...summary,
      title: "Актуальная сессия",
      updatedAt: 3,
    };
    const refreshedDetail: ThreadDetail = {
      summary: refreshedSummary,
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
              id: "answer",
              status: "completed",
              text: "Актуальный ответ",
              images: [],
              timestamp: 2,
              phase: "final_answer",
            },
          ],
        },
      ],
      queuedMessages: [],
      olderTurnsCursor: null,
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          snapshot: snapshot(2, [refreshedSummary]),
          detail: refreshedDetail,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let refresh: (() => Promise<ThreadDetail>) | undefined;

    function Probe() {
      const { forceRefreshDetail, state, streamRecoveryEpoch } = useConnection();
      refresh = () => forceRefreshDetail("thread");
      const latest = state.details.thread?.turns.at(-1)?.items.at(-1);
      return (
        <>
          <span>{state.snapshot?.threads[0]?.title ?? "none"}</span>
          <span>{latest && "text" in latest ? latest.text : ""}</span>
          <span>{`recovery:${streamRecoveryEpoch}`}</span>
        </>
      );
    }

    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <Probe />
      </ConnectionProvider>,
    );

    await act(async () => {
      await refresh?.();
    });

    expect(screen.getByText("Актуальная сессия")).toBeInTheDocument();
    expect(screen.getByText("Актуальный ответ")).toBeInTheDocument();
    expect(screen.getByText("recovery:0")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://codexnest.example/api/v1/threads/thread/refresh"),
      expect.objectContaining({ method: "POST" }),
    );
    view.unmount();
  });

  it("preserves live activity that arrives while a manual refresh is pending", async () => {
    const running = {
      ...summary,
      state: "running" as const,
      currentTurnId: "turn",
      updatedAt: 3,
    };
    const staleDetail: ThreadDetail = {
      summary: running,
      turns: [
        {
          id: "turn",
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
              id: "answer",
              status: "inProgress",
              text: "Начало",
              images: [],
              timestamp: 3,
              phase: "commentary",
            },
          ],
          itemsLoaded: false,
        },
      ],
      queuedMessages: [],
      olderTurnsCursor: null,
    };
    let resolveRefresh!: (response: Response) => void;
    const refreshResponse = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(refreshResponse);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let refresh: (() => Promise<ThreadDetail>) | undefined;
    let seeded = false;

    function Probe() {
      const { dispatch, forceRefreshDetail, state } = useConnection();
      useEffect(() => {
        if (seeded) return;
        seeded = true;
        dispatch({ type: "detail", detail: staleDetail, page: "latest" });
      }, [dispatch]);
      refresh = () => forceRefreshDetail("thread");
      const latest = state.details.thread?.turns.at(-1)?.items.at(-1);
      return <span>{latest && "text" in latest ? latest.text : ""}</span>;
    }

    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <Probe />
      </ConnectionProvider>,
    );
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      socket.open();
      socket.receive({ type: "snapshot", snapshot: snapshot(1, [running]) });
    });
    expect(await screen.findByText("Начало")).toBeInTheDocument();

    let pendingRefresh!: Promise<ThreadDetail>;
    act(() => {
      pendingRefresh = refresh!();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    act(() => {
      socket.receive({
        type: "event",
        sequence: 2,
        event: {
          type: "activity.upserted",
          threadId: "thread",
          turnId: "turn",
          item: {
            type: "agentMessage",
            id: "answer",
            status: "inProgress",
            text: "Начало live-обновления",
            images: [],
            timestamp: 3,
            phase: "commentary",
          },
        },
      });
    });
    expect(screen.getByText("Начало live-обновления")).toBeInTheDocument();

    await act(async () => {
      resolveRefresh(
        new Response(
          JSON.stringify({
            snapshot: snapshot(1, [running]),
            detail: staleDetail,
          }),
          { status: 200 },
        ),
      );
      await pendingRefresh;
    });

    expect(screen.getByText("Начало live-обновления")).toBeInTheDocument();
    view.unmount();
  });

  it("does not treat an unrelated subagent event as live progress in the refreshed thread", async () => {
    const running = {
      ...summary,
      state: "running" as const,
      currentTurnId: "turn",
      updatedAt: 3,
    };
    const child: ThreadSummary = {
      ...summary,
      id: "child",
      relation: {
        kind: "subagent",
        sessionId: "child-session",
        parentThreadId: "thread",
        nickname: null,
        role: null,
      },
    };
    const detail = (explanation: string): ThreadDetail => ({
      summary: running,
      turns: [
        {
          id: "turn",
          status: "inProgress",
          startedAt: 3,
          completedAt: null,
          durationMs: null,
          progress: {
            startedAt: 3,
            explanation,
            steps: [],
            filesChanged: 0,
            additions: 0,
            deletions: 0,
          },
          items: [],
          itemsLoaded: false,
        },
      ],
      queuedMessages: [],
      olderTurnsCursor: null,
    });
    let resolveRefresh!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let refresh: (() => Promise<ThreadDetail>) | undefined;
    let seeded = false;

    function Probe() {
      const { dispatch, forceRefreshDetail, state } = useConnection();
      useEffect(() => {
        if (seeded) return;
        seeded = true;
        dispatch({ type: "detail", detail: detail("Старый шаг"), page: "latest" });
      }, [dispatch]);
      refresh = () => forceRefreshDetail("thread");
      return <span>{state.details.thread?.turns[0]?.progress.explanation ?? "none"}</span>;
    }

    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <Probe />
      </ConnectionProvider>,
    );
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      socket.open();
      socket.receive({ type: "snapshot", snapshot: snapshot(1, [running, child]) });
    });
    expect(await screen.findByText("Старый шаг")).toBeInTheDocument();

    let pendingRefresh!: Promise<ThreadDetail>;
    act(() => {
      pendingRefresh = refresh!();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    act(() => {
      socket.receive({
        type: "event",
        sequence: 2,
        event: { type: "thread.upserted", thread: { ...child, updatedAt: 4 } },
      });
    });

    await act(async () => {
      resolveRefresh(
        new Response(
          JSON.stringify({
            snapshot: snapshot(2, [running, { ...child, updatedAt: 4 }]),
            detail: detail("Актуальный шаг"),
          }),
          { status: 200 },
        ),
      );
      await pendingRefresh;
    });

    expect(screen.getByText("Актуальный шаг")).toBeInTheDocument();
    view.unmount();
  });

  it("preserves a pre-existing live turn when selection revalidation returns an equal-time reset", async () => {
    const running = {
      ...summary,
      state: "running" as const,
      currentTurnId: "live-turn",
      updatedAt: 3,
    };
    const liveDetail: ThreadDetail = {
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
            explanation: "Актуальная работа",
            steps: [],
            filesChanged: 0,
            additions: 0,
            deletions: 0,
          },
          items: [
            {
              type: "agentMessage",
              id: "live-answer",
              status: "inProgress",
              text: "Актуальный потоковый ответ",
              images: [],
              timestamp: 3,
              phase: "commentary",
            },
          ],
          itemsLoaded: false,
        },
      ],
      queuedMessages: [],
      olderTurnsCursor: null,
      syncPoint: {
        cursor: "stale-cursor",
        anchorTurnId: "old-turn",
        anchorRevision: "old-revision",
      },
    };
    const staleReset = {
      summary: { ...summary, state: "idle" as const, updatedAt: 3 },
      turns: [],
      queuedMessages: [],
      draft: null,
      continuationCursor: null,
      syncPoint: null,
      resetLatest: true,
      olderTurnsCursor: null,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(staleReset), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let refresh: (() => Promise<ThreadDetail>) | undefined;
    let seeded = false;

    function Probe() {
      const { dispatch, refreshDetail, state } = useConnection();
      useEffect(() => {
        if (seeded) return;
        seeded = true;
        dispatch({ type: "detail", detail: liveDetail, page: "latest" });
      }, [dispatch]);
      refresh = () => refreshDetail("thread", { force: true });
      const latest = state.details.thread?.turns.at(-1)?.items.at(-1);
      return <span>{latest && "text" in latest ? latest.text : "none"}</span>;
    }

    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <Probe />
      </ConnectionProvider>,
    );
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      socket.open();
      socket.receive({ type: "snapshot", snapshot: snapshot(1, [running]) });
    });
    expect(await screen.findByText("Актуальный потоковый ответ")).toBeInTheDocument();

    await act(async () => {
      await refresh?.();
    });

    expect(screen.getByText("Актуальный потоковый ответ")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("recovers activity missed while a live thread was not selected", async () => {
    const running = {
      ...summary,
      state: "running" as const,
      currentTurnId: "live-turn",
      updatedAt: 4,
    };
    const staleDetail: ThreadDetail = {
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
              id: "visible-before-navigation",
              status: "completed",
              text: "Видно до переключения",
              images: [],
              timestamp: 3,
              phase: "commentary",
            },
          ],
          itemsLoaded: false,
        },
      ],
      queuedMessages: [],
      olderTurnsCursor: null,
      syncPoint: {
        cursor: "live-cursor",
        anchorTurnId: "live-turn",
        anchorRevision: "before-navigation",
      },
    };
    const recoveredChanges = {
      summary: running,
      turns: [
        {
          ...staleDetail.turns[0]!,
          items: [
            ...staleDetail.turns[0]!.items,
            {
              type: "agentMessage" as const,
              id: "missed-while-away",
              status: "completed" as const,
              text: "Пропущенное live-сообщение",
              images: [],
              timestamp: 4,
              phase: "commentary" as const,
            },
          ],
        },
      ],
      queuedMessages: [],
      draft: null,
      continuationCursor: null,
      syncPoint: {
        cursor: "live-cursor",
        anchorTurnId: "live-turn",
        anchorRevision: "after-navigation",
      },
      resetLatest: false,
      olderTurnsCursor: null,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(recoveredChanges), { status: 200 }));
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
      return <span>{latest && "text" in latest ? latest.text : "Ожидание"}</span>;
    }

    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <Probe />
      </ConnectionProvider>,
    );
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      socket.open();
      socket.receive({ type: "snapshot", snapshot: snapshot(1, [running]) });
    });
    expect(await screen.findByText("Видно до переключения")).toBeInTheDocument();

    await act(async () => {
      await refresh?.();
    });

    expect(screen.getByText("Пропущенное live-сообщение")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).pathname).toBe(
      "/api/v1/threads/thread/changes",
    );
    view.unmount();
  });

  it("lets authoritative recovery supersede an in-flight stale delta", async () => {
    const completed = { ...summary, state: "completed" as const, updatedAt: 3 };
    const running = {
      ...completed,
      state: "running" as const,
      currentTurnId: "implementation-turn",
      updatedAt: 4,
    };
    const planTurn: ThreadDetail["turns"][number] = {
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
          id: "plan",
          status: "completed",
          text: "Одобренный план",
          images: [],
          timestamp: 2,
          phase: null,
        },
      ],
      itemsLoaded: false,
    };
    const staleDetail: ThreadDetail = {
      summary: completed,
      turns: [planTurn],
      queuedMessages: [],
      olderTurnsCursor: null,
      syncPoint: {
        cursor: "plan-cursor",
        anchorTurnId: "plan-turn",
        anchorRevision: "plan-revision",
      },
    };
    const canonicalDetail: ThreadDetail = {
      ...staleDetail,
      summary: running,
      turns: [
        planTurn,
        {
          id: "implementation-turn",
          status: "inProgress",
          startedAt: 4,
          completedAt: null,
          durationMs: null,
          progress: {
            startedAt: 4,
            explanation: "Реализация",
            steps: [],
            filesChanged: 0,
            additions: 0,
            deletions: 0,
          },
          items: [
            {
              type: "agentMessage",
              id: "working",
              status: "inProgress",
              text: "Работа продолжается",
              images: [],
              timestamp: 4,
              phase: "commentary",
            },
          ],
          itemsLoaded: false,
        },
      ],
      syncPoint: {
        cursor: "implementation-cursor",
        anchorTurnId: "implementation-turn",
        anchorRevision: "implementation-revision",
      },
    };
    let resolveChanges!: (response: Response) => void;
    let resolveCanonical!: (response: Response) => void;
    const changesResponse = new Promise<Response>((resolve) => {
      resolveChanges = resolve;
    });
    const canonicalResponse = new Promise<Response>((resolve) => {
      resolveCanonical = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = input instanceof URL ? input : new URL(String(input));
      return url.pathname.endsWith("/changes") ? changesResponse : canonicalResponse;
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let refreshIncremental!: () => Promise<ThreadDetail>;
    let refreshAuthoritative!: () => Promise<ThreadDetail>;
    let seeded = false;

    function Probe() {
      const { dispatch, refreshDetail, state } = useConnection();
      useEffect(() => {
        if (seeded) return;
        seeded = true;
        dispatch({ type: "detail", detail: staleDetail, page: "latest" });
      }, [dispatch]);
      refreshIncremental = () => refreshDetail("thread", { force: true });
      refreshAuthoritative = () => refreshDetail("thread", { authoritative: true });
      const latest = state.details.thread?.turns.at(-1)?.items.at(-1);
      return <span>{latest && "text" in latest ? latest.text : "Ожидание"}</span>;
    }

    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <Probe />
      </ConnectionProvider>,
    );
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      socket.open();
      socket.receive({ type: "snapshot", snapshot: snapshot(1, [completed]) });
    });
    expect(await screen.findByText("Одобренный план")).toBeInTheDocument();

    let incremental!: Promise<ThreadDetail>;
    act(() => {
      incremental = refreshIncremental();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    act(() => {
      socket.receive({
        type: "event",
        sequence: 2,
        event: { type: "thread.upserted", thread: running },
      });
    });

    let authoritative!: Promise<ThreadDetail>;
    act(() => {
      authoritative = refreshAuthoritative();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "https://codexnest.example/api/v1/threads/thread/refresh",
    );

    await act(async () => {
      resolveCanonical(
        new Response(
          JSON.stringify({
            snapshot: snapshot(2, [running]),
            detail: canonicalDetail,
          }),
          { status: 200 },
        ),
      );
      await authoritative;
    });
    expect(screen.getByText("Работа продолжается")).toBeInTheDocument();

    await act(async () => {
      resolveChanges(
        new Response(
          JSON.stringify({
            summary: completed,
            turns: [],
            queuedMessages: [],
            draft: null,
            continuationCursor: null,
            syncPoint: staleDetail.syncPoint,
            resetLatest: false,
            olderTurnsCursor: null,
          }),
          { status: 200 },
        ),
      );
      await incremental;
    });
    expect(screen.getByText("Работа продолжается")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ snapshot: snapshot(2, [canonical.summary]), detail: canonical }),
          { status: 200 },
        ),
      );
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
      "/api/v1/threads/thread/refresh",
    ]);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ method: "POST" }));
    view.unmount();
  });

  it("repairs a stale terminal snapshot from a newer authoritative running detail", async () => {
    const staleCompleted = {
      ...summary,
      state: "completed" as const,
      unread: true,
      updatedAt: 2_000,
    };
    const running = {
      ...staleCompleted,
      state: "running" as const,
      unread: false,
      updatedAt: 2_000,
      currentTurnId: "live-turn",
    };
    const canonical: ThreadDetail = {
      summary: running,
      turns: [
        {
          id: "live-turn",
          status: "inProgress",
          startedAt: 2_000,
          completedAt: null,
          durationMs: null,
          progress: {
            startedAt: 2_000,
            explanation: null,
            steps: [],
            filesChanged: 0,
            additions: 0,
            deletions: 0,
          },
          items: [],
        },
      ],
      queuedMessages: [],
      olderTurnsCursor: null,
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ snapshot: snapshot(2, [running]), detail: canonical }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let refresh: (() => Promise<ThreadDetail>) | undefined;

    function Probe() {
      const { refreshDetail, state } = useConnection();
      refresh = () => refreshDetail("thread", { authoritative: true, force: true });
      const current = state.snapshot?.threads.find((thread) => thread.id === "thread");
      return <span>{`${current?.state ?? "none"}:${current?.currentTurnId ?? "none"}`}</span>;
    }

    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <Probe />
      </ConnectionProvider>,
    );
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      socket.open();
      socket.receive({ type: "snapshot", snapshot: snapshot(1, [staleCompleted]) });
    });
    expect(screen.getByText("completed:none")).toBeInTheDocument();

    await act(async () => {
      await refresh?.();
    });

    expect(screen.getByText("running:live-turn")).toBeInTheDocument();
    view.unmount();
  });

  it("accepts a completed delta summary before the reconnect snapshot arrives", async () => {
    const running = {
      ...summary,
      state: "running" as const,
      currentTurnId: "turn",
      updatedAt: 2,
    };
    const completed = {
      ...running,
      state: "completed" as const,
      currentTurnId: null,
      updatedAt: 4,
    };
    const staleDetail: ThreadDetail = {
      summary: running,
      turns: [
        {
          id: "turn",
          status: "inProgress",
          startedAt: 1,
          completedAt: null,
          durationMs: null,
          progress: {
            startedAt: 1,
            explanation: null,
            steps: [],
            filesChanged: 0,
            additions: 0,
            deletions: 0,
          },
          items: [],
        },
      ],
      queuedMessages: [],
      olderTurnsCursor: null,
      syncPoint: {
        cursor: "running-cursor",
        anchorTurnId: "turn",
        anchorRevision: "running-revision",
      },
    };
    const changes = {
      summary: completed,
      turns: [
        {
          id: "turn",
          status: "completed" as const,
          startedAt: 1,
          completedAt: 4,
          durationMs: 3,
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
              type: "agentMessage" as const,
              id: "final",
              status: "completed" as const,
              text: "Готовый ответ",
              images: [],
              timestamp: 4,
              phase: "final_answer" as const,
            },
          ],
        },
      ],
      queuedMessages: [],
      draft: null,
      continuationCursor: null,
      syncPoint: {
        cursor: "completed-cursor",
        anchorTurnId: "turn",
        anchorRevision: "completed-revision",
      },
      resetLatest: false,
      olderTurnsCursor: null,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(changes), { status: 200 }));
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
      const current = state.snapshot?.threads.find((thread) => thread.id === "thread");
      const latest = state.details.thread?.turns.at(-1)?.items.at(-1);
      return (
        <>
          <span>{`${current?.state ?? "none"}:${current?.currentTurnId ?? "none"}`}</span>
          <span>{latest && "text" in latest ? latest.text : ""}</span>
        </>
      );
    }

    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <Probe />
      </ConnectionProvider>,
    );
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      socket.open();
      socket.receive({ type: "snapshot", snapshot: snapshot(1, [running]) });
    });
    expect(await screen.findByText("running:turn")).toBeInTheDocument();

    await act(async () => {
      await refresh?.();
    });

    expect(screen.getByText("completed:none")).toBeInTheDocument();
    expect(screen.getByText("Готовый ответ")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).pathname).toBe(
      "/api/v1/threads/thread/changes",
    );
    view.unmount();
  });

  it("does not replace a newer stream summary with a late completed delta", async () => {
    const running = {
      ...summary,
      state: "running" as const,
      currentTurnId: "turn",
      updatedAt: 2,
    };
    const live = { ...running, title: "Live state", updatedAt: 5 };
    const staleDetail: ThreadDetail = {
      summary: running,
      turns: [
        {
          id: "turn",
          status: "inProgress",
          startedAt: 1,
          completedAt: null,
          durationMs: null,
          progress: {
            startedAt: 1,
            explanation: null,
            steps: [],
            filesChanged: 0,
            additions: 0,
            deletions: 0,
          },
          items: [],
        },
      ],
      queuedMessages: [],
      olderTurnsCursor: null,
      syncPoint: {
        cursor: "running-cursor",
        anchorTurnId: "turn",
        anchorRevision: "running-revision",
      },
    };
    let resolveChanges!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveChanges = resolve;
        }),
    );
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
      return <span>{state.snapshot?.threads[0]?.title ?? "none"}</span>;
    }

    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <Probe />
      </ConnectionProvider>,
    );
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      socket.open();
      socket.receive({ type: "snapshot", snapshot: snapshot(1, [running]) });
    });
    await screen.findByText("Thread");

    let pendingRefresh!: Promise<ThreadDetail>;
    act(() => {
      pendingRefresh = refresh!();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    act(() => {
      socket.receive({
        type: "event",
        sequence: 2,
        event: { type: "thread.upserted", thread: live },
      });
    });
    expect(screen.getByText("Live state")).toBeInTheDocument();

    await act(async () => {
      resolveChanges(
        new Response(
          JSON.stringify({
            summary: {
              ...running,
              state: "completed",
              currentTurnId: null,
              updatedAt: 4,
            },
            turns: [],
            queuedMessages: [],
            draft: null,
            continuationCursor: null,
            syncPoint: staleDetail.syncPoint,
            resetLatest: false,
            olderTurnsCursor: null,
          }),
          { status: 200 },
        ),
      );
      await pendingRefresh;
    });

    expect(screen.getByText("Live state")).toBeInTheDocument();
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
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ snapshot: snapshot(2, [completed]), detail: canonical }), {
          status: 200,
        }),
      );
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
      "/api/v1/threads/thread/refresh",
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
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ snapshot: snapshot(2, [running]), detail: canonical }), {
          status: 200,
        }),
      );
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

  it("reconnects a native app on resume without starting a global sync", async () => {
    capacitor.native = true;
    let appStateListener: ((state: { isActive: boolean }) => void) | undefined;
    addAppListener.mockImplementation((_event, listener) => {
      appStateListener = listener;
      return Promise.resolve({ remove: vi.fn().mockResolvedValue(undefined) });
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });

    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <SnapshotProbe />
        <ForegroundProbe />
        <AppActiveProbe />
      </ConnectionProvider>,
    );
    await waitFor(() =>
      expect(addAppListener).toHaveBeenCalledWith("appStateChange", expect.any(Function)),
    );

    act(() => appStateListener?.({ isActive: false }));
    expect(setNativeNotificationAppActive).toHaveBeenLastCalledWith(false);
    expect(screen.getByText("foreground:0")).toBeInTheDocument();
    expect(screen.getByText("active:false")).toBeInTheDocument();
    act(() => appStateListener?.({ isActive: true }));
    expect(setNativeNotificationAppActive).toHaveBeenLastCalledWith(true);
    expect(await screen.findByText("foreground:1")).toBeInTheDocument();
    expect(screen.getByText("active:true")).toBeInTheDocument();

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const resumed = FakeWebSocket.instances[1]!;
    act(() => {
      resumed.open();
      resumed.receive({ type: "snapshot", snapshot: snapshot(2, []) });
    });
    expect(await screen.findByText("snapshot:2")).toBeInTheDocument();
    view.unmount();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });

  it("tracks whether the web app is actually visible", () => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("WebSocket", FakeWebSocket);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <AppActiveProbe />
      </ConnectionProvider>,
    );
    expect(screen.getByText("active:true")).toBeInTheDocument();

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(screen.getByText("active:false")).toBeInTheDocument();

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(screen.getByText("active:true")).toBeInTheDocument();
    view.unmount();
  });

  it("requests detail recovery only after a subsequent stream snapshot", () => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("WebSocket", FakeWebSocket);

    function Probe() {
      const { streamRecoveryEpoch } = useConnection();
      return <span>{`recovery:${streamRecoveryEpoch}`}</span>;
    }

    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <Probe />
      </ConnectionProvider>,
    );
    const socket = FakeWebSocket.instances[0]!;
    expect(screen.getByText("recovery:0")).toBeInTheDocument();

    act(() => {
      socket.open();
      socket.receive({ type: "snapshot", snapshot: snapshot(1) });
    });
    expect(screen.getByText("recovery:0")).toBeInTheDocument();

    act(() => {
      socket.receive({ type: "snapshot", snapshot: snapshot(2) });
    });
    expect(screen.getByText("recovery:1")).toBeInTheDocument();
    view.unmount();
  });

  it("starts a current-generation detail read immediately on native resume", async () => {
    capacitor.native = true;
    let appStateListener: ((state: { isActive: boolean }) => void) | undefined;
    addAppListener.mockImplementation((_event, listener) => {
      appStateListener = listener;
      return Promise.resolve({ remove: vi.fn().mockResolvedValue(undefined) });
    });
    const foregroundSummary = {
      ...summary,
      id: "foreground-thread",
      title: "Актуальная сессия",
    };
    const detail: ThreadDetail = {
      summary: foregroundSummary,
      turns: [],
      queuedMessages: [],
      olderTurnsCursor: null,
    };
    const responses: Array<(response: Response) => void> = [];
    const requestedPaths: string[] = [];
    const fetchMock = vi.fn(
      (input: RequestInfo | URL) =>
        new Promise<Response>((resolve) => {
          requestedPaths.push(new URL(String(input)).pathname);
          responses.push(resolve);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    function Probe() {
      const { foregroundEpoch, refreshDetail, state } = useConnection();
      useEffect(() => {
        void refreshDetail("foreground-thread", { force: true }).catch(() => undefined);
      }, [foregroundEpoch, refreshDetail]);
      return <span>{state.details["foreground-thread"]?.summary.title ?? "Ожидание"}</span>;
    }

    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <Probe />
      </ConnectionProvider>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(addAppListener).toHaveBeenCalledWith("appStateChange", expect.any(Function)),
    );

    act(() => appStateListener?.({ isActive: true }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(FakeWebSocket.instances).toHaveLength(2);
    await act(async () => {
      responses[0]?.(new Response(JSON.stringify(detail), { status: 200 }));
      responses[1]?.(new Response(JSON.stringify(detail), { status: 200 }));
      await Promise.resolve();
    });
    expect(await screen.findByText("Актуальная сессия")).toBeInTheDocument();
    view.unmount();
  });

  it("forwards only accepted native stream frames to the notification bridge", () => {
    capacitor.native = true;
    addAppListener.mockResolvedValue({ remove: vi.fn().mockResolvedValue(undefined) });
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <SnapshotProbe />
      </ConnectionProvider>,
    );
    const socket = FakeWebSocket.instances[0]!;
    const initial = snapshot(1);

    act(() => {
      socket.open();
      socket.receive({ type: "snapshot", snapshot: initial });
      socket.receive({
        type: "event",
        sequence: 2,
        event: { type: "thread.upserted", thread: summary },
      });
      socket.receive({
        type: "event",
        sequence: 2,
        event: { type: "attention.removed", attentionId: "late-duplicate" },
      });
    });

    expect(observeNativeNotificationSnapshot).toHaveBeenCalledOnce();
    expect(observeNativeNotificationSnapshot).toHaveBeenCalledWith(initial);
    expect(observeNativeNotificationEvent).toHaveBeenCalledOnce();
    expect(observeNativeNotificationEvent).toHaveBeenCalledWith(2, {
      type: "thread.upserted",
      thread: summary,
    });
    view.unmount();
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

  it("ignores late events from the socket replaced on resume", async () => {
    capacitor.native = true;
    let appStateListener: ((state: { isActive: boolean }) => void) | undefined;
    addAppListener.mockImplementation((_event, listener) => {
      appStateListener = listener;
      return Promise.resolve({ remove: vi.fn().mockResolvedValue(undefined) });
    });
    const synced = { ...summary, title: "Синхронизировано" };
    vi.stubGlobal("fetch", vi.fn());
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
      resumedSocket.open();
      resumedSocket.receive({ type: "snapshot", snapshot: snapshot(3, [synced]) });
    });
    expect(await screen.findByText("Синхронизировано")).toBeInTheDocument();
    act(() => {
      socket.receive({
        type: "event",
        sequence: 2,
        event: { type: "thread.upserted", thread: { ...summary, title: "Устарело" } },
      });
    });

    expect(screen.getByText("Синхронизировано")).toBeInTheDocument();
    expect(screen.queryByText("Устарело")).toBeNull();
    view.unmount();
  });

  it("persists choices immediately, debounces typing, and flushes pending text on pagehide", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        answers: Record<string, string[]>;
        currentQuestionId: string | null;
      };
      return new Response(
        JSON.stringify({ ...body, revision: fetchMock.mock.calls.length, updatedAt: Date.now() }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let controls: ReturnType<typeof useConnection> | undefined;
    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <DraftProbe onConnection={(value) => (controls = value)} />
      </ConnectionProvider>,
    );

    act(() =>
      controls!.updateUserInputDraft(
        "questions",
        { answers: { first: ["Да"] }, currentQuestionId: "first" },
        "immediate",
      ),
    );
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "PUT", keepalive: true });

    act(() =>
      controls!.updateUserInputDraft(
        "questions",
        { answers: { first: ["Да"], second: ["т"] }, currentQuestionId: "second" },
        "debounced",
      ),
    );
    act(() => vi.advanceTimersByTime(499));
    expect(fetchMock).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(1));
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    act(() =>
      controls!.updateUserInputDraft(
        "questions",
        { answers: { second: ["готово"] }, currentQuestionId: "second" },
        "debounced",
      ),
    );
    act(() => window.dispatchEvent(new Event("pagehide")));
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      answers: { second: ["готово"] },
      currentQuestionId: "second",
    });
    view.unmount();
  });

  it("coalesces sequential saves and sends only the newest pending snapshot", async () => {
    const responses: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn<(url: URL, init?: RequestInit) => Promise<Response>>(
      () =>
        new Promise<Response>((resolve) => {
          responses.push(resolve);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let controls: ReturnType<typeof useConnection> | undefined;
    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <DraftProbe onConnection={(value) => (controls = value)} />
      </ConnectionProvider>,
    );

    act(() => {
      controls!.updateUserInputDraft(
        "questions",
        { answers: { first: ["A"] }, currentQuestionId: "first" },
        "immediate",
      );
      controls!.updateUserInputDraft(
        "questions",
        { answers: { first: ["C"] }, currentQuestionId: "third" },
        "immediate",
      );
      controls!.updateUserInputDraft(
        "questions",
        { answers: { first: ["D"] }, currentQuestionId: "fourth" },
        "immediate",
      );
    });
    expect(fetchMock).toHaveBeenCalledOnce();

    act(() =>
      responses[0]?.(
        new Response(
          JSON.stringify({
            answers: { first: ["A"] },
            currentQuestionId: "first",
            revision: 1,
            updatedAt: 1,
          }),
        ),
      ),
    );
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      answers: { first: ["D"] },
      currentQuestionId: "fourth",
    });
    act(() =>
      responses[1]?.(
        new Response(
          JSON.stringify({
            answers: { first: ["D"] },
            currentQuestionId: "fourth",
            revision: 2,
            updatedAt: 2,
          }),
        ),
      ),
    );
    await flushPromises();
    view.unmount();
  });

  it("keeps an optimistic draft across route unmount and retries a failure on the next edit", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "offline", message: "offline" } }), {
          status: 503,
        }),
      )
      .mockImplementation(async (_url: URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ ...body, revision: 1, updatedAt: 1 }));
      });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let controls: ReturnType<typeof useConnection> | undefined;
    const settings = { baseUrl: "https://codexnest.example", token: "token" };
    const content = (show: boolean) => (
      <ConnectionProvider settings={settings}>
        {show && <DraftProbe onConnection={(value) => (controls = value)} flushOnUnmount />}
      </ConnectionProvider>
    );
    const view = render(content(true));

    act(() =>
      controls!.updateUserInputDraft(
        "questions",
        { answers: { first: ["Локально"] }, currentQuestionId: "first" },
        "immediate",
      ),
    );
    await flushPromises();
    expect(screen.getByRole("status")).toHaveTextContent("offline");
    expect(screen.getByText("Локально")).toBeInTheDocument();

    act(() =>
      controls!.updateUserInputDraft(
        "questions",
        { answers: { first: ["Исправлено"] }, currentQuestionId: "first" },
        "debounced",
      ),
    );
    view.rerender(content(false));
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    view.rerender(content(true));
    expect(screen.getByText("Исправлено")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("ok");
    view.unmount();
  });
});

function snapshot(sequence: number, threads: ThreadSummary[] = [summary]): AppSnapshot {
  return {
    sequence,
    uiLanguage: "ru",
    connection: { state: "ready", message: null, syncedAt: "2026-08-03T00:00:00.000Z" },
    projects: [],
    threads,
    forkOperations: [],
    attention: [],
    models: [],
  };
}

function SnapshotProbe() {
  const { state } = useConnection();
  return <span>snapshot:{state.snapshot?.sequence ?? "none"}</span>;
}

function ForegroundProbe() {
  const { foregroundEpoch } = useConnection();
  return <span>foreground:{foregroundEpoch}</span>;
}

function AppActiveProbe() {
  const { appActive } = useConnection();
  return <span>active:{String(appActive)}</span>;
}

function ThreadTitleProbe() {
  const { state } = useConnection();
  return <span>{state.snapshot?.threads[0]?.title ?? "none"}</span>;
}

function DraftProbe({
  onConnection,
  flushOnUnmount = false,
}: {
  onConnection(value: ReturnType<typeof useConnection>): void;
  flushOnUnmount?: boolean;
}) {
  const connection = useConnection();
  const flush = connection.flushUserInputDraft;
  onConnection(connection);
  useEffect(
    () => () => {
      if (flushOnUnmount) flush("questions");
    },
    [flush, flushOnUnmount],
  );
  const draft = connection.state.userInputDrafts.questions;
  return (
    <>
      <span>{draft?.answers.first?.[0] ?? "empty"}</span>
      <span role="status">{draft?.error ?? "ok"}</span>
    </>
  );
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
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
