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
  type ProjectionVersion,
  type QueueMessageRequest,
  type ServerEvent,
  type ThreadDetail,
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
  deleteCachedThread,
  deleteOutboxMessage,
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
import { clientReducer, initialState, type ClientAction, type ClientState } from "./state";
import type { ConnectionSettings } from "./storage";

const HEARTBEAT_IDLE_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const LEGACY_CACHE_INSTANCE_ID = "legacy-cache";

type DetailReadOptions = {
  authoritative?: boolean;
  force?: boolean;
};

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
  hydrateCachedDetail(threadId: string): Promise<void>;
  refreshDetail(threadId: string, options?: DetailReadOptions): Promise<ThreadDetail>;
  forceRefreshDetail(threadId: string): Promise<ThreadDetail>;
  loadOlderDetail(threadId: string, cursor: string): Promise<void>;
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
  const connectionEpoch = useRef(0);
  const streamVersion = useRef<{ instanceId: string; sequence: number } | null>(null);
  const receivedStreamSnapshot = useRef(false);
  const threadEventVersions = useRef(new Map<string, ProjectionVersion>());
  const detailRequests = useRef(new Map<string, Promise<ThreadDetail>>());
  const historyRequests = useRef(new Map<string, Promise<void>>());
  const turnItemRequests = useRef(new Map<string, Promise<void>>());
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
          cached?.snapshot &&
          generationRef.current === targetGeneration &&
          !streamVersion.current
        ) {
          dispatch({
            type: "hydrate",
            snapshot: normalizeCachedSnapshot(cached.snapshot),
            goals: cached.goals,
          });
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

  const invalidateRequests = useCallback(() => {
    connectionEpoch.current += 1;
    detailRequests.current.clear();
    historyRequests.current.clear();
    turnItemRequests.current.clear();
  }, []);

  const reconnect = useCallback(() => {
    const next = generationRef.current + 1;
    generationRef.current = next;
    invalidateRequests();
    threadEventVersions.current.clear();
    setGeneration(next);
    return next;
  }, [invalidateRequests]);

  const hydrateCachedDetail = useCallback(
    async (threadId: string): Promise<void> => {
      const snapshot = stateRef.current.snapshot;
      if (!snapshot?.instanceId || stateRef.current.details[threadId]) return;
      const cached = await loadCachedThread(settings, threadId);
      if (stateRef.current.details[threadId]) return;
      const normalized = cached ? normalizeCachedDetail(cached, snapshot) : null;
      if (normalized) dispatch({ type: "hydrate.detail", detail: normalized });
    },
    [settings],
  );

  const readDetail = useCallback(
    (threadId: string, options: DetailReadOptions = {}): Promise<ThreadDetail> => {
      const key = `${threadId}:${options.authoritative ? "refresh" : "read"}`;
      const current = detailRequests.current.get(key);
      if (current) return current;
      const targetGeneration = generationRef.current;
      const targetConnectionEpoch = connectionEpoch.current;
      const targetSnapshot = stateRef.current.snapshot;
      const request = (async () => {
        if (!stateRef.current.details[threadId] && targetSnapshot?.instanceId) {
          const cached = await loadCachedThread(settings, threadId);
          if (
            cached &&
            generationRef.current === targetGeneration &&
            connectionEpoch.current === targetConnectionEpoch
          ) {
            const normalized = normalizeCachedDetail(cached, targetSnapshot);
            if (normalized) dispatch({ type: "hydrate.detail", detail: normalized });
          }
        }
        let rawDetail: ThreadDetail;
        let refreshSnapshot: AppSnapshot | null = null;
        if (options.authoritative) {
          const refreshed = await api.refreshThread(threadId);
          rawDetail = refreshed.detail;
          refreshSnapshot = refreshed.snapshot;
        } else {
          rawDetail = await api.readThread(threadId, { fresh: options.force });
        }
        const fallbackVersion =
          streamVersion.current ??
          (targetSnapshot?.instanceId
            ? { instanceId: targetSnapshot.instanceId, sequence: targetSnapshot.sequence }
            : null);
        if (!rawDetail.version && !fallbackVersion) return rawDetail;
        const detail = normalizeThreadDetail(rawDetail, fallbackVersion);
        if (
          generationRef.current !== targetGeneration ||
          connectionEpoch.current !== targetConnectionEpoch
        ) {
          return detail;
        }
        const activeSnapshot = stateRef.current.snapshot;
        if (
          !activeSnapshot?.instanceId ||
          detail.version?.instanceId !== activeSnapshot.instanceId
        ) {
          throw new ApiClientError(
            "projection_advanced",
            "The backend projection changed while the session was loading",
            425,
          );
        }
        const threadVersion = threadEventVersions.current.get(threadId);
        if (
          threadVersion?.instanceId === detail.version.instanceId &&
          threadVersion.sequence > detail.version.sequence
        ) {
          throw new ApiClientError(
            "projection_advanced",
            "The session changed while its detail was loading",
            425,
          );
        }
        if (refreshSnapshot) {
          const refreshedSnapshot = normalizeServerSnapshot(
            refreshSnapshot,
            detail.version.instanceId,
          );
          if (
            refreshedSnapshot.instanceId === activeSnapshot.instanceId &&
            refreshedSnapshot.sequence >= activeSnapshot.sequence
          ) {
            acceptSnapshotVersion(refreshedSnapshot, threadEventVersions.current);
            dispatch({ type: "snapshot", snapshot: refreshedSnapshot });
          }
        }
        dispatch({ type: "detail", detail });
        return detail;
      })().finally(() => {
        if (detailRequests.current.get(key) === request) detailRequests.current.delete(key);
      });
      detailRequests.current.set(key, request);
      return request;
    },
    [api, settings],
  );

  const refreshDetail = useCallback(
    (threadId: string, options?: DetailReadOptions) => readDetail(threadId, options),
    [readDetail],
  );
  const forceRefreshDetail = useCallback(
    (threadId: string): Promise<ThreadDetail> =>
      readDetail(threadId, { authoritative: true, force: true }),
    [readDetail],
  );
  const loadOlderDetail = useCallback(
    (threadId: string, cursor: string): Promise<void> => {
      const startingDetail = stateRef.current.details[threadId];
      const anchorTurnId = startingDetail?.turns[0]?.id;
      if (!anchorTurnId) return Promise.resolve();
      const key = `${threadId}:${cursor}:${anchorTurnId}`;
      const current = historyRequests.current.get(key);
      if (current) return current;
      const targetGeneration = generationRef.current;
      const targetConnectionEpoch = connectionEpoch.current;
      const request = (async () => {
        const instanceId = stateRef.current.snapshot?.instanceId;
        if (!instanceId) return;
        const readPage = async (pageCursor: string, pageAnchor: string) => {
          if (isLegacyInstanceId(instanceId)) {
            const legacy = await api.readLegacyThreadPage(threadId, pageCursor);
            return {
              instanceId,
              anchorTurnId: pageAnchor,
              turns: legacy.turns,
              olderTurnsCursor: legacy.olderTurnsCursor,
            };
          }
          return api.readThreadHistory(threadId, pageCursor, pageAnchor);
        };
        const readRebasedPage = async () => {
          const refreshed = await api.refreshThread(threadId);
          const refreshedSnapshot = normalizeServerSnapshot(refreshed.snapshot, instanceId);
          const detail = normalizeThreadDetail(refreshed.detail, {
            instanceId: refreshedSnapshot.instanceId,
            sequence: refreshedSnapshot.sequence,
          });
          if (detail.version.instanceId !== refreshedSnapshot.instanceId) {
            throw new ApiClientError(
              "projection_advanced",
              "The backend projection changed while history was rebasing",
              425,
            );
          }
          const pageCursor = detail.olderTurnsCursor;
          const pageAnchor = detail.turns[0]?.id;
          if (!pageCursor || !pageAnchor) return null;
          const page = await readPage(pageCursor, pageAnchor);
          if (page.instanceId !== detail.version.instanceId || page.anchorTurnId !== pageAnchor) {
            throw new ApiClientError(
              "history_changed",
              "The session history changed again while it was rebasing",
              409,
            );
          }
          return { detail, page, snapshot: refreshedSnapshot };
        };
        let page;
        let rebasedDetail: VersionedThreadDetail | null = null;
        let rebasedSnapshot: VersionedSnapshot | null = null;
        try {
          page = await readPage(cursor, anchorTurnId);
        } catch (error) {
          if (!(error instanceof ApiClientError) || error.code !== "history_changed") throw error;
          const rebased = await readRebasedPage();
          if (!rebased) return;
          ({ detail: rebasedDetail, page, snapshot: rebasedSnapshot } = rebased);
        }
        const activeDetail = stateRef.current.details[threadId];
        if (
          !rebasedDetail &&
          (stateRef.current.snapshot?.instanceId !== page.instanceId ||
            activeDetail?.turns[0]?.id !== page.anchorTurnId)
        ) {
          const rebased = await readRebasedPage();
          if (!rebased) return;
          ({ detail: rebasedDetail, page, snapshot: rebasedSnapshot } = rebased);
        }
        if (
          generationRef.current === targetGeneration &&
          connectionEpoch.current === targetConnectionEpoch
        ) {
          if (rebasedDetail && rebasedSnapshot) {
            const activeSnapshot = stateRef.current.snapshot;
            const threadVersion = threadEventVersions.current.get(threadId);
            if (
              !activeSnapshot?.instanceId ||
              activeSnapshot.instanceId !== rebasedDetail.version.instanceId ||
              (threadVersion?.instanceId === rebasedDetail.version.instanceId &&
                threadVersion.sequence > rebasedDetail.version.sequence)
            ) {
              throw new ApiClientError(
                "projection_advanced",
                "The session changed while history was rebasing",
                425,
              );
            }
            if (
              rebasedSnapshot.instanceId === activeSnapshot.instanceId &&
              rebasedSnapshot.sequence >= activeSnapshot.sequence
            ) {
              acceptSnapshotVersion(rebasedSnapshot, threadEventVersions.current);
              dispatch({ type: "snapshot", snapshot: rebasedSnapshot });
            }
          }
          dispatch(
            rebasedDetail
              ? { type: "history.rebase", detail: rebasedDetail, page }
              : { type: "history", threadId, page },
          );
        }
      })().finally(() => {
        if (historyRequests.current.get(key) === request) historyRequests.current.delete(key);
      });
      historyRequests.current.set(key, request);
      return request;
    },
    [api],
  );
  const loadTurnItems = useCallback(
    (threadId: string, turnId: string): Promise<void> => {
      const key = `${threadId}:${turnId}`;
      const current = turnItemRequests.current.get(key);
      if (current) return current;
      const targetGeneration = generationRef.current;
      const targetConnectionEpoch = connectionEpoch.current;
      const request = api
        .readTurnItems(threadId, turnId)
        .then((response) => {
          if (
            generationRef.current !== targetGeneration ||
            connectionEpoch.current !== targetConnectionEpoch
          ) {
            return;
          }
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
      const legacyInstanceId = `legacy:${generationRef.current}:${connectionEpoch.current}`;
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
          const snapshot = normalizeServerSnapshot(frame.snapshot, legacyInstanceId);
          if (streamVersion.current) invalidateRequests();
          retry = 0;
          streamVersion.current = {
            instanceId: snapshot.instanceId,
            sequence: snapshot.sequence,
          };
          acceptSnapshotVersion(snapshot, threadEventVersions.current);
          browserNotifications?.acceptSnapshot(snapshot);
          observeNativeNotificationSnapshot(snapshot);
          dispatch({ type: "snapshot", snapshot });
          if (receivedStreamSnapshot.current) {
            setStreamRecoveryEpoch((current) => current + 1);
          } else {
            receivedStreamSnapshot.current = true;
          }
          void drainReliableOutbox();
        } else if (frame.type === "event") {
          const current = streamVersion.current;
          const version =
            frame.version ??
            (current ? { instanceId: current.instanceId, sequence: frame.sequence } : null);
          if (
            !current ||
            !version ||
            version.instanceId !== current.instanceId ||
            version.sequence !== current.sequence + 1
          ) {
            candidate.close();
            return;
          }
          streamVersion.current = version;
          const threadId = serverEventThreadId(frame.event);
          if (threadId) threadEventVersions.current.set(threadId, version);
          browserNotifications?.acceptEvent(frame.event);
          observeNativeNotificationEvent(version.sequence, frame.event);
          dispatch({ type: "event", version, event: frame.event });
        } else if (frame.type === "error") {
          dispatch({ type: "network", network: "offline", error: frame.error.message });
        }
      });
      candidate.addEventListener("close", () => {
        if (stopped || socket !== candidate) return;
        socket = undefined;
        clearHeartbeat();
        invalidateRequests();
        threadEventVersions.current.clear();
        streamVersion.current = null;
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
      invalidateRequests();
      threadEventVersions.current.clear();
      streamVersion.current = null;
      socket?.close();
    };
  }, [
    api,
    browserNotifications,
    drainReliableOutbox,
    generation,
    invalidateRequests,
    settings.token,
  ]);

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
      hydrateCachedDetail,
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
      hydrateCachedDetail,
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

type VersionedThreadDetail = ThreadDetail & { version: ProjectionVersion };
type VersionedSnapshot = AppSnapshot & { instanceId: string };

function normalizeServerSnapshot(
  snapshot: AppSnapshot,
  fallbackInstanceId: string,
): VersionedSnapshot {
  return {
    ...snapshot,
    instanceId: snapshot.instanceId?.trim() || fallbackInstanceId,
  };
}

function normalizeCachedSnapshot(snapshot: AppSnapshot): VersionedSnapshot {
  return normalizeServerSnapshot(snapshot, LEGACY_CACHE_INSTANCE_ID);
}

function normalizeCachedDetail(
  detail: ThreadDetail,
  snapshot: AppSnapshot,
): VersionedThreadDetail | null {
  if (!snapshot.instanceId) return null;
  if (detail.version?.instanceId === snapshot.instanceId) return detail as VersionedThreadDetail;
  if (!detail.version && snapshot.instanceId === LEGACY_CACHE_INSTANCE_ID) {
    return {
      ...detail,
      version: { instanceId: snapshot.instanceId, sequence: snapshot.sequence },
    };
  }
  return null;
}

function normalizeThreadDetail(
  detail: ThreadDetail,
  fallbackVersion: ProjectionVersion | null,
): VersionedThreadDetail {
  if (detail.version) return detail as VersionedThreadDetail;
  if (!fallbackVersion) {
    throw new ApiClientError(
      "projection_unavailable",
      "The backend projection version is unavailable",
      425,
    );
  }
  return { ...detail, version: fallbackVersion };
}

function acceptSnapshotVersion(
  snapshot: VersionedSnapshot,
  versions: Map<string, ProjectionVersion>,
): void {
  versions.clear();
  const version = { instanceId: snapshot.instanceId, sequence: snapshot.sequence };
  for (const thread of snapshot.threads) versions.set(thread.id, version);
}

function isLegacyInstanceId(instanceId: string): boolean {
  return instanceId === LEGACY_CACHE_INSTANCE_ID || instanceId.startsWith("legacy:");
}

function serverEventThreadId(event: ServerEvent): string | null {
  switch (event.type) {
    case "thread.upserted":
      return event.thread.id;
    case "thread.removed":
    case "activity.upserted":
    case "activity.delta":
    case "turn.progressed":
    case "queue.changed":
    case "goal.changed":
    case "voiceTranscription.removed":
      return event.threadId;
    case "voiceTranscription.upserted":
      return event.job.threadId;
    default:
      return null;
  }
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
