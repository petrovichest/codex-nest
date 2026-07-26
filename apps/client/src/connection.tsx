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

import {
  isServerFrame,
  type AppSnapshot,
  type QueueMessageRequest,
  type ThreadDetail,
  type ThreadSummary,
  type UpdateThreadDraftRequest,
  type VoiceTranscriptionMode,
} from "@codexnest/protocol";

import { ApiClient, isRetryableApiError } from "./api";
import { BrowserNotificationTracker } from "./browser-notifications";
import { translate, useI18n } from "./i18n";
import {
  loadCachedMeta,
  loadCachedThread,
  connectionCacheKey,
  deleteOutboxMessage,
  deleteCachedThread,
  deletePendingVoiceRecording,
  confirmLocalDraft,
  listOutboxMessages,
  listPendingVoiceRecordings,
  putOutboxMessage,
  putPendingVoiceRecording,
  saveCachedMeta,
  saveCachedThread,
  saveLocalDraft,
  type OutboxMessage,
  type PendingVoiceRecording,
} from "./offline-store";
import {
  clientReducer,
  initialState,
  mergeThreadDetailChanges,
  type ClientAction,
  type ClientState,
} from "./state";
import type { ConnectionSettings } from "./storage";

const HEARTBEAT_IDLE_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const DETAIL_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const;

type DetailReadOptions = {
  authoritative?: boolean;
  force?: boolean;
};

type DetailReader = (
  threadId: string,
  cursor?: string,
  options?: DetailReadOptions,
) => Promise<ThreadDetail>;

interface ConnectionContextValue {
  api: ApiClient;
  state: ClientState;
  dispatch: Dispatch<ClientAction>;
  refreshDetail(threadId: string, options?: DetailReadOptions): Promise<ThreadDetail>;
  loadOlderDetail(threadId: string, cursor: string): Promise<ThreadDetail>;
  sendReliable(
    threadId: string,
    body: QueueMessageRequest & { clientMessageId: string },
  ): Promise<"delivered" | "pending">;
  queueVoiceRecording(recording: {
    id: string;
    threadId: string;
    audio: Blob;
    durationMs: number;
    mode: VoiceTranscriptionMode;
    selectionStart: number;
    selectionEnd: number;
    draftUpdatedAt: number | null;
    draft: UpdateThreadDraftRequest;
  }): Promise<"accepted" | "pending">;
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
  const stateRef = useRef(state);
  const languageRef = useRef(language);
  const [generation, setGeneration] = useState(0);
  const generationRef = useRef(0);
  const streamSequence = useRef<number | null>(null);
  const appliedSequence = useRef<number | null>(null);
  const syncedSnapshotFloor = useRef<{ generation: number; sequence: number } | null>(null);
  const detailRequests = useRef(new Map<string, Promise<ThreadDetail>>());
  const detailRequestVersions = useRef(new Map<string, number>());
  const detailReader = useRef<DetailReader | null>(null);
  const detailRetryAttempts = useRef(new Map<string, number>());
  const detailRetryTimers = useRef(new Map<string, number>());
  const persistedDetails = useRef<Record<string, ThreadDetail>>({});
  const detailPersistTimers = useRef(new Map<string, number>());
  const persistenceConnectionKey = useRef(connectionCacheKey(settings));
  const foregroundRefresh = useRef<Promise<void> | null>(null);
  const outboxDrain = useRef<Promise<void> | null>(null);
  const outboxRetryTimer = useRef<number | undefined>(undefined);
  const voiceDrain = useRef<Promise<void> | null>(null);
  const voiceRetryTimer = useRef<number | undefined>(undefined);
  const browserNotifications = useMemo(
    () => (Capacitor.isNativePlatform() ? null : new BrowserNotificationTracker()),
    [],
  );

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    languageRef.current = language;
    browserNotifications?.setLanguage(language);
  }, [browserNotifications, language]);

  useEffect(() => {
    let active = true;
    void Promise.all([loadCachedMeta(settings), listOutboxMessages(settings)]).then(
      ([cached, outbox]) => {
        if (!active) return;
        if (cached) dispatch({ type: "hydrate", snapshot: cached.snapshot, goals: cached.goals });
        for (const message of outbox) {
          dispatch({
            type: "optimistic.add",
            message: {
              id: message.id,
              threadId: message.threadId,
              text: message.input,
              images: message.images,
              createdAt: message.createdAt,
              destination: "queue",
              turnId: null,
            },
          });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [settings]);

  useEffect(() => {
    if (!state.snapshot) return;
    const timer = window.setTimeout(() => {
      void saveCachedMeta(settings, state.snapshot, state.goals);
    }, 100);
    return () => window.clearTimeout(timer);
  }, [settings, state.goals, state.snapshot]);

  useEffect(() => {
    const connectionKey = connectionCacheKey(settings);
    if (persistenceConnectionKey.current !== connectionKey) {
      for (const timer of detailPersistTimers.current.values()) window.clearTimeout(timer);
      detailPersistTimers.current.clear();
      persistedDetails.current = {};
      persistenceConnectionKey.current = connectionKey;
    }
    const previous = persistedDetails.current;
    persistedDetails.current = state.details;
    for (const [threadId, detail] of Object.entries(state.details)) {
      if (previous[threadId] === detail) continue;
      const existing = detailPersistTimers.current.get(threadId);
      if (existing !== undefined) window.clearTimeout(existing);
      const timer = window.setTimeout(() => {
        if (detailPersistTimers.current.get(threadId) !== timer) return;
        detailPersistTimers.current.delete(threadId);
        void saveCachedThread(settings, detail);
      }, 750);
      detailPersistTimers.current.set(threadId, timer);
    }
    for (const threadId of Object.keys(previous)) {
      if (threadId in state.details) continue;
      const existing = detailPersistTimers.current.get(threadId);
      if (existing !== undefined) window.clearTimeout(existing);
      detailPersistTimers.current.delete(threadId);
      void deleteCachedThread(settings, threadId);
    }
  }, [settings, state.details]);

  useEffect(
    () => () => {
      for (const timer of detailPersistTimers.current.values()) window.clearTimeout(timer);
      detailPersistTimers.current.clear();
    },
    [],
  );

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

  const clearDetailRetry = useCallback((threadId: string) => {
    const timer = detailRetryTimers.current.get(threadId);
    if (timer !== undefined) window.clearTimeout(timer);
    detailRetryTimers.current.delete(threadId);
    detailRetryAttempts.current.delete(threadId);
  }, []);

  const scheduleDetailRetry = useCallback(function schedule(threadId: string): void {
    if (detailRetryTimers.current.has(threadId)) return;
    const attempt = detailRetryAttempts.current.get(threadId) ?? 0;
    const delay =
      DETAIL_RETRY_DELAYS_MS[Math.min(attempt, DETAIL_RETRY_DELAYS_MS.length - 1)] ?? 30_000;
    detailRetryAttempts.current.set(threadId, attempt + 1);
    const timer = window.setTimeout(() => {
      if (detailRetryTimers.current.get(threadId) !== timer) return;
      detailRetryTimers.current.delete(threadId);
      const read = detailReader.current;
      if (!read) return;
      void read(threadId, undefined, { authoritative: true, force: true })
        .then((detail) => {
          const summary =
            stateRef.current.snapshot?.threads.find((thread) => thread.id === threadId) ??
            detail.summary;
          if (threadDetailNeedsRecovery(detail, summary)) schedule(threadId);
          else {
            detailRetryAttempts.current.delete(threadId);
          }
        })
        .catch((error: unknown) => {
          if (isRetryableApiError(error)) schedule(threadId);
          else detailRetryAttempts.current.delete(threadId);
        });
    }, delay);
    detailRetryTimers.current.set(threadId, timer);
  }, []);

  const readDetail = useCallback(
    (threadId: string, cursor?: string, options: DetailReadOptions = {}) => {
      const key = JSON.stringify([threadId, cursor ?? null]);
      const current = detailRequests.current.get(key);
      if (current) return current;
      const version = (detailRequestVersions.current.get(key) ?? 0) + 1;
      detailRequestVersions.current.set(key, version);
      const request = (async () => {
        const authoritativeLatest = async (): Promise<ThreadDetail> => {
          const detail = await api.readThread(threadId, undefined, { fresh: true });
          if (detailRequestVersions.current.get(key) === version) {
            dispatch({ type: "detail", detail, page: "reset" });
          }
          return detail;
        };
        try {
          let detail: ThreadDetail;
          let baseline = stateRef.current.details[threadId];
          if (!cursor && !baseline) {
            const cached = await loadCachedThread(settings, threadId);
            if (cached && detailRequestVersions.current.get(key) === version) {
              baseline = cached;
              dispatch({ type: "hydrate.detail", detail: cached });
            }
          }
          if (!cursor && baseline?.syncPoint && !options.authoritative) {
            try {
              let merged = baseline;
              let continuationCursor: string | undefined;
              do {
                const changes = await api.readThreadChanges(
                  threadId,
                  merged.syncPoint ?? baseline.syncPoint,
                  continuationCursor,
                );
                merged = mergeThreadDetailChanges(merged, changes);
                if (detailRequestVersions.current.get(key) === version) {
                  dispatch({ type: "changes", threadId, changes });
                }
                continuationCursor = changes.continuationCursor ?? undefined;
              } while (continuationCursor);
              const summary =
                stateRef.current.snapshot?.threads.find((thread) => thread.id === threadId) ??
                merged.summary;
              detail = threadDetailNeedsRecovery(merged, summary)
                ? await authoritativeLatest()
                : merged;
            } catch {
              detail = await authoritativeLatest();
            }
          } else if (!cursor && options.authoritative) {
            detail = await authoritativeLatest();
          } else {
            detail = await api.readThread(threadId, cursor, { fresh: options.force });
            if (detailRequestVersions.current.get(key) === version) {
              dispatch({ type: "detail", detail, page: cursor ? "older" : "latest" });
            }
          }
          if (!cursor) {
            const summary =
              stateRef.current.snapshot?.threads.find((thread) => thread.id === threadId) ??
              detail.summary;
            if (threadDetailNeedsRecovery(detail, summary)) scheduleDetailRetry(threadId);
            else clearDetailRetry(threadId);
          }
          return detail;
        } catch (error) {
          if (!cursor && isRetryableApiError(error)) scheduleDetailRetry(threadId);
          throw error;
        }
      })().finally(() => {
        if (detailRequests.current.get(key) === request) detailRequests.current.delete(key);
      });
      detailRequests.current.set(key, request);
      return request;
    },
    [api, clearDetailRetry, scheduleDetailRetry, settings],
  );
  detailReader.current = readDetail;

  const refreshDetail = useCallback(
    (threadId: string, options?: DetailReadOptions) => readDetail(threadId, undefined, options),
    [readDetail],
  );
  const loadOlderDetail = useCallback(
    (threadId: string, cursor: string) => readDetail(threadId, cursor),
    [readDetail],
  );

  useEffect(() => {
    for (const [threadId, detail] of Object.entries(state.details)) {
      const summary =
        state.snapshot?.threads.find((thread) => thread.id === threadId) ?? detail.summary;
      if (threadDetailNeedsRecovery(detail, summary)) scheduleDetailRetry(threadId);
      else clearDetailRetry(threadId);
    }
  }, [clearDetailRetry, scheduleDetailRetry, state.details, state.snapshot?.threads]);

  useEffect(
    () => () => {
      for (const timer of detailRetryTimers.current.values()) window.clearTimeout(timer);
      detailRetryTimers.current.clear();
      detailRetryAttempts.current.clear();
    },
    [settings],
  );

  const scheduleOutboxRetry = useCallback((attempt: number, drain: () => void) => {
    if (outboxRetryTimer.current !== undefined) return;
    const delays = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
    const base = delays[Math.min(Math.max(0, attempt - 1), delays.length - 1)] ?? 30_000;
    const wait = Math.round(base * (0.8 + Math.random() * 0.4));
    outboxRetryTimer.current = window.setTimeout(() => {
      outboxRetryTimer.current = undefined;
      drain();
    }, wait);
  }, []);

  const drainReliableOutbox = useCallback((): Promise<void> => {
    if (outboxDrain.current) return outboxDrain.current;
    const request = (async () => {
      const messages = await listOutboxMessages(settings);
      for (const message of messages) {
        try {
          await api.enqueue(message.threadId, {
            input: message.input,
            ...(message.images.length ? { images: message.images } : {}),
            ...(message.goal ? { goal: true } : {}),
            clientMessageId: message.id,
          });
          await deleteOutboxMessage(message.id);
        } catch (error) {
          const next: OutboxMessage = {
            ...message,
            attempts: message.attempts + 1,
            lastError: error instanceof Error ? error.message : "Delivery failed",
          };
          await putOutboxMessage(next);
          if (isRetryableApiError(error)) {
            scheduleOutboxRetry(next.attempts, () => void drainReliableOutbox());
            break;
          }
        }
      }
    })().finally(() => {
      if (outboxDrain.current === request) outboxDrain.current = null;
    });
    outboxDrain.current = request;
    return request;
  }, [api, scheduleOutboxRetry, settings]);

  const sendReliable = useCallback(
    async (
      threadId: string,
      body: QueueMessageRequest & { clientMessageId: string },
    ): Promise<"delivered" | "pending"> => {
      const message: OutboxMessage = {
        id: body.clientMessageId,
        connectionKey: connectionCacheKey(settings),
        threadId,
        input: body.input,
        images: body.images ?? [],
        goal: body.goal ?? false,
        createdAt: Date.now(),
        attempts: 0,
        lastError: null,
      };
      await putOutboxMessage(message);
      try {
        await api.enqueue(threadId, body);
        await deleteOutboxMessage(message.id);
        return "delivered";
      } catch (error) {
        if (!isRetryableApiError(error)) {
          await deleteOutboxMessage(message.id);
          throw error;
        }
        const retryPersisted = await putOutboxMessage({
          ...message,
          attempts: 1,
          lastError: error instanceof Error ? error.message : "Delivery failed",
        });
        if (!retryPersisted) throw error;
        scheduleOutboxRetry(1, () => void drainReliableOutbox());
        return "pending";
      }
    },
    [api, drainReliableOutbox, scheduleOutboxRetry, settings],
  );

  const uploadVoiceRecording = useCallback(
    async (recording: PendingVoiceRecording): Promise<void> => {
      const savedDraft = await api.updateThreadDraft(recording.threadId, recording.draft, {
        retry: false,
      });
      await confirmLocalDraft(
        settings,
        recording.threadId,
        savedDraft,
        recording.localDraftUpdatedAt,
      );
      const accepted = await api.createVoiceTranscription(recording.threadId, recording.audio, {
        recordingDurationMs: recording.durationMs,
        mode: recording.mode,
        selectionStart: recording.selectionStart,
        selectionEnd: recording.selectionEnd,
        draftUpdatedAt: savedDraft?.updatedAt ?? null,
        clientUploadId: recording.id,
      });
      await deletePendingVoiceRecording(recording.id);
      if (accepted) dispatch({ type: "voice.accepted", job: accepted });
    },
    [api, settings],
  );

  const scheduleVoiceRetry = useCallback((attempt: number, drain: () => void) => {
    if (voiceRetryTimer.current !== undefined) return;
    const delays = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
    const base = delays[Math.min(Math.max(0, attempt - 1), delays.length - 1)] ?? 30_000;
    voiceRetryTimer.current = window.setTimeout(
      () => {
        voiceRetryTimer.current = undefined;
        drain();
      },
      Math.round(base * (0.8 + Math.random() * 0.4)),
    );
  }, []);

  const drainVoiceRecordings = useCallback((): Promise<void> => {
    if (voiceDrain.current) return voiceDrain.current;
    const request = (async () => {
      const recordings = await listPendingVoiceRecordings(settings);
      for (const recording of recordings) {
        try {
          await uploadVoiceRecording(recording);
        } catch (error) {
          const next: PendingVoiceRecording = {
            ...recording,
            attempts: recording.attempts + 1,
            lastError: error instanceof Error ? error.message : "Voice upload failed",
          };
          await putPendingVoiceRecording(next);
          if (isRetryableApiError(error)) {
            scheduleVoiceRetry(next.attempts, () => void drainVoiceRecordings());
            break;
          }
        }
      }
    })().finally(() => {
      if (voiceDrain.current === request) voiceDrain.current = null;
    });
    voiceDrain.current = request;
    return request;
  }, [scheduleVoiceRetry, settings, uploadVoiceRecording]);

  const queueVoiceRecording = useCallback(
    async (
      input: Omit<
        PendingVoiceRecording,
        "connectionKey" | "createdAt" | "attempts" | "lastError" | "localDraftUpdatedAt"
      >,
    ): Promise<"accepted" | "pending"> => {
      const localDraftUpdatedAt = Date.now();
      const recording: PendingVoiceRecording = {
        ...input,
        connectionKey: connectionCacheKey(settings),
        localDraftUpdatedAt,
        createdAt: Date.now(),
        attempts: 0,
        lastError: null,
      };
      await putPendingVoiceRecording(recording);
      await saveLocalDraft(settings, recording.threadId, recording.draft, localDraftUpdatedAt);
      try {
        await uploadVoiceRecording(recording);
        return "accepted";
      } catch (error) {
        if (!isRetryableApiError(error)) throw error;
        const retryPersisted = await putPendingVoiceRecording({
          ...recording,
          attempts: 1,
          lastError: error instanceof Error ? error.message : "Voice upload failed",
        });
        if (!retryPersisted) throw error;
        scheduleVoiceRetry(1, () => void drainVoiceRecordings());
        return "pending";
      }
    },
    [drainVoiceRecordings, scheduleVoiceRetry, settings, uploadVoiceRecording],
  );

  useEffect(() => {
    const wake = () => {
      void drainReliableOutbox();
      void drainVoiceRecordings();
    };
    window.addEventListener("online", wake);
    wake();
    return () => {
      window.removeEventListener("online", wake);
      if (outboxRetryTimer.current !== undefined) {
        window.clearTimeout(outboxRetryTimer.current);
        outboxRetryTimer.current = undefined;
      }
      if (voiceRetryTimer.current !== undefined) {
        window.clearTimeout(voiceRetryTimer.current);
        voiceRetryTimer.current = undefined;
      }
    };
  }, [drainReliableOutbox, drainVoiceRecordings]);

  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | undefined;
    let retryTimer: number | undefined;
    let heartbeatTimer: number | undefined;
    let heartbeatTimeout: number | undefined;
    let retry = 0;
    const delays = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

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
          void drainReliableOutbox();
          void drainVoiceRecordings();
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
        const baseDelay = delays[Math.min(retry, delays.length - 1)] ?? 30_000;
        const delay = Math.round(baseDelay * (0.8 + Math.random() * 0.4));
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
  }, [
    api,
    browserNotifications,
    drainReliableOutbox,
    drainVoiceRecordings,
    generation,
    settings.token,
  ]);

  useEffect(() => {
    const refresh = () => {
      if (foregroundRefresh.current) return;
      const targetGeneration = reconnect();
      void drainReliableOutbox();
      void drainVoiceRecordings();
      const request = api
        .sync()
        .then((snapshot) => acceptSyncedSnapshot(snapshot, targetGeneration))
        .catch(() => undefined)
        .finally(() => {
          if (foregroundRefresh.current === request) foregroundRefresh.current = null;
        });
      foregroundRefresh.current = request;
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
  }, [acceptSyncedSnapshot, api, drainReliableOutbox, drainVoiceRecordings, reconnect]);

  const value = useMemo(
    () => ({
      api,
      state,
      dispatch,
      refreshDetail,
      loadOlderDetail,
      sendReliable,
      queueVoiceRecording,
      reconnect,
    }),
    [api, state, refreshDetail, loadOlderDetail, sendReliable, queueVoiceRecording, reconnect],
  );
  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnection(): ConnectionContextValue {
  const value = useContext(ConnectionContext);
  if (!value) throw new Error("useConnection must be used inside ConnectionProvider");
  return value;
}

function threadDetailNeedsRecovery(detail: ThreadDetail, summary: ThreadSummary): boolean {
  const currentTurn = summary.currentTurnId
    ? detail.turns.find((turn) => turn.id === summary.currentTurnId)
    : null;
  if (summary.currentTurnId && (!currentTurn || currentTurn.status !== "inProgress")) return true;
  if (!summary.currentTurnId && detail.turns.some((turn) => turn.status === "inProgress")) {
    return true;
  }
  if (
    summary.relation.kind !== "session" ||
    summary.state !== "completed" ||
    !detail.turns.length
  ) {
    return false;
  }
  const latestTurn = detail.turns.at(-1)!;
  const latestKnownAt = Math.max(
    latestTurn.completedAt ?? latestTurn.startedAt ?? 0,
    ...latestTurn.items.map((item) => ("timestamp" in item ? (item.timestamp ?? 0) : 0)),
  );
  if (latestKnownAt > 0 && summary.updatedAt - latestKnownAt > 5_000) return true;
  const hasFinalAnswer = latestTurn.items.some(
    (item) =>
      item.type === "agentMessage" &&
      item.phase === "final_answer" &&
      Boolean(item.text.trim() || item.images.length),
  );
  const hasPlan = latestTurn.items.some(
    (item) => item.type === "plan" && item.status === "completed",
  );
  return !hasFinalAnswer && !hasPlan;
}
