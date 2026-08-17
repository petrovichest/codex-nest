import type {
  AppSnapshot,
  ForkEstimateResponse,
  ForkMode,
  ForkModeEstimate,
  ForkOperationStatus,
  ForkOperationSummary,
  ForkTimeEstimate,
  QueuedMessage,
  ThreadDraft,
} from "@codexnest/protocol";

export type {
  ForkEstimateResponse,
  ForkMode,
  ForkModeEstimate,
  ForkOperationStatus,
  ForkOperationSummary,
  ForkTimeEstimate,
};

export type ForkOperationDetail = {
  operation: ForkOperationSummary;
  queuedMessages: QueuedMessage[];
  draft: ThreadDraft | null;
};

type SnapshotWithForks = AppSnapshot & { forkOperations?: ForkOperationSummary[] };

export function forkOperationsFromSnapshot(snapshot: AppSnapshot | null): ForkOperationSummary[] {
  return (snapshot as SnapshotWithForks | null)?.forkOperations ?? [];
}

export function withForkOperations(
  snapshot: AppSnapshot,
  forkOperations: ForkOperationSummary[],
): AppSnapshot {
  return { ...snapshot, forkOperations } as SnapshotWithForks;
}

export function normalizeForkOperationDetail(
  response:
    | ForkOperationSummary
    | ForkOperationDetail
    | {
        operation: ForkOperationSummary;
        queuedMessages?: QueuedMessage[];
        draft?: ThreadDraft | null;
      },
): ForkOperationDetail {
  if ("operation" in response) {
    return {
      operation: response.operation,
      queuedMessages: response.queuedMessages ?? [],
      draft: response.draft ?? null,
    };
  }
  return { operation: response, queuedMessages: [], draft: null };
}

export function upsertForkOperation(
  operations: ForkOperationSummary[],
  operation: ForkOperationSummary,
): ForkOperationSummary[] {
  const index = operations.findIndex((candidate) => candidate.id === operation.id);
  if (index < 0) return [...operations, operation];
  const next = [...operations];
  next[index] = operation;
  return next;
}
