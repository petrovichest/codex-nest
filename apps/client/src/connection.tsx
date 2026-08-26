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
  type ServerEvent,
  type ThreadDetail,
  type ThreadSummary,
  type UpdateUserInputDraftRequest,
} from "@codexnest/protocol";

import { ApiClient, ApiClientError, isRetryableApiError } from "./api";
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
  loadPendingVoiceRecording,
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

type VoiceRecordingUpload = Omit<
  PendingVoiceRecording,
  "connectionKey" | "createdAt" | "attempts" | "lastError"
>;

type VoiceRecordingRecovery = Pick<
  PendingVoiceRecording,
  "threadId" | "mode" | "draft" | "draftUpdatedAt"
>;

type UserInputDraftPersistence = {
  draft: UpdateUserInputDraftRequest;
  version: number;
  savedVersion: number;
  inFlight: boolean;
  pending: boolean;
  timer: number | undefined;
};

interface ConnectionContextValue {
  api: ApiClient;
  state: ClientState;
  appActive: boolean;
  foregroundEpoch: number;
  streamRecoveryEpoch: number;
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
  pendingVoiceRecordingThreadIds: readonly string[];
  pendingVoiceRecordingErrors: Readonly<Record<string, string>>;
  retryPendingVoiceRecording(recording: VoiceRecordingRecovery): Promise<void>;
  updateUserInputDraft(
    attentionId: string,
    draft: UpdateUserInputDraftRequest,
    timing: "immediate" | "debounced",
  ): void;
  flushUserInputDraft(attentionId: string): void;
  clearUserInputDraft(attentionId: string): void;
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
  const [foregroundEpoch, setForegroundEpoch] = useState(0);
  const [streamRecoveryEpoch, setStreamRecoveryEpoch] = useState(0);
  const [pendingVoiceRecordingThreadIds, setPendingVoiceRecordingThreadIds] = useState<string[]>(
    [],
  );
  const [pendingVoiceRecordingErrors, setPendingVoiceRecordingErrors] = useState<
    Record<string, string>
  >({});
  const [appActive, setAppActive] = useState(() => document.visibilityState === "visible");
  const generationRef = useRef(0);
  const streamSequence = useRef<number | null>(null);
  const receivedStreamSnapshot = useRef(false);
  const appliedSequence = useRef<number | null>(null);
  const appliedThreadSequences = useRef(new Map<string, number>());
  const syncedSnapshotFloor = useRef<{ generation: number; sequence: number } | null>(null);
  const detailRequests = useRef(new Map<string, Promise<ThreadDetail>>());
  const detailRequestVersions = useRef(new Map<string, number>());
  const turnItemRequests = useRef(new Map<string, Promise<void>>());
  const detailReader = useRef<DetailReader | null>(null);
  const detailRetryAttempts = useRef(new Map<string, number>());
  const detailRetryTimers = useRef(new Map<string, number>());
  const persistedDetails = useRef<Record<string, ThreadDetail>>({});
  const detailPersistTimers = useRef(new Map<string, number>());
  const persistenceConnectionKey = useRef(connectionCacheKey(settings));
  const foregroundRefresh = useRef<Promise<void> | null>(null);
  const outboxDrain = useRef<Promise<void> | null>(null);
  const outboxRetryTimer = useRef<number | undefined>(undefined);
  const recoveredVoiceRecordingIds = useRef(new Set<string>());
  const pendingVoiceRecordings = useRef(
    new Map<string, Pick<PendingVoiceRecording, "threadId" | "lastError">>(),
  );
  const voiceRecoveryDrain = useRef<Promise<void> | null>(null);
  const voiceRecoveryRetryTimer = useRef<number | undefined>(undefined);
  const userInputDraftPersistence = useRef(new Map<string, UserInputDraftPersistence>());
  const browserNotifications = useMemo(
    () => (Capacitor.isNativePlatform() ? null : new BrowserNotificationTracker()),
    [],
  );

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    const active = new Map(
      (state.snapshot?.attention ?? [])
        .filter((request) => request.kind === "userInput")
        .map((request) => [request.id, request] as const),
    );
    for (const [attentionId, draft] of Object.entries(state.userInputDrafts)) {
      const entry = userInputDraftPersistence.current.get(attentionId);
      if (entry && (entry.inFlight || entry.version > entry.savedVersion)) continue;
      userInputDraftPersistence.current.set(attentionId, {
        draft: {
          answers: cloneUserInputAnswers(draft.answers),
          currentQuestionId: draft.currentQuestionId,
        },
        version: draft.localVersion,
        savedVersion: draft.savedVersion,
        inFlight: false,
        pending: false,
        timer: entry?.timer,
      });
    }
    for (const [attentionId, entry] of userInputDraftPersistence.current) {
      if (state.userInputDrafts[attentionId]) continue;
      if (!state.snapshot) continue;
      const request = active.get(attentionId);
      if (request && request.draft === undefined) continue;
      if (entry.timer !== undefined) window.clearTimeout(entry.timer);
      userInputDraftPersistence.current.delete(attentionId);
    }
  }, [state.snapshot?.attention, state.userInputDrafts]);

  useEffect(() => {
    languageRef.current = language;
    browserNotifications?.setLanguage(language);
  }, [browserNotifications, language]);

  useEffect(() => {
    let active = true;
    const targetGeneration = generationRef.current;
    void Promise.all([loadCachedMeta(settings), listOutboxMessages(settings)]).then(
      ([cached, outbox]) => {
        if (!active) return;
        if (
          cached &&
          generationRef.current === targetGeneration &&
          appliedSequence.current === null
        ) {
          dispatch({ type: "hydrate", snapshot: cached.snapshot, goals: cached.goals });
        }
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
    detailRequests.current.clear();
    turnItemRequests.current.clear();
    setGeneration(next);
    return next;
  }, []);
  const acceptSyncedSnapshot = useCallback(
    (snapshot: AppSnapshot, targetGeneration: number): boolean => {
      if (generationRef.current !== targetGeneration) return false;
      if (appliedSequence.current !== null && snapshot.sequence < appliedSequence.current) {
        return false;
      }
      appliedSequence.current = snapshot.sequence;
      appliedThreadSequences.current = new Map(
        snapshot.threads.map((thread) => [thread.id, snapshot.sequence]),
      );
      syncedSnapshotFloor.current = {
        generation: targetGeneration,
        sequence: snapshot.sequence,
      };
      browserNotifications?.acceptSnapshot(snapshot);
      observeNativeNotificationSnapshot(snapshot);
      dispatch({ type: "snapshot", snapshot });
      return true;
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
      const versionKey = JSON.stringify([threadId, cursor ?? null]);
      const authoritativeKey = JSON.stringify([threadId, cursor ?? null, "authoritative"]);
      const incrementalKey = JSON.stringify([threadId, cursor ?? null, "incremental"]);
      if (!options.authoritative) {
        const authoritative = detailRequests.current.get(authoritativeKey);
        if (authoritative) return authoritative;
      }
      const key = options.authoritative ? authoritativeKey : incrementalKey;
      const current = detailRequests.current.get(key);
      if (current) return current;
      if (options.authoritative) detailRequests.current.delete(incrementalKey);
      const version = (detailRequestVersions.current.get(versionKey) ?? 0) + 1;
      detailRequestVersions.current.set(versionKey, version);
      const targetGeneration = generationRef.current;
      const targetSequence = appliedThreadSequences.current.get(threadId) ?? null;
      const canApply = () =>
        detailRequestVersions.current.get(versionKey) === version &&
        generationRef.current === targetGeneration;
      const liveAdvanced = () =>
        (appliedThreadSequences.current.get(threadId) ?? null) !== targetSequence;
      const wouldRollbackLive = (incoming: ThreadDetail) =>
        threadDetailWouldRollbackLiveTurn(
          stateRef.current.snapshot?.threads.find((thread) => thread.id === threadId),
          stateRef.current.details[threadId],
          incoming,
        );
      const preferredSummary = (incoming: ThreadSummary, preserveLive: boolean): ThreadSummary => {
        const current = stateRef.current.snapshot?.threads.find((thread) => thread.id === threadId);
        if (preserveLive) return current ?? incoming;
        return current && current.updatedAt > incoming.updatedAt ? current : incoming;
      };
      const acceptLatestSummary = (
        incoming: ThreadSummary,
        preserveLive: boolean,
      ): ThreadSummary => {
        const preferred = preferredSummary(incoming, preserveLive);
        if (!preserveLive && preferred === incoming && canApply()) {
          dispatch({ type: "thread", thread: incoming });
        }
        return preferred;
      };
      const request = (async () => {
        let acceptedSummary: ThreadSummary | undefined;
        const authoritativeLatest = async (): Promise<ThreadDetail> => {
          const { snapshot, detail } = await api.refreshThread(threadId);
          if (canApply()) {
            const preserveLive = liveAdvanced() || wouldRollbackLive(detail);
            if (acceptSyncedSnapshot(snapshot, targetGeneration)) {
              acceptedSummary = preferredSummary(detail.summary, preserveLive);
              dispatch({
                type: "detail",
                detail,
                page: "reset",
                preserveLive,
              });
            }
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
                  const preserveLive = liveAdvanced() || wouldRollbackLive(merged);
                  dispatch({
                    type: "changes",
                    threadId,
                    changes,
                    preserveLive,
                  });
                }
                continuationCursor = changes.continuationCursor ?? undefined;
              } while (continuationCursor);
              const rollsBackLiveTurn = wouldRollbackLive(merged);
              const preserveLive = liveAdvanced() || rollsBackLiveTurn;
              const summary = preferredSummary(merged.summary, preserveLive);
              const currentDetail = stateRef.current.details[threadId];
              const canPreserveLiveTurn = Boolean(
                currentDetail && !threadDetailNeedsRecovery(currentDetail, summary),
              );
              if (!canApply()) {
                detail = merged;
              } else if (
                threadDetailNeedsRecovery(merged, summary) &&
                (!rollsBackLiveTurn || !canPreserveLiveTurn)
              ) {
                detail = await authoritativeLatest();
              } else {
                if (canApply()) {
                  acceptedSummary = acceptLatestSummary(merged.summary, preserveLive);
                }
                detail = merged;
              }
            } catch {
              detail = await authoritativeLatest();
            }
          } else if (!cursor && options.authoritative) {
            detail = await authoritativeLatest();
          } else {
            detail = await api.readThread(threadId, cursor, { fresh: options.force });
            if (canApply()) {
              const preserveLive = liveAdvanced() || (!cursor && wouldRollbackLive(detail));
              if (!cursor) {
                acceptedSummary = acceptLatestSummary(detail.summary, preserveLive);
              }
              dispatch({
                type: "detail",
                detail,
                page: cursor ? "older" : "latest",
                preserveLive,
              });
            }
          }
          if (!cursor && canApply()) {
            const summary =
              acceptedSummary ??
              stateRef.current.snapshot?.threads.find((thread) => thread.id === threadId) ??
              detail.summary;
            const currentDetail = stateRef.current.details[threadId];
            const needsRecovery =
              threadDetailNeedsRecovery(detail, summary) &&
              (!currentDetail || threadDetailNeedsRecovery(currentDetail, summary));
            if (needsRecovery) scheduleDetailRetry(threadId);
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
    [acceptSyncedSnapshot, api, clearDetailRetry, scheduleDetailRetry, settings],
  );
  detailReader.current = readDetail;

  const refreshDetail = useCallback(
    (threadId: string, options?: DetailReadOptions) => readDetail(threadId, undefined, options),
    [readDetail],
  );
  const forceRefreshDetail = useCallback(
    (threadId: string): Promise<ThreadDetail> =>
      readDetail(threadId, undefined, { authoritative: true, force: true }),
    [readDetail],
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

  const publishPendingVoiceRecordingThreads = useCallback(() => {
    const threadIds = new Set<string>();
    const errors: Record<string, string> = {};
    for (const recording of pendingVoiceRecordings.current.values()) {
      threadIds.add(recording.threadId);
      if (recording.lastError && errors[recording.threadId] === undefined) {
        errors[recording.threadId] = recording.lastError;
      }
    }
    setPendingVoiceRecordingThreadIds([...threadIds]);
    setPendingVoiceRecordingErrors(errors);
  }, []);

  const trackPendingVoiceRecording = useCallback(
    (recording: Pick<PendingVoiceRecording, "id" | "threadId" | "lastError">) => {
      pendingVoiceRecordings.current.set(recording.id, {
        threadId: recording.threadId,
        lastError: recording.lastError,
      });
      publishPendingVoiceRecordingThreads();
    },
    [publishPendingVoiceRecordingThreads],
  );

  const untrackPendingVoiceRecording = useCallback(
    (id: string) => {
      if (!pendingVoiceRecordings.current.delete(id)) return;
      publishPendingVoiceRecordingThreads();
    },
    [publishPendingVoiceRecordingThreads],
  );

  const uploadVoiceRecording = useCallback(
    async (recording: PendingVoiceRecording): Promise<void> => {
      let prepared = recording;
      try {
        if (!Object.prototype.hasOwnProperty.call(prepared, "serverDraftUpdatedAt")) {
          const savedDraft = await api.updateThreadDraft(prepared.threadId, prepared.draft, {
            retry: false,
            expectedUpdatedAt: prepared.draftUpdatedAt,
          });
          prepared = { ...prepared, serverDraftUpdatedAt: savedDraft?.updatedAt ?? null };
          if (!(await putPendingVoiceRecording(prepared))) {
            throw new Error(
              translate(languageRef.current, "Не удалось надежно сохранить запись на устройстве"),
            );
          }
          await confirmLocalDraft(
            settings,
            prepared.threadId,
            savedDraft,
            prepared.localDraftUpdatedAt,
          );
        }
        const accepted = await api.createVoiceTranscription(prepared.threadId, prepared.audio, {
          recordingDurationMs: prepared.durationMs,
          mode: prepared.mode,
          selectionStart: prepared.selectionStart,
          selectionEnd: prepared.selectionEnd,
          draftUpdatedAt: prepared.serverDraftUpdatedAt ?? null,
          clientUploadId: prepared.id,
        });
        if (accepted) dispatch({ type: "voice.accepted", job: accepted });
        await deletePendingVoiceRecording(prepared.id);
        recoveredVoiceRecordingIds.current.delete(prepared.id);
        untrackPendingVoiceRecording(prepared.id);
      } catch (error) {
        const current = (await loadPendingVoiceRecording(prepared.id)) ?? prepared;
        const failed = {
          ...current,
          attempts: current.attempts + 1,
          lastError: error instanceof Error ? error.message : "Delivery failed",
        };
        await putPendingVoiceRecording(failed);
        trackPendingVoiceRecording(failed);
        throw error;
      }
    },
    [api, settings, trackPendingVoiceRecording, untrackPendingVoiceRecording],
  );

  const queueVoiceRecording = useCallback(
    async (input: Omit<VoiceRecordingUpload, "localDraftUpdatedAt">): Promise<void> => {
      const existing = await loadPendingVoiceRecording(input.id);
      const localDraftUpdatedAt = existing?.localDraftUpdatedAt ?? Date.now();
      const recording: PendingVoiceRecording =
        existing ??
        ({
          ...input,
          connectionKey: connectionCacheKey(settings),
          localDraftUpdatedAt,
          createdAt: Date.now(),
          attempts: 0,
          lastError: null,
        } satisfies PendingVoiceRecording);
      if (!existing && !(await putPendingVoiceRecording(recording))) {
        throw new Error(
          translate(languageRef.current, "Не удалось надежно сохранить запись на устройстве"),
        );
      }
      trackPendingVoiceRecording(recording);
      await saveLocalDraft(settings, recording.threadId, recording.draft, localDraftUpdatedAt);
      await uploadVoiceRecording(recording);
    },
    [settings, trackPendingVoiceRecording, uploadVoiceRecording],
  );

  const retryPendingVoiceRecording = useCallback(
    async (input: VoiceRecordingRecovery): Promise<void> => {
      const recordings = await listPendingVoiceRecordings(settings);
      const recording = recordings
        .filter((candidate) => candidate.threadId === input.threadId)
        .sort((left, right) => left.createdAt - right.createdAt)[0];
      if (!recording) return;
      try {
        await uploadVoiceRecording(recording);
        return;
      } catch (error) {
        if (!(error instanceof ApiClientError) || error.code !== "draft_conflict") throw error;
      }
      const current = (await loadPendingVoiceRecording(recording.id)) ?? recording;
      const unprepared = { ...current };
      delete unprepared.serverDraftUpdatedAt;
      const maxSelection = input.draft.input.length;
      const selectionStart = Math.min(current.selectionStart, maxSelection);
      const rebased: PendingVoiceRecording = {
        ...unprepared,
        mode: input.mode,
        draft: structuredClone(input.draft),
        draftUpdatedAt: input.draftUpdatedAt,
        selectionStart,
        selectionEnd: Math.max(selectionStart, Math.min(current.selectionEnd, maxSelection)),
        lastError: null,
      };
      if (!(await putPendingVoiceRecording(rebased))) {
        throw new Error(
          translate(languageRef.current, "Не удалось надежно сохранить запись на устройстве"),
        );
      }
      trackPendingVoiceRecording(rebased);
      await uploadVoiceRecording(rebased);
    },
    [settings, trackPendingVoiceRecording, uploadVoiceRecording],
  );

  const scheduleVoiceRecoveryRetry = useCallback((attempt: number, drain: () => void) => {
    if (voiceRecoveryRetryTimer.current !== undefined) return;
    const delays = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
    const base = delays[Math.min(Math.max(0, attempt - 1), delays.length - 1)] ?? 30_000;
    voiceRecoveryRetryTimer.current = window.setTimeout(
      () => {
        voiceRecoveryRetryTimer.current = undefined;
        drain();
      },
      Math.round(base * (0.8 + Math.random() * 0.4)),
    );
  }, []);

  const drainRecoveredVoiceRecordings = useCallback((): Promise<void> => {
    if (voiceRecoveryDrain.current) return voiceRecoveryDrain.current;
    const request = (async () => {
      const recordings = await listPendingVoiceRecordings(settings);
      let retryAttempt: number | null = null;
      for (const recording of recordings) {
        if (!recoveredVoiceRecordingIds.current.has(recording.id)) continue;
        try {
          await uploadVoiceRecording(recording);
        } catch (error) {
          if (
            isRetryableApiError(error) ||
            (error instanceof ApiClientError &&
              error.status === 409 &&
              error.code !== "draft_conflict")
          ) {
            retryAttempt = Math.max(retryAttempt ?? 0, recording.attempts + 1);
          }
        }
      }
      if (retryAttempt !== null) {
        scheduleVoiceRecoveryRetry(retryAttempt, () => void drainRecoveredVoiceRecordings());
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        if (voiceRecoveryDrain.current === request) voiceRecoveryDrain.current = null;
      });
    voiceRecoveryDrain.current = request;
    return request;
  }, [scheduleVoiceRecoveryRetry, settings, uploadVoiceRecording]);

  const persistUserInputDraft = useCallback(
    function persist(attentionId: string): void {
      const entry = userInputDraftPersistence.current.get(attentionId);
      if (!entry) return;
      if (entry.timer !== undefined) {
        window.clearTimeout(entry.timer);
        entry.timer = undefined;
      }
      if (entry.inFlight) {
        entry.pending = true;
        return;
      }
      if (entry.version <= entry.savedVersion) return;
      const version = entry.version;
      const draft = normalizeUserInputDraft(entry.draft);
      entry.inFlight = true;
      entry.pending = false;
      dispatch({ type: "userInputDraft.saving", attentionId, version });
      void api
        .updateUserInputDraft(attentionId, draft)
        .then((saved) => {
          if (userInputDraftPersistence.current.get(attentionId) !== entry) return;
          entry.savedVersion = Math.max(entry.savedVersion, version);
          dispatch({ type: "userInputDraft.saved", attentionId, version, draft: saved });
        })
        .catch((caught: unknown) => {
          if (userInputDraftPersistence.current.get(attentionId) !== entry) return;
          dispatch({
            type: "userInputDraft.failed",
            attentionId,
            error: caught instanceof Error ? caught.message : "Draft save failed",
          });
        })
        .finally(() => {
          if (userInputDraftPersistence.current.get(attentionId) !== entry) return;
          entry.inFlight = false;
          if (!entry.pending) return;
          entry.pending = false;
          persist(attentionId);
        });
    },
    [api],
  );

  const updateUserInputDraft = useCallback(
    (
      attentionId: string,
      input: UpdateUserInputDraftRequest,
      timing: "immediate" | "debounced",
    ): void => {
      const draft = {
        answers: cloneUserInputAnswers(input.answers),
        currentQuestionId: input.currentQuestionId,
      };
      let entry = userInputDraftPersistence.current.get(attentionId);
      if (!entry) {
        const current = stateRef.current.userInputDrafts[attentionId];
        entry = {
          draft: current
            ? {
                answers: cloneUserInputAnswers(current.answers),
                currentQuestionId: current.currentQuestionId,
              }
            : { answers: {}, currentQuestionId: null },
          version: current?.localVersion ?? 0,
          savedVersion: current?.savedVersion ?? 0,
          inFlight: current?.saving ?? false,
          pending: false,
          timer: undefined,
        };
        userInputDraftPersistence.current.set(attentionId, entry);
      }
      if (sameUserInputDraft(entry.draft, draft)) {
        if (timing === "immediate") persistUserInputDraft(attentionId);
        return;
      }
      entry.draft = draft;
      entry.version += 1;
      dispatch({
        type: "userInputDraft.edit",
        attentionId,
        draft,
        version: entry.version,
      });
      if (entry.timer !== undefined) window.clearTimeout(entry.timer);
      entry.timer = undefined;
      if (timing === "immediate") {
        persistUserInputDraft(attentionId);
      } else {
        entry.timer = window.setTimeout(() => persistUserInputDraft(attentionId), 500);
      }
    },
    [persistUserInputDraft],
  );

  const flushUserInputDraft = useCallback(
    (attentionId: string): void => persistUserInputDraft(attentionId),
    [persistUserInputDraft],
  );

  const clearUserInputDraft = useCallback((attentionId: string): void => {
    const entry = userInputDraftPersistence.current.get(attentionId);
    if (entry?.timer !== undefined) window.clearTimeout(entry.timer);
    userInputDraftPersistence.current.delete(attentionId);
    dispatch({ type: "userInputDraft.clear", attentionId });
  }, []);

  useEffect(() => {
    const flushAll = () => {
      for (const attentionId of userInputDraftPersistence.current.keys()) {
        persistUserInputDraft(attentionId);
      }
    };
    window.addEventListener("pagehide", flushAll);
    return () => {
      window.removeEventListener("pagehide", flushAll);
      flushAll();
    };
  }, [persistUserInputDraft]);

  useEffect(() => {
    const wake = () => {
      void drainReliableOutbox();
      void drainRecoveredVoiceRecordings();
    };
    window.addEventListener("online", wake);
    void drainReliableOutbox();
    return () => {
      window.removeEventListener("online", wake);
      if (outboxRetryTimer.current !== undefined) {
        window.clearTimeout(outboxRetryTimer.current);
        outboxRetryTimer.current = undefined;
      }
      if (voiceRecoveryRetryTimer.current !== undefined) {
        window.clearTimeout(voiceRecoveryRetryTimer.current);
        voiceRecoveryRetryTimer.current = undefined;
      }
    };
  }, [drainRecoveredVoiceRecordings, drainReliableOutbox]);

  useEffect(() => {
    let active = true;
    void listPendingVoiceRecordings(settings)
      .then((recordings) => {
        if (!active) return;
        pendingVoiceRecordings.current.clear();
        for (const recording of recordings) {
          recoveredVoiceRecordingIds.current.add(recording.id);
          pendingVoiceRecordings.current.set(recording.id, {
            threadId: recording.threadId,
            lastError: recording.lastError,
          });
        }
        publishPendingVoiceRecordingThreads();
        void drainRecoveredVoiceRecordings();
      })
      .catch(() => undefined);
    return () => {
      active = false;
      recoveredVoiceRecordingIds.current.clear();
      pendingVoiceRecordings.current.clear();
      publishPendingVoiceRecordingThreads();
    };
  }, [drainRecoveredVoiceRecordings, publishPendingVoiceRecordingThreads, settings]);

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
          appliedThreadSequences.current = new Map(
            frame.snapshot.threads.map((thread) => [thread.id, frame.snapshot.sequence]),
          );
          browserNotifications?.acceptSnapshot(frame.snapshot);
          observeNativeNotificationSnapshot(frame.snapshot);
          dispatch({ type: "snapshot", snapshot: frame.snapshot });
          if (receivedStreamSnapshot.current) {
            setStreamRecoveryEpoch((current) => current + 1);
          } else {
            receivedStreamSnapshot.current = true;
          }
          void drainReliableOutbox();
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
          for (const threadId of serverEventThreadIds(frame.event)) {
            appliedThreadSequences.current.set(threadId, frame.sequence);
          }
          browserNotifications?.acceptEvent(frame.event);
          observeNativeNotificationEvent(frame.sequence, frame.event);
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
  }, [api, browserNotifications, drainReliableOutbox, generation, settings.token]);

  useEffect(() => {
    const refresh = () => {
      if (foregroundRefresh.current) return;
      reconnect();
      const request = drainReliableOutbox()
        .catch(() => undefined)
        .finally(() => {
          if (foregroundRefresh.current === request) foregroundRefresh.current = null;
        });
      foregroundRefresh.current = request;
    };
    const foreground = () => {
      const active = document.visibilityState === "visible";
      setAppActive(active);
      if (active) refresh();
    };
    let removeNativeListener: (() => Promise<void>) | undefined;
    if (Capacitor.isNativePlatform()) {
      setNativeNotificationAppActive(true);
      void CapacitorApp.addListener("appStateChange", ({ isActive }) => {
        setNativeNotificationAppActive(isActive);
        setAppActive(isActive);
        if (isActive) {
          setForegroundEpoch((current) => current + 1);
          refresh();
        }
      }).then((handle) => {
        removeNativeListener = () => handle.remove();
      });
    } else {
      document.addEventListener("visibilitychange", foreground);
    }
    return () => {
      document.removeEventListener("visibilitychange", foreground);
      setNativeNotificationAppActive(true);
      void removeNativeListener?.();
    };
  }, [drainReliableOutbox, reconnect]);

  const value = useMemo(
    () => ({
      api,
      state,
      appActive,
      foregroundEpoch,
      streamRecoveryEpoch,
      dispatch,
      refreshDetail,
      forceRefreshDetail,
      loadOlderDetail,
      loadTurnItems,
      sendReliable,
      queueVoiceRecording,
      pendingVoiceRecordingThreadIds,
      pendingVoiceRecordingErrors,
      retryPendingVoiceRecording,
      updateUserInputDraft,
      flushUserInputDraft,
      clearUserInputDraft,
      reconnect,
    }),
    [
      api,
      state,
      appActive,
      foregroundEpoch,
      streamRecoveryEpoch,
      refreshDetail,
      forceRefreshDetail,
      loadOlderDetail,
      loadTurnItems,
      sendReliable,
      queueVoiceRecording,
      pendingVoiceRecordingThreadIds,
      pendingVoiceRecordingErrors,
      retryPendingVoiceRecording,
      updateUserInputDraft,
      flushUserInputDraft,
      clearUserInputDraft,
      reconnect,
    ],
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

function threadDetailWouldRollbackLiveTurn(
  snapshotSummary: ThreadSummary | undefined,
  current: ThreadDetail | undefined,
  incoming: ThreadDetail,
): boolean {
  if (!current) return false;
  const currentSummary =
    snapshotSummary && snapshotSummary.updatedAt > current.summary.updatedAt
      ? snapshotSummary
      : current.summary;
  let currentTurnId = currentSummary.currentTurnId;
  for (let index = current.turns.length - 1; currentTurnId === null && index >= 0; index -= 1) {
    const turn = current.turns[index];
    if (turn?.status === "inProgress") currentTurnId = turn.id;
  }
  if (!currentTurnId || incoming.summary.updatedAt > currentSummary.updatedAt) return false;
  return !incoming.turns.some((turn) => turn.id === currentTurnId);
}

function serverEventThreadIds(event: ServerEvent): string[] {
  if (event.type === "thread.upserted") return [event.thread.id];
  if (event.type === "attention.upserted") {
    return event.attention.threadId ? [event.attention.threadId] : [];
  }
  if ("threadId" in event && typeof event.threadId === "string") return [event.threadId];
  return [];
}

function normalizeUserInputDraft(input: UpdateUserInputDraftRequest): UpdateUserInputDraftRequest {
  return {
    answers: Object.fromEntries(
      Object.entries(input.answers)
        .filter(([, answers]) => Boolean(answers[0]?.trim()))
        .map(([questionId, answers]) => [questionId, [answers[0]!]]),
    ),
    currentQuestionId: input.currentQuestionId,
  };
}

function cloneUserInputAnswers(answers: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(answers).map(([id, values]) => [id, [...values]]));
}

function sameUserInputDraft(
  left: UpdateUserInputDraftRequest,
  right: UpdateUserInputDraftRequest,
): boolean {
  if (left.currentQuestionId !== right.currentQuestionId) return false;
  const leftEntries = Object.entries(left.answers);
  const rightEntries = Object.entries(right.answers);
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([id, answers]) => answers[0] === right.answers[id]?.[0])
  );
}
