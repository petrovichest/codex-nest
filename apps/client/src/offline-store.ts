import type {
  AppSnapshot,
  ThreadDetail,
  ThreadDraft,
  ThreadGoal,
  UpdateThreadDraftRequest,
  VoiceTranscriptionMode,
} from "@codexnest/protocol";

import type { ConnectionSettings } from "./storage";

const DATABASE_NAME = "codexnest-offline";
const DATABASE_VERSION = 1;
const THREAD_CACHE_LIMIT_BYTES = 250 * 1024 * 1024;
const THREAD_CACHE_CLEANUP_INTERVAL_MS = 30_000;

const META_STORE = "meta";
const THREAD_STORE = "threads";
const DRAFT_STORE = "drafts";
const OUTBOX_STORE = "outbox";
const RECORDING_STORE = "recordings";

export type CachedMeta = {
  snapshot: AppSnapshot | null;
  goals: Record<string, ThreadGoal | null>;
  updatedAt: number;
};

type CachedThread = {
  key: string;
  connectionKey: string;
  threadId: string;
  detail: ThreadDetail;
  accessedAt: number;
  bytes: number;
};

export type LocalDraft = {
  key: string;
  connectionKey: string;
  threadId: string;
  value: UpdateThreadDraftRequest;
  updatedAt: number;
};

export type OutboxMessage = {
  id: string;
  connectionKey: string;
  threadId: string;
  input: string;
  images: string[];
  goal: boolean;
  createdAt: number;
  attempts: number;
  lastError: string | null;
};

export type PendingVoiceRecording = {
  id: string;
  connectionKey: string;
  threadId: string;
  audio: Blob;
  durationMs: number;
  mode: VoiceTranscriptionMode;
  selectionStart: number;
  selectionEnd: number;
  draftUpdatedAt: number | null;
  draft: UpdateThreadDraftRequest;
  localDraftUpdatedAt: number;
  createdAt: number;
  attempts: number;
  lastError: string | null;
};

let cleanupStartedAt = 0;

export function connectionCacheKey(settings: ConnectionSettings): string {
  return `${settings.baseUrl.replace(/\/+$/u, "")}\0${tokenFingerprint(settings.token)}`;
}

export async function loadCachedMeta(settings: ConnectionSettings): Promise<CachedMeta | null> {
  return readValue<CachedMeta>(META_STORE, connectionCacheKey(settings));
}

export async function saveCachedMeta(
  settings: ConnectionSettings,
  snapshot: AppSnapshot | null,
  goals: Record<string, ThreadGoal | null>,
): Promise<void> {
  await writeValue(META_STORE, {
    key: connectionCacheKey(settings),
    snapshot,
    goals,
    updatedAt: Date.now(),
  });
}

export async function loadCachedThread(
  settings: ConnectionSettings,
  threadId: string,
): Promise<ThreadDetail | null> {
  const key = scopedKey(connectionCacheKey(settings), threadId);
  const cached = await readValue<CachedThread>(THREAD_STORE, key);
  if (!cached) return null;
  void writeValue(THREAD_STORE, { ...cached, accessedAt: Date.now() });
  return cached.detail;
}

export async function saveCachedThread(
  settings: ConnectionSettings,
  detail: ThreadDetail,
): Promise<void> {
  const connectionKey = connectionCacheKey(settings);
  const serialized = JSON.stringify(detail);
  await writeValue(THREAD_STORE, {
    key: scopedKey(connectionKey, detail.summary.id),
    connectionKey,
    threadId: detail.summary.id,
    detail,
    accessedAt: Date.now(),
    bytes: new Blob([serialized]).size,
  } satisfies CachedThread);
  void cleanupThreadCache();
}

export async function deleteCachedThread(
  settings: ConnectionSettings,
  threadId: string,
): Promise<void> {
  await deleteValue(THREAD_STORE, scopedKey(connectionCacheKey(settings), threadId));
}

export async function loadLocalDraft(
  settings: ConnectionSettings,
  threadId: string,
): Promise<LocalDraft | null> {
  return readValue<LocalDraft>(DRAFT_STORE, scopedKey(connectionCacheKey(settings), threadId));
}

export async function saveLocalDraft(
  settings: ConnectionSettings,
  threadId: string,
  value: UpdateThreadDraftRequest,
  updatedAt = Date.now(),
): Promise<LocalDraft> {
  const draft: LocalDraft = {
    key: scopedKey(connectionCacheKey(settings), threadId),
    connectionKey: connectionCacheKey(settings),
    threadId,
    value,
    updatedAt,
  };
  await writeValue(DRAFT_STORE, draft);
  return draft;
}

export async function deleteLocalDraft(
  settings: ConnectionSettings,
  threadId: string,
): Promise<void> {
  await deleteValue(DRAFT_STORE, scopedKey(connectionCacheKey(settings), threadId));
}

export async function confirmLocalDraft(
  settings: ConnectionSettings,
  threadId: string,
  confirmed: ThreadDraft | null,
  localUpdatedAt: number,
): Promise<void> {
  const current = await loadLocalDraft(settings, threadId);
  if (!current || current.updatedAt !== localUpdatedAt) return;
  if (
    confirmed &&
    (confirmed.input ||
      confirmed.images.length ||
      confirmed.goalMode ||
      confirmed.annotations.length)
  ) {
    await saveLocalDraft(settings, threadId, confirmed, confirmed.updatedAt);
    return;
  }
  await deleteValue(DRAFT_STORE, current.key);
}

export async function putOutboxMessage(message: OutboxMessage): Promise<boolean> {
  return writeValue(OUTBOX_STORE, message);
}

export async function listOutboxMessages(settings: ConnectionSettings): Promise<OutboxMessage[]> {
  return (await readAll<OutboxMessage>(OUTBOX_STORE))
    .filter((message) => message.connectionKey === connectionCacheKey(settings))
    .sort((left, right) => left.createdAt - right.createdAt);
}

export async function deleteOutboxMessage(id: string): Promise<void> {
  await deleteValue(OUTBOX_STORE, id);
}

export async function putPendingVoiceRecording(recording: PendingVoiceRecording): Promise<boolean> {
  return writeValue(RECORDING_STORE, recording);
}

export async function listPendingVoiceRecordings(
  settings: ConnectionSettings,
): Promise<PendingVoiceRecording[]> {
  return (await readAll<PendingVoiceRecording>(RECORDING_STORE))
    .filter((recording) => recording.connectionKey === connectionCacheKey(settings))
    .sort((left, right) => left.createdAt - right.createdAt);
}

export async function deletePendingVoiceRecording(id: string): Promise<void> {
  await deleteValue(RECORDING_STORE, id);
}

async function cleanupThreadCache(): Promise<void> {
  const now = Date.now();
  if (now - cleanupStartedAt < THREAD_CACHE_CLEANUP_INTERVAL_MS) return;
  cleanupStartedAt = now;
  const cached = await readAll<CachedThread>(THREAD_STORE);
  let total = cached.reduce((sum, entry) => sum + entry.bytes, 0);
  if (total <= THREAD_CACHE_LIMIT_BYTES) return;
  cached.sort((left, right) => left.accessedAt - right.accessedAt);
  for (const entry of cached) {
    if (total <= THREAD_CACHE_LIMIT_BYTES) break;
    await deleteValue(THREAD_STORE, entry.key);
    total -= entry.bytes;
  }
}

function scopedKey(connectionKey: string, id: string): string {
  return `${connectionKey}\0${id}`;
}

function tokenFingerprint(token: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < token.length; index += 1) {
    const code = token.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

async function openDatabase(): Promise<IDBDatabase | null> {
  if (!("indexedDB" in globalThis)) return null;
  return new Promise<IDBDatabase | null>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      for (const name of [META_STORE, THREAD_STORE, DRAFT_STORE, OUTBOX_STORE, RECORDING_STORE]) {
        if (!database.objectStoreNames.contains(name)) {
          database.createObjectStore(name, {
            keyPath: name === OUTBOX_STORE || name === RECORDING_STORE ? "id" : "key",
          });
        }
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
    request.addEventListener("blocked", () => resolve(null));
  }).catch(() => null);
}

async function readValue<T>(storeName: string, key: IDBValidKey): Promise<T | null> {
  const database = await openDatabase();
  if (!database) return null;
  try {
    return await new Promise<T | null>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readonly");
      const request = transaction.objectStore(storeName).get(key);
      request.addEventListener("success", () => resolve((request.result as T | undefined) ?? null));
      request.addEventListener("error", () => reject(request.error));
    });
  } catch {
    return null;
  } finally {
    database.close();
  }
}

async function readAll<T>(storeName: string): Promise<T[]> {
  const database = await openDatabase();
  if (!database) return [];
  try {
    return await new Promise<T[]>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readonly");
      const request = transaction.objectStore(storeName).getAll();
      request.addEventListener("success", () => resolve(request.result as T[]));
      request.addEventListener("error", () => reject(request.error));
    });
  } catch {
    return [];
  } finally {
    database.close();
  }
}

async function writeValue(storeName: string, value: object): Promise<boolean> {
  const database = await openDatabase();
  if (!database) return false;
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).put(value);
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("abort", () => reject(transaction.error));
      transaction.addEventListener("error", () => reject(transaction.error));
    });
    return true;
  } catch {
    // Offline persistence must never make the active UI fail.
    return false;
  } finally {
    database.close();
  }
}

async function deleteValue(storeName: string, key: IDBValidKey): Promise<void> {
  const database = await openDatabase();
  if (!database) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).delete(key);
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("abort", () => reject(transaction.error));
      transaction.addEventListener("error", () => reject(transaction.error));
    });
  } catch {
    // A later write or server sync can repair a failed cache deletion.
  } finally {
    database.close();
  }
}
