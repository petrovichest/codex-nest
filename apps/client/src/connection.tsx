import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import {
  createContext,
  type Dispatch,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import { isServerFrame, type ThreadDetail } from "@codexnest/protocol";

import { ApiClient } from "./api";
import { BrowserNotificationTracker } from "./browser-notifications";
import { clientReducer, initialState, type ClientAction, type ClientState } from "./state";
import type { ConnectionSettings } from "./storage";

interface ConnectionContextValue {
  api: ApiClient;
  state: ClientState;
  dispatch: Dispatch<ClientAction>;
  refreshDetail(threadId: string): Promise<ThreadDetail>;
  loadOlderDetail(threadId: string, cursor: string): Promise<ThreadDetail>;
  reconnect(): void;
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null);

export function ConnectionProvider({
  settings,
  children,
}: PropsWithChildren<{ settings: ConnectionSettings }>) {
  const api = useMemo(() => new ApiClient(settings), [settings]);
  const [state, dispatch] = useReducer(clientReducer, initialState);
  const [generation, setGeneration] = useState(0);
  const sequence = useRef<number | null>(null);
  const detailRequests = useRef(new Map<string, Promise<ThreadDetail>>());
  const browserNotifications = useMemo(
    () => (Capacitor.isNativePlatform() ? null : new BrowserNotificationTracker()),
    [],
  );

  const reconnect = useCallback(() => setGeneration((value) => value + 1), []);
  const readDetail = useCallback(
    (threadId: string, cursor?: string) => {
      const key = JSON.stringify([threadId, cursor ?? null]);
      const current = detailRequests.current.get(key);
      if (current) return current;
      const request = api
        .readThread(threadId, cursor)
        .then((detail) => {
          dispatch({ type: "detail", detail, page: cursor ? "older" : "latest" });
          return detail;
        })
        .finally(() => {
          if (detailRequests.current.get(key) === request) detailRequests.current.delete(key);
        });
      detailRequests.current.set(key, request);
      return request;
    },
    [api],
  );
  const refreshDetail = useCallback((threadId: string) => readDetail(threadId), [readDetail]);
  const loadOlderDetail = useCallback(
    (threadId: string, cursor: string) => readDetail(threadId, cursor),
    [readDetail],
  );

  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | undefined;
    let retryTimer: number | undefined;
    let retry = 0;
    const delays = [1_000, 2_000, 4_000, 8_000, 15_000];

    const connect = () => {
      if (stopped) return;
      dispatch({ type: "network", network: "connecting" });
      socket = new WebSocket(api.webSocketUrl());
      socket.addEventListener("open", () => {
        socket?.send(JSON.stringify({ type: "authenticate", token: settings.token }));
      });
      socket.addEventListener("message", (message) => {
        let frame: unknown;
        try {
          frame = JSON.parse(String(message.data));
        } catch {
          socket?.close();
          return;
        }
        if (!isServerFrame(frame)) {
          socket?.close();
          return;
        }
        if (frame.type === "snapshot") {
          retry = 0;
          sequence.current = frame.snapshot.sequence;
          browserNotifications?.acceptSnapshot(frame.snapshot);
          dispatch({ type: "snapshot", snapshot: frame.snapshot });
        } else if (frame.type === "event") {
          if (sequence.current === null || frame.sequence !== sequence.current + 1) {
            socket?.close();
            return;
          }
          sequence.current = frame.sequence;
          browserNotifications?.acceptEvent(frame.event);
          dispatch({ type: "event", sequence: frame.sequence, event: frame.event });
        } else if (frame.type === "error") {
          dispatch({ type: "network", network: "offline", error: frame.error.message });
        }
      });
      socket.addEventListener("close", () => {
        if (stopped) return;
        sequence.current = null;
        dispatch({ type: "network", network: "offline", error: "Связь с сервером потеряна" });
        const delay = delays[Math.min(retry, delays.length - 1)] ?? 15_000;
        retry += 1;
        retryTimer = window.setTimeout(connect, delay);
      });
      socket.addEventListener("error", () => socket?.close());
    };

    connect();
    return () => {
      stopped = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, [api, browserNotifications, generation, settings.token]);

  useEffect(() => {
    const foreground = () => {
      if (document.visibilityState === "visible") {
        reconnect();
        void api
          .sync()
          .catch(() => undefined)
          .finally(reconnect);
      }
    };
    document.addEventListener("visibilitychange", foreground);
    let removeNativeListener: (() => Promise<void>) | undefined;
    if (Capacitor.isNativePlatform()) {
      void CapacitorApp.addListener("appStateChange", ({ isActive }) => {
        if (isActive) foreground();
      }).then((handle) => {
        removeNativeListener = () => handle.remove();
      });
    }
    return () => {
      document.removeEventListener("visibilitychange", foreground);
      void removeNativeListener?.();
    };
  }, [api, reconnect]);

  const value = useMemo(
    () => ({ api, state, dispatch, refreshDetail, loadOlderDetail, reconnect }),
    [api, state, refreshDetail, loadOlderDetail, reconnect],
  );
  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnection(): ConnectionContextValue {
  const value = useContext(ConnectionContext);
  if (!value) throw new Error("useConnection must be used inside ConnectionProvider");
  return value;
}
