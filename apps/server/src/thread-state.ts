import { RpcError } from "./codex/transport";
import type { StateStore } from "./state/store";

const MISSING_THREAD_ERROR = /thread not loaded|missing thread|not found|unknown thread|does not exist/i;

export function isMissingThreadError(error: unknown): boolean {
  return error instanceof RpcError && MISSING_THREAD_ERROR.test(error.message);
}

export async function removeThreadState(store: StateStore, threadId: string): Promise<void> {
  await store.update((state) => {
    delete state.threadMeta[threadId];

    if (state.messageQueues) {
      delete state.messageQueues[threadId];
    }

    for (const [messageId, receipt] of Object.entries(state.messageReceipts ?? {})) {
      if (receipt.threadId === threadId) delete state.messageReceipts![messageId];
    }

    if (state.voiceTranscriptions) {
      delete state.voiceTranscriptions[threadId];
    }

    for (const [jobId, receipt] of Object.entries(state.voiceReceipts ?? {})) {
      if (receipt.threadId === threadId) delete state.voiceReceipts![jobId];
    }

    for (const [operationId, operation] of Object.entries(state.teamToolOperations ?? {})) {
      if (operation.threadId === threadId) delete state.teamToolOperations![operationId];
    }
  });
}
