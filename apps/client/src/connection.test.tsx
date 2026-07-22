import { useEffect } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ThreadDetail, ThreadSummary } from "@codexnest/protocol";

import { ConnectionProvider, useConnection } from "./connection";

const capacitor = vi.hoisted(() => ({ native: false }));
const addAppListener = vi.hoisted(() => vi.fn());

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => capacitor.native },
}));
vi.mock("@capacitor/app", () => ({ App: { addListener: addAppListener } }));

const summary: ThreadSummary = {
  id: "thread",
  projectId: null,
  title: "Thread",
  preview: "",
  cwd: "/work",
  state: "idle",
  unread: false,
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
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          sequence: 1,
          connection: { state: "ready", message: null, syncedAt: null },
          projects: [],
          threads: [],
          attention: [],
          models: [],
          pushConfigured: false,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });

    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <div />
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
    view.unmount();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });
});

class FakeWebSocket {
  readyState = 0;

  addEventListener(): void {}
  send(): void {}
  close(): void {}
}
