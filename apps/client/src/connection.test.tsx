import { useEffect } from "react";
import { act, render, waitFor } from "@testing-library/react";
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
