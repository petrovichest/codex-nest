import type { ClaudeSessionState, StateStore } from "../state/store";

/** Creates or replaces the registry entry for a Claude thread. */
export async function upsertClaudeSession(
  store: StateStore,
  threadId: string,
  entry: ClaudeSessionState,
): Promise<void> {
  await store.update((state) => {
    state.claudeSessions ??= {};
    state.claudeSessions[threadId] = entry;
  });
}

/** Applies a partial update to an existing entry; no-op if the entry is gone. */
export async function patchClaudeSession(
  store: StateStore,
  threadId: string,
  patch: Partial<ClaudeSessionState>,
): Promise<void> {
  await store.update((state) => {
    const current = state.claudeSessions?.[threadId];
    if (!current) return;
    state.claudeSessions![threadId] = { ...current, ...patch };
  });
}

/** Removes a Claude thread's registry entry. */
export async function deleteClaudeSession(store: StateStore, threadId: string): Promise<void> {
  await store.update((state) => {
    if (state.claudeSessions) delete state.claudeSessions[threadId];
  });
}
