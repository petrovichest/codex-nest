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
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  isServerFrame,
  SYNC_PROTOCOL_VERSION,
  type AppSnapshot,
  type QueueMessageRequest,
  type ServerEvent,
  type ThreadDetail,
  type ThreadSummary,
} from "@codexnest/protocol";

import { ApiClient, isRetryableApiError } from "./api";
import { BrowserNotificationTracker } from "./browser-notifications";
import { translate, useI18n } from "./i18n";
import {
  observeNativeNotificationEvent,
  observeNativeNotificationSnapshot,
  setNativeNotificationAppActive,
} from "./push";
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
  saveCachedThread,
  replaceCachedProjection,
  saveLocalDraft,
  type OutboxMessage,
  type PendingVoiceRecording,
} from "./offline-store";
import {
  createClientStore,
  initialState,
  isValidProjectionSnapshot,
  mergeThreadDetailChanges,
  projectionCursor,
  type ClientAction,
  type ClientStore,
  type ClientState,
} from "./state";
import type { ConnectionSettings } from "./storage";

const HEARTBEAT_IDLE_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const PROJECTION_CACHE_THROTTLE_MS = 250;
const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000] as const;
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

type VoiceRecordingUpload = Omit<
  PendingVoiceRecording,
  "connectionKey" | "createdAt" | "attempts" | "lastError"
>;

interface ConnectionContextValue {
  api: ApiClient;
  state: ClientState;
  dispatch: Dispatch<ClientAction>;
  refreshDetail(threadId: string, options?: DetailReadOptions): Promise<ThreadDetail>;
  forceRefreshDetail(threadId: string): Promise<ThreadDetail>;
  loadOlderDetail(threadId: string, cursor: string): Promise<ThreadDetail>;
  loadTurnItems(threadId: string, turnId: string): Promise<void>;
  sendReliable(
    threadId: string,
    body: QueueMessageRequest & { clientMessageId: string },
  ): Promise<"delivered" | "pending">;
  queueVoiceRecording(recording: Omit<VoiceRecordingUpload, "localDraftUpdatedAt">): Promise<void>;
  reconnect(): number;
}

type ConnectionServices = Omit<ConnectionContextValue, "state"> & { store: ClientStore };

const ConnectionContext = createContext<ConnectionServices | null>(null);

export function ConnectionProvider({
  settings,
  children,
}: PropsWithChildren<{ settings: ConnectionSettings }>) {
  const { language } = useI18n();
  const api = useMemo(() => new ApiClient(settings), [settings]);
  const [store] = useState(() => createClientStore(initialState));
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const dispatch = store.dispatch;
  const stateRef = useRef(state);
  const languageRef = useRef(language);
  const [generation, setGeneration] = useState(0);
  const [cacheReady, setCacheReady] = useState(false);
  const generationRef = useRef(0);
  const streamRevision = useRef<number | null>(null);
  const streamEpoch = useRef<string | null>(null);
  const appliedRevision = useRef<number | null>(null);
  const syncedSnapshotFloor = useRef<{ generation: number; revision: number } | null>(null);
  const detailRequests = useRef(new Map<string, Promise<ThreadDetail>>());
  const detailRequestVersions = useRef(new Map<string, number>());
  const turnItemRequests = useRef(new Map<string, Promise<void>>());
  const detailReader = useRef<DetailReader | null>(null);
  const detailRetryAttempts = useRef(new Map<string, number>());
  const detailRetryTimers = useRef(new Map<string, number>());
  const persistedDetails = useRef<Record<string, ThreadDetail>>({});
  const detailPersistTimers = useRef(new Map<string, number>());
  const persistenceConnectionKey = useRef(connectionCacheKey(settings));
  const foregroundRefreshTimer = useRef<number | undefined>(undefined);
  const outboxDrain = useRef<Promise<void> | null>(null);
  const outboxRetryTimer = useRef<number | undefined>(undefined);
  const forceSnapshot = useRef(false);
  const awaitingThreadProjection = useRef<string | null>(null);
  const projectionPersistTimer = useRef<number | undefined>(undefined);
  const projectionPersistedAt = useRef(0);
  const pendingProjection = useRef<{
    snapshot: AppSnapshot;
    activeThreadId: string | null;
    activeThread: ThreadDetail | null;
    goals: ClientState["goals"];
  } | null>(null);
  const projectionWriteQueue = useRef<Promise<unknown>>(Promise.resolve());
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
    setCacheReady(false);
    api.setProjectionCursor(null);
    void loadCachedMeta(settings)
      .then((cached) => {
        if (!active) return;
        if (cached) dispatch({ type: "hydrate", snapshot: cached.snapshot, goals: cached.goals });
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setCacheReady(true);
      });
    void listOutboxMessages(settings)
      .then((outbox) => {
        if (!active) return;
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
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api, settings]);

  useEffect(() => {
    if (
      state.syncStatus !== "synced" ||
      !state.snapshot ||
      !isValidProjectionSnapshot(state.snapshot)
    ) {
      return;
    }
    const activeThreadId = currentRouteThreadId();
    if (activeThreadId && awaitingThreadProjection.current === activeThreadId) return;
    pendingProjection.current = {
      snapshot: state.snapshot,
      activeThreadId,
      activeThread: activeThreadId ? (state.details[activeThreadId] ?? null) : null,
      goals: state.goals,
    };
    if (projectionPersistTimer.current !== undefined) return;
    const elapsed = Date.now() - projectionPersistedAt.current;
    const wait = Math.max(0, PROJECTION_CACHE_THROTTLE_MS - elapsed);
    projectionPersistTimer.current = window.setTimeout(() => {
      projectionPersistTimer.current = undefined;
      const pending = pendingProjection.current;
      pendingProjection.current = null;
      if (!pending) return;
      projectionPersistedAt.current = Date.now();
      projectionWriteQueue.current = projectionWriteQueue.current.then(() =>
        replaceCachedProjection(
          settings,
          pending.snapshot,
          pending.activeThread,
          pending.goals,
          pending.activeThreadId,
        ),
      );
    }, wait);
  }, [settings, state.details, state.goals, state.snapshot, state.syncStatus]);

  useEffect(
    () => () => {
      if (projectionPersistTimer.current !== undefined) {
        window.clearTimeout(projectionPersistTimer.current);
        projectionPersistTimer.current = undefined;
      }
      pendingProjection.current = null;
    },
    [settings],
  );

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
    api.setProjectionCursor(null);
    dispatch({ type: "network", network: "connecting" });
    const next = generationRef.current + 1;
    generationRef.current = next;
    setGeneration(next);
    return next;
  }, [api, dispatch]);
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
      const targetGeneration = generationRef.current;
      const targetRevision = appliedRevision.current;
      const canApply = () =>
        detailRequestVersions.current.get(key) === version &&
        generationRef.current === targetGeneration;
      const liveAdvanced = () => appliedRevision.current !== targetRevision;
      const request = (async () => {
        const authoritativeLatest = async (): Promise<ThreadDetail> => {
          const detail = await api.readThread(threadId, undefined, { fresh: true });
          if (canApply()) {
            dispatch({
              type: "detail",
              detail,
              page: "reset",
              preserveLive: liveAdvanced(),
            });
          }
          return detail;
        };
        try {
          let detail: ThreadDetail;
          let baseline = stateRef.current.details[threadId];
          if (!cursor && !baseline) {
            const cached = await loadCachedThread(settings, threadId);
            if (cached && canApply()) {
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
                if (canApply()) {
                  dispatch({
                    type: "changes",
                    threadId,
                    changes,
                    preserveLive: liveAdvanced(),
                  });
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
            if (canApply()) {
              dispatch({
                type: "detail",
                detail,
                page: cursor ? "older" : "latest",
                preserveLive: liveAdvanced(),
              });
            }
          }
          if (!cursor && canApply()) {
            const summary =
              stateRef.current.snapshot?.threads.find((thread) => thread.id === threadId) ??
              detail.summary;
            if (liveAdvanced()) clearDetailRetry(threadId);
            else if (threadDetailNeedsRecovery(detail, summary)) scheduleDetailRetry(threadId);
            else clearDetailRetry(threadId);
          }
          return detail;
        } catch (error) {
          if (!cursor && canApply() && isRetryableApiError(error)) scheduleDetailRetry(threadId);
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
  const forceRefreshDetail = useCallback(
    async (threadId: string): Promise<ThreadDetail> => {
      const targetGeneration = generationRef.current;
      const targetRevision = appliedRevision.current;
      const { detail } = await api.refreshThread(threadId);
      const liveAdvanced = appliedRevision.current !== targetRevision;
      if (generationRef.current === targetGeneration) {
        dispatch({
          type: "detail",
          detail,
          page: "reset",
          preserveLive: liveAdvanced,
        });
      }
      return detail;
    },
    [api],
  );
  const loadOlderDetail = useCallback(
    (threadId: string, cursor: string) => readDetail(threadId, cursor),
    [readDetail],
  );
  const loadTurnItems = useCallback(
    (threadId: string, turnId: string): Promise<void> => {
      const key = `${threadId}:${turnId}`;
      const current = turnItemRequests.current.get(key);
      if (current) return current;
      const targetGeneration = generationRef.current;
      const request = api
        .readTurnItems(threadId, turnId)
        .then((response) => {
          if (generationRef.current !== targetGeneration) return;
          dispatch({ type: "turn.items", threadId, turnId, items: response.items });
        })
        .finally(() => {
          if (turnItemRequests.current.get(key) === request) turnItemRequests.current.delete(key);
        });
      turnItemRequests.current.set(key, request);
      return request;
    },
    [api],
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
    if (store.getSnapshot().syncStatus !== "synced" || !api.commandsReady) {
      return Promise.resolve();
    }
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
          if (isRetryableApiError(error)) {
            await putOutboxMessage(next);
            scheduleOutboxRetry(next.attempts, () => void drainReliableOutbox());
            break;
          }
          await deleteOutboxMessage(message.id);
          dispatch({
            type: "optimistic.remove",
            threadId: message.threadId,
            messageId: message.id,
          });
        }
      }
    })().finally(() => {
      if (outboxDrain.current === request) outboxDrain.current = null;
    });
    outboxDrain.current = request;
    return request;
  }, [api, scheduleOutboxRetry, settings, store]);

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
      if (!(await putOutboxMessage(message))) {
        throw new Error("Не удалось сохранить сообщение для повторной отправки");
      }
      if (store.getSnapshot().syncStatus !== "synced" || !api.commandsReady) return "pending";
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
    [api, drainReliableOutbox, scheduleOutboxRetry, settings, store],
  );

  const uploadVoiceRecording = useCallback(
    async (recording: VoiceRecordingUpload): Promise<void> => {
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
      if (accepted) dispatch({ type: "voice.accepted", job: accepted });
    },
    [api, settings],
  );

  const queueVoiceRecording = useCallback(
    async (input: Omit<VoiceRecordingUpload, "localDraftUpdatedAt">): Promise<void> => {
      const localDraftUpdatedAt = Date.now();
      const recording: VoiceRecordingUpload = {
        ...input,
        localDraftUpdatedAt,
      };
      await saveLocalDraft(settings, recording.threadId, recording.draft, localDraftUpdatedAt);
      await uploadVoiceRecording(recording);
    },
    [settings, uploadVoiceRecording],
  );

  useEffect(() => {
    const wake = () => {
      void drainReliableOutbox();
    };
    window.addEventListener("online", wake);
    wake();
    return () => {
      window.removeEventListener("online", wake);
      if (outboxRetryTimer.current !== undefined) {
        window.clearTimeout(outboxRetryTimer.current);
        outboxRetryTimer.current = undefined;
      }
    };
  }, [drainReliableOutbox]);

  useEffect(() => {
    void listPendingVoiceRecordings(settings)
      .then((recordings) =>
        Promise.all(recordings.map((recording) => deletePendingVoiceRecording(recording.id))),
      )
      .catch(() => undefined);
  }, [settings]);

  useEffect(() => {
    if (!cacheReady) return;
    let stopped = false;
    let socket: WebSocket | undefined;
    let retryTimer: number | undefined;
    let heartbeatTimer: number | undefined;
    let heartbeatTimeout: number | undefined;
    let retry = 0;
    let fatalError: string | null = null;

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

    const requireSnapshot = (candidate: WebSocket) => {
      forceSnapshot.current = true;
      api.setProjectionCursor(null);
      candidate.close();
    };

    const observeProjectionEvent = (revision: number, epoch: string, event: ServerEvent) => {
      if (event.type === "projection.replaced") {
        const snapshot = { ...event.snapshot, epoch, revision };
        browserNotifications?.acceptSnapshot(snapshot);
        observeNativeNotificationSnapshot(snapshot);
        return;
      }
      browserNotifications?.acceptEvent(event);
      observeNativeNotificationEvent(revision, event);
    };

    const connect = () => {
      if (stopped) return;
      api.setProjectionCursor(null);
      dispatch({ type: "network", network: "connecting" });
      const candidate = new WebSocket(api.webSocketUrl());
      socket = candidate;
      candidate.addEventListener("open", () => {
        if (stopped || socket !== candidate) return;
        const cached = store.getSnapshot().snapshot;
        const threadId = currentRouteThreadId();
        awaitingThreadProjection.current = threadId;
        const cursor =
          !forceSnapshot.current && cached?.projectionStatus === "ready"
            ? projectionCursor(cached)
            : null;
        candidate.send(
          JSON.stringify({
            type: "authenticate",
            protocolVersion: SYNC_PROTOCOL_VERSION,
            token: settings.token,
            cursor,
            threadId,
          }),
        );
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
        if (frame.type === "snapshot" || frame.type === "resync") {
          if (!isValidProjectionSnapshot(frame.snapshot)) {
            requireSnapshot(candidate);
            return;
          }
          const current = store.getSnapshot().snapshot;
          if (
            current?.epoch === frame.snapshot.epoch &&
            appliedRevision.current !== null &&
            frame.snapshot.revision < appliedRevision.current
          ) {
            requireSnapshot(candidate);
            return;
          }
          forceSnapshot.current = false;
          awaitingThreadProjection.current = currentRouteThreadId();
          streamEpoch.current = frame.snapshot.epoch;
          streamRevision.current = frame.snapshot.revision;
          const floor = syncedSnapshotFloor.current;
          if (floor?.generation === generation && frame.snapshot.revision < floor.revision) {
            return;
          }
          if (floor?.generation === generation) syncedSnapshotFloor.current = null;
          appliedRevision.current = frame.snapshot.revision;
          browserNotifications?.acceptSnapshot(frame.snapshot);
          observeNativeNotificationSnapshot(frame.snapshot);
          dispatch({
            type: frame.type === "resync" ? "resync" : "sync",
            snapshot: frame.snapshot,
          });
          api.setProjectionCursor(
            frame.snapshot.projectionStatus === "ready" ? projectionCursor(frame.snapshot) : null,
          );
          if (frame.snapshot.projectionStatus === "ready") {
            retry = 0;
            void drainReliableOutbox();
          }
        } else if (frame.type === "replay") {
          const localState = store.getSnapshot();
          const local = localState.snapshot;
          if (
            !local ||
            !isValidProjectionSnapshot(local) ||
            local.projectionStatus !== "ready" ||
            local.epoch !== frame.epoch ||
            local.revision !== frame.fromRevision ||
            !Number.isSafeInteger(frame.fromRevision) ||
            !Number.isSafeInteger(frame.toRevision) ||
            frame.fromRevision < 0 ||
            frame.patches.some(
              (patch, index) =>
                !Number.isSafeInteger(patch.revision) ||
                patch.revision !== frame.fromRevision + index + 1,
            ) ||
            frame.toRevision !== frame.fromRevision + frame.patches.length
          ) {
            requireSnapshot(candidate);
            return;
          }
          forceSnapshot.current = false;
          awaitingThreadProjection.current = currentRouteThreadId();
          streamEpoch.current = frame.epoch;
          streamRevision.current = frame.toRevision;
          appliedRevision.current = frame.toRevision;
          dispatch({
            type: "replay",
            epoch: frame.epoch,
            fromRevision: frame.fromRevision,
            toRevision: frame.toRevision,
            patches: frame.patches,
          });
          for (const patch of frame.patches) {
            observeProjectionEvent(patch.revision, frame.epoch, patch.event);
          }
          const replayed = store.getSnapshot();
          if (replayed.syncStatus === "synced") {
            retry = 0;
            api.setProjectionCursor(projectionCursor(replayed.snapshot));
            void drainReliableOutbox();
          } else {
            requireSnapshot(candidate);
          }
        } else if (frame.type === "patch") {
          if (
            !Number.isSafeInteger(frame.revision) ||
            frame.revision < 0 ||
            streamEpoch.current !== frame.epoch ||
            streamRevision.current === null ||
            frame.revision !== streamRevision.current + 1
          ) {
            requireSnapshot(candidate);
            return;
          }
          streamRevision.current = frame.revision;
          if (appliedRevision.current !== null && frame.revision <= appliedRevision.current) {
            const floor = syncedSnapshotFloor.current;
            if (floor?.generation === generation && frame.revision >= floor.revision) {
              syncedSnapshotFloor.current = null;
              const current = store.getSnapshot().snapshot;
              if (
                current?.epoch === frame.epoch &&
                current.revision === frame.revision &&
                current.projectionStatus === "ready"
              ) {
                retry = 0;
                dispatch({ type: "synced" });
                api.setProjectionCursor(projectionCursor(current));
                void drainReliableOutbox();
              }
            }
            return;
          }
          const current = store.getSnapshot().snapshot;
          if (
            !current ||
            current.epoch !== frame.epoch ||
            current.revision + 1 !== frame.revision
          ) {
            requireSnapshot(candidate);
            return;
          }
          appliedRevision.current = frame.revision;
          if (syncedSnapshotFloor.current?.generation === generation) {
            syncedSnapshotFloor.current = null;
          }
          observeProjectionEvent(frame.revision, frame.epoch, frame.event);
          dispatch({
            type: "event",
            epoch: frame.epoch,
            revision: frame.revision,
            event: frame.event,
          });
          const updated = store.getSnapshot();
          if (updated.snapshot?.projectionStatus === "ready") {
            retry = 0;
            api.setProjectionCursor({ epoch: frame.epoch, revision: frame.revision });
            void drainReliableOutbox();
          } else {
            api.setProjectionCursor(null);
          }
        } else if (frame.type === "thread.open") {
          if (awaitingThreadProjection.current === frame.threadId) {
            awaitingThreadProjection.current = null;
          }
          const detailKey = JSON.stringify([frame.threadId, null]);
          detailRequestVersions.current.set(
            detailKey,
            (detailRequestVersions.current.get(detailKey) ?? 0) + 1,
          );
          dispatch({
            type: "thread.open",
            threadId: frame.threadId,
            detail: frame.detail,
          });
        } else if (frame.type === "error") {
          if (frame.error.code === "client_update_required") fatalError = frame.error.message;
          dispatch({ type: "network", network: "offline", error: frame.error.message });
          api.setProjectionCursor(null);
          candidate.close();
        }
      });
      candidate.addEventListener("close", () => {
        if (stopped || socket !== candidate) return;
        socket = undefined;
        clearHeartbeat();
        streamRevision.current = null;
        streamEpoch.current = null;
        api.setProjectionCursor(null);
        if (fatalError) {
          dispatch({ type: "network", network: "offline", error: fatalError });
          return;
        }
        dispatch({
          type: "network",
          network: "offline",
          error: translate(languageRef.current, "Связь с сервером потеряна"),
        });
        const delay = reconnectDelay(retry);
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
      streamRevision.current = null;
      streamEpoch.current = null;
      api.setProjectionCursor(null);
      socket?.close();
    };
  }, [
    api,
    browserNotifications,
    cacheReady,
    dispatch,
    drainReliableOutbox,
    generation,
    settings,
    store,
  ]);

  useEffect(() => {
    const refresh = () => {
      if (foregroundRefreshTimer.current !== undefined) return;
      reconnect();
      void drainReliableOutbox().catch(() => undefined);
      foregroundRefreshTimer.current = window.setTimeout(() => {
        foregroundRefreshTimer.current = undefined;
      }, 250);
    };
    const foreground = () => {
      if (document.visibilityState === "visible") refresh();
    };
    let removeNativeListener: (() => Promise<void>) | undefined;
    if (Capacitor.isNativePlatform()) {
      setNativeNotificationAppActive(true);
      void CapacitorApp.addListener("appStateChange", ({ isActive }) => {
        setNativeNotificationAppActive(isActive);
        if (isActive) refresh();
      }).then((handle) => {
        removeNativeListener = () => handle.remove();
      });
    } else {
      document.addEventListener("visibilitychange", foreground);
    }
    window.addEventListener("online", refresh);
    return () => {
      document.removeEventListener("visibilitychange", foreground);
      window.removeEventListener("online", refresh);
      if (foregroundRefreshTimer.current !== undefined) {
        window.clearTimeout(foregroundRefreshTimer.current);
        foregroundRefreshTimer.current = undefined;
      }
      setNativeNotificationAppActive(true);
      void removeNativeListener?.();
    };
  }, [drainReliableOutbox, reconnect]);

  const value = useMemo(
    () => ({
      api,
      dispatch,
      store,
      refreshDetail,
      forceRefreshDetail,
      loadOlderDetail,
      loadTurnItems,
      sendReliable,
      queueVoiceRecording,
      reconnect,
    }),
    [
      api,
      dispatch,
      store,
      refreshDetail,
      forceRefreshDetail,
      loadOlderDetail,
      loadTurnItems,
      sendReliable,
      queueVoiceRecording,
      reconnect,
    ],
  );
  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

function currentRouteThreadId(): string | null {
  const match = /^\/threads\/([^/]+)\/?$/u.exec(window.location.pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function useConnection(): ConnectionContextValue {
  const services = useContext(ConnectionContext);
  if (!services) throw new Error("useConnection must be used inside ConnectionProvider");
  const state = useSyncExternalStore(
    services.store.subscribe,
    services.store.getSnapshot,
    services.store.getSnapshot,
  );
  return useMemo(() => ({ ...services, state }), [services, state]);
}

export function useConnectionServices(): ConnectionServices {
  const services = useContext(ConnectionContext);
  if (!services) throw new Error("useConnectionServices must be used inside ConnectionProvider");
  return services;
}

export function useConnectionSelector<T>(
  selector: (state: ClientState) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
): T {
  const services = useContext(ConnectionContext);
  if (!services) throw new Error("useConnectionSelector must be used inside ConnectionProvider");
  const selectorRef = useRef(selector);
  const isEqualRef = useRef(isEqual);
  const cached = useRef<{
    state: ClientState;
    selector: (state: ClientState) => T;
    selection: T;
  } | null>(null);
  selectorRef.current = selector;
  isEqualRef.current = isEqual;
  const getSelection = useCallback(() => {
    const state = services.store.getSnapshot();
    const current = cached.current;
    if (current?.state === state && current.selector === selectorRef.current) {
      return current.selection;
    }
    const selection = selectorRef.current(state);
    if (current && isEqualRef.current(current.selection, selection)) {
      cached.current = { state, selector: selectorRef.current, selection: current.selection };
      return current.selection;
    }
    cached.current = { state, selector: selectorRef.current, selection };
    return selection;
  }, [services.store]);
  return useSyncExternalStore(services.store.subscribe, getSelection, getSelection);
}

export function reconnectDelay(attempt: number, random = Math.random): number {
  const base =
    RECONNECT_DELAYS_MS[
      Math.min(Math.max(0, Math.trunc(attempt)), RECONNECT_DELAYS_MS.length - 1)
    ] ?? 5_000;
  return Math.round(base * (0.8 + random() * 0.4));
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
