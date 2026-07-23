import type { SessionSettings, ThreadDraft, UpdateThreadDraftRequest } from "@codexnest/protocol";

import type { CodexNestState, StateStore, ThreadMetaState } from "../state/store";

function ensureMeta(state: CodexNestState, threadId: string): ThreadMetaState {
  return (state.threadMeta[threadId] ??= { pinned: false, lastReadUpdatedAt: 0 });
}

export async function markThreadRead(
  store: StateStore,
  threadId: string,
  safeObserved: number,
): Promise<void> {
  await store.update((state) => {
    const meta = ensureMeta(state, threadId);
    meta.lastReadUpdatedAt = Math.max(meta.lastReadUpdatedAt, safeObserved);
    state.threadMeta[threadId] = meta;
  });
}

export async function markThreadViewed(
  store: StateStore,
  threadId: string,
  safeObserved: number,
): Promise<void> {
  await store.update((state) => {
    const meta = ensureMeta(state, threadId);
    meta.lastViewedUpdatedAt = Math.max(meta.lastViewedUpdatedAt ?? 0, safeObserved);
    state.threadMeta[threadId] = meta;
  });
}

export async function setThreadPinned(
  store: StateStore,
  threadId: string,
  pinned: boolean,
): Promise<void> {
  await store.update((state) => {
    const meta = ensureMeta(state, threadId);
    meta.pinned = pinned;
    state.threadMeta[threadId] = meta;
  });
}

export async function setThreadSettings(
  store: StateStore,
  threadId: string,
  settings: SessionSettings,
): Promise<void> {
  await store.update((state) => {
    const meta = ensureMeta(state, threadId);
    meta.settings = settings;
    state.threadMeta[threadId] = meta;
  });
}

export async function setThreadDraft(
  store: StateStore,
  threadId: string,
  value: UpdateThreadDraftRequest,
): Promise<ThreadDraft | null> {
  const empty =
    value.input === "" &&
    value.images.length === 0 &&
    !value.goalMode &&
    value.annotations.length === 0;
  let draft: ThreadDraft | null = null;
  await store.update((state) => {
    const meta = ensureMeta(state, threadId);
    if (empty) {
      delete meta.draft;
    } else {
      draft = { ...structuredClone(value), updatedAt: Date.now() };
      meta.draft = draft;
    }
    state.threadMeta[threadId] = meta;
  });
  return draft;
}

export async function deleteThreadMeta(store: StateStore, threadId: string): Promise<void> {
  await store.update((state) => {
    delete state.threadMeta[threadId];
  });
}
