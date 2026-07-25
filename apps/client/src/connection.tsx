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

import { isServerFrame, type AppSnapshot, type ThreadDetail } from "@codexnest/protocol";

import { ApiClient } from "./api";
import { BrowserNotificationTracker } from "./browser-notifications";
import { translate, useI18n } from "./i18n";
import { clientReducer, initialState, type ClientAction, type ClientState } from "./state";
import type { ConnectionSettings } from "./storage";

const HEARTBEAT_IDLE_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

interface ConnectionContextValue {
  api: ApiClient;
  state: ClientState;
  dispatch: Dispatch<ClientAction>;
  refreshDetail(threadId: string, options?: { force?: boolean }): Promise<ThreadDetail>;
  loadOlderDetail(threadId: string, cursor: string): Promise<ThreadDetail>;
  reconnect(): number;
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null);

export function ConnectionProvider({
  settings,
  children,
}: PropsWithChildren<{ settings: ConnectionSettings }>) {
  const { language } = useI18n();
  const api = useMemo(() => new ApiClient(settings), [settings]);
  const [state, dispatch] = useReducer(clientReducer, initialState);
  const languageRef = useRef(language);
  const [generation, setGeneration] = useState(0);
  const generationRef = useRef(0);
  const streamSequence = useRef<number | null>(null);
  const appliedSequence = useRef<number | null>(null);
  const syncedSnapshotFloor = useRef<{ generation: number; sequence: number } | null>(null);
  const detailRequests = useRef(new Map<string, Promise<ThreadDetail>>());
  const detailRequestVersions = useRef(new Map<string, number>());
  const browserNotifications = useMemo(
    () => (Capacitor.isNativePlatform() ? null : new BrowserNotificationTracker()),
    [],
  );

  useEffect(() => {
    languageRef.current = language;
    browserNotifications?.setLanguage(language);
  }, [browserNotifications, language]);

  const reconnect = useCallback(() => {
    const next = generationRef.current + 1;
    generationRef.current = next;
    setGeneration(next);
    return next;
  }, []);
  const acceptSyncedSnapshot = useCallback(
    (snapshot: AppSnapshot, targetGeneration: number) => {
      if (generationRef.current !== targetGeneration) return;
      if (appliedSequence.current !== null && snapshot.sequence < appliedSequence.current) {
        return;
      }
      appliedSequence.current = snapshot.sequence;
      syncedSnapshotFloor.current = {
        generation: targetGeneration,
        sequence: snapshot.sequence,
      };
      browserNotifications?.acceptSnapshot(snapshot);
      dispatch({ type: "snapshot", snapshot });
    },
    [browserNotifications],
  );
  const readDetail = useCallback(
    (threadId: string, cursor?: string, force = false) => {
      const key = JSON.stringify([threadId, cursor ?? null]);
      const current = detailRequests.current.get(key);
      if (current && !force) return current;
      const version = (detailRequestVersions.current.get(key) ?? 0) + 1;
      detailRequestVersions.current.set(key, version);
      const request = api
        .readThread(threadId, cursor, { fresh: force })
        .then((detail) => {
          if (detailRequestVersions.current.get(key) === version) {
            dispatch({ type: "detail", detail, page: cursor ? "older" : "latest" });
          }
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
  const refreshDetail = useCallback(
    (threadId: string, options?: { force?: boolean }) =>
      readDetail(threadId, undefined, options?.force),
    [readDetail],
  );
  const loadOlderDetail = useCallback(
    (threadId: string, cursor: string) => readDetail(threadId, cursor),
    [readDetail],
  );

  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | undefined;
    let retryTimer: number | undefined;
    let heartbeatTimer: number | undefined;
    let heartbeatTimeout: number | undefined;
    let retry = 0;
    const delays = [1_000, 2_000, 4_000, 8_000, 15_000];

    const clearHeartbeat = () => {
      if (heartbeatTimer !== undefined) window.clearTimeout(heartbeatTimer);
      if (heartbeatTimeout !== undefined) window.clearTimeout(heartbeatTimeout);
      heartbeatTimer = undefined;
      heartbeatTimeout = undefined;
    };

    const scheduleHeartbeat = (candidate: WebSocket) => {
      clearHeartbeat();
      if (stopped || socket !== candidate) return;
      heartbeatTimer = window.setTimeout(() => {
        heartbeatTimer = undefined;
        if (stopped || socket !== candidate || candidate.readyState !== WebSocket.OPEN) return;
        candidate.send(JSON.stringify({ type: "ping" }));
        heartbeatTimeout = window.setTimeout(() => {
          heartbeatTimeout = undefined;
          if (!stopped && socket === candidate) candidate.close();
        }, HEARTBEAT_TIMEOUT_MS);
      }, HEARTBEAT_IDLE_MS);
    };

    const connect = () => {
      if (stopped) return;
      dispatch({ type: "network", network: "connecting" });
      const candidate = new WebSocket(api.webSocketUrl());
      socket = candidate;
      candidate.addEventListener("open", () => {
        if (stopped || socket !== candidate) return;
        candidate.send(JSON.stringify({ type: "authenticate", token: settings.token }));
      });
      candidate.addEventListener("message", (message) => {
        if (stopped || socket !== candidate) return;
        let frame: unknown;
        try {
          frame = JSON.parse(String(message.data));
        } catch {
          candidate.close();
          return;
        }
        if (!isServerFrame(frame)) {
          candidate.close();
          return;
        }
        scheduleHeartbeat(candidate);
        if (frame.type === "snapshot") {
          retry = 0;
          streamSequence.current = frame.snapshot.sequence;
          const floor = syncedSnapshotFloor.current;
          if (floor?.generation === generation && frame.snapshot.sequence < floor.sequence) {
            return;
          }
          if (floor?.generation === generation) syncedSnapshotFloor.current = null;
          appliedSequence.current = frame.snapshot.sequence;
          browserNotifications?.acceptSnapshot(frame.snapshot);
          dispatch({ type: "snapshot", snapshot: frame.snapshot });
        } else if (frame.type === "event") {
          if (streamSequence.current === null || frame.sequence !== streamSequence.current + 1) {
            candidate.close();
            return;
          }
          streamSequence.current = frame.sequence;
          if (appliedSequence.current !== null && frame.sequence <= appliedSequence.current) {
            const floor = syncedSnapshotFloor.current;
            if (floor?.generation === generation && frame.sequence >= floor.sequence) {
              syncedSnapshotFloor.current = null;
            }
            return;
          }
          appliedSequence.current = frame.sequence;
          if (syncedSnapshotFloor.current?.generation === generation) {
            syncedSnapshotFloor.current = null;
          }
          browserNotifications?.acceptEvent(frame.event);
          dispatch({ type: "event", sequence: frame.sequence, event: frame.event });
        } else if (frame.type === "error") {
          dispatch({ type: "network", network: "offline", error: frame.error.message });
        }
      });
      candidate.addEventListener("close", () => {
        if (stopped || socket !== candidate) return;
        socket = undefined;
        clearHeartbeat();
        streamSequence.current = null;
        dispatch({
          type: "network",
          network: "offline",
          error: translate(languageRef.current, "Связь с сервером потеряна"),
        });
        const delay = delays[Math.min(retry, delays.length - 1)] ?? 15_000;
        retry += 1;
        retryTimer = window.setTimeout(connect, delay);
      });
      candidate.addEventListener("error", () => candidate.close());
    };

    connect();
    return () => {
      stopped = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      clearHeartbeat();
      streamSequence.current = null;
      socket?.close();
    };
  }, [api, browserNotifications, generation, settings.token]);

  useEffect(() => {
    const refresh = () => {
      const targetGeneration = reconnect();
      void api
        .sync()
        .then((snapshot) => acceptSyncedSnapshot(snapshot, targetGeneration))
        .catch(() => undefined);
    };
    const foreground = () => {
      if (document.visibilityState === "visible") refresh();
    };
    let removeNativeListener: (() => Promise<void>) | undefined;
    if (Capacitor.isNativePlatform()) {
      void CapacitorApp.addListener("appStateChange", ({ isActive }) => {
        if (isActive) refresh();
      }).then((handle) => {
        removeNativeListener = () => handle.remove();
      });
    } else {
      document.addEventListener("visibilitychange", foreground);
    }
    return () => {
      document.removeEventListener("visibilitychange", foreground);
      void removeNativeListener?.();
    };
  }, [acceptSyncedSnapshot, api, reconnect]);

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
