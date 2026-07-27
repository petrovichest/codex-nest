import type {
  ActivityItem,
  AppSnapshot,
  Project,
  QueuedMessage,
  ServerEvent,
  ThreadChanges,
  ThreadDetail,
  ThreadDraft,
  ThreadGoal,
  ThreadSummary,
  VoiceTranscriptionJob,
} from "@codexnest/protocol";

export interface ClientState {
  snapshot: AppSnapshot | null;
  details: Record<string, ThreadDetail>;
  expandedHistory: Record<string, boolean>;
  optimisticMessages: Record<string, OptimisticMessage[]>;
  goals: Record<string, ThreadGoal | null>;
  voiceRemovals: Record<string, { jobId: string; outcome: "draft" | "send" | "cancelled" }>;
  network: "connecting" | "connected" | "offline";
  error: string | null;
  snapshotEpoch: number;
}

export type OptimisticMessage = {
  id: string;
  threadId: string;
  text: string;
  images: string[];
  createdAt: number;
  destination: "turn" | "queue";
  turnId: string | null;
};

export type ClientAction =
  | { type: "network"; network: ClientState["network"]; error?: string | null }
  | {
      type: "hydrate";
      snapshot: AppSnapshot | null;
      goals: Record<string, ThreadGoal | null>;
    }
  | { type: "hydrate.detail"; detail: ThreadDetail }
  | { type: "snapshot"; snapshot: AppSnapshot }
  | { type: "event"; sequence: number; event: ServerEvent }
  | { type: "detail"; detail: ThreadDetail; page: "latest" | "older" | "reset" }
  | { type: "changes"; threadId: string; changes: ThreadChanges }
  | { type: "draft"; threadId: string; draft: ThreadDraft | null }
  | { type: "thread"; thread: ThreadSummary }
  | { type: "thread.remove"; threadId: string }
  | { type: "project.remove"; projectId: string; threadIds: string[] }
  | { type: "goal"; threadId: string; goal: ThreadGoal | null }
  | { type: "voice.accepted"; job: VoiceTranscriptionJob }
  | { type: "optimistic.add"; message: OptimisticMessage }
  | { type: "optimistic.accept"; threadId: string; messageId: string; turnId: string }
  | { type: "optimistic.remove"; threadId: string; messageId: string }
  | { type: "clear" };

export const initialState: ClientState = {
  snapshot: null,
  details: {},
  expandedHistory: {},
  optimisticMessages: {},
  goals: {},
  voiceRemovals: {},
  network: "connecting",
  error: null,
  snapshotEpoch: 0,
};

export function clientReducer(state: ClientState, action: ClientAction): ClientState {
  switch (action.type) {
    case "clear":
      return initialState;
    case "network":
      return { ...state, network: action.network, error: action.error ?? null };
    case "hydrate":
      return {
        ...state,
        snapshot: action.snapshot,
        goals: action.goals,
      };
    case "hydrate.detail":
      return applyDetail(state, action.detail, "latest");
    case "snapshot":
      return {
        ...state,
        snapshot: action.snapshot,
        network: "connected",
        error: null,
        snapshotEpoch: state.snapshotEpoch + 1,
      };
    case "detail":
      return applyDetail(state, action.detail, action.page);
    case "changes":
      return applyChanges(state, action.threadId, action.changes);
    case "draft": {
      const detail = state.details[action.threadId];
      if (!detail) return state;
      return {
        ...state,
        details: {
          ...state.details,
          [action.threadId]: { ...detail, draft: action.draft },
        },
      };
    }
    case "thread":
      return applyThreadSummary(state, action.thread);
    case "thread.remove":
      return removeThreadState(state, action.threadId);
    case "project.remove": {
      const snapshot = state.snapshot
        ? {
            ...state.snapshot,
            projects: state.snapshot.projects.filter((project) => project.id !== action.projectId),
          }
        : null;
      return action.threadIds.reduce((next, threadId) => removeThreadState(next, threadId), {
        ...state,
        snapshot,
      });
    }
    case "goal":
      return { ...state, goals: { ...state.goals, [action.threadId]: action.goal } };
    case "voice.accepted": {
      if (!state.snapshot) return state;
      if (state.voiceRemovals[action.job.threadId]?.jobId === action.job.id) return state;
      const voiceTranscriptions = state.snapshot.voiceTranscriptions ?? [];
      const current = voiceTranscriptions.find((job) => job.id === action.job.id);
      return {
        ...state,
        snapshot: {
          ...state.snapshot,
          voiceTranscriptions: upsert(voiceTranscriptions, current ?? action.job),
        },
        voiceRemovals: withoutKey(state.voiceRemovals, action.job.threadId),
      };
    }
    case "optimistic.add":
      if (isMessageConfirmed(state, action.message)) return state;
      return {
        ...state,
        optimisticMessages: {
          ...state.optimisticMessages,
          [action.message.threadId]: [
            ...(state.optimisticMessages[action.message.threadId] ?? []).filter(
              (message) => message.id !== action.message.id,
            ),
            action.message,
          ],
        },
      };
    case "optimistic.accept":
      return updateOptimisticMessage(state, action.threadId, action.messageId, (message) => ({
        ...message,
        turnId: action.turnId,
      }));
    case "optimistic.remove":
      return removeOptimisticMessage(state, action.threadId, action.messageId);
    case "event":
      if (!state.snapshot) return state;
      return applyEvent(state, action.sequence, action.event);
  }
}

function applyChanges(state: ClientState, threadId: string, changes: ThreadChanges): ClientState {
  const current = state.details[threadId];
  if (!current) {
    return applyDetail(
      state,
      {
        summary: changes.summary,
        turns: changes.turns,
        queuedMessages: changes.queuedMessages,
        olderTurnsCursor: changes.olderTurnsCursor,
        draft: changes.draft ?? null,
        syncPoint: changes.syncPoint,
      },
      "latest",
    );
  }
  const merged = mergeThreadDetailChanges(current, changes);
  return applyDetail(state, merged, changes.resetLatest ? "reset" : "latest");
}

export function mergeThreadDetailChanges(
  current: ThreadDetail,
  changes: ThreadChanges,
): ThreadDetail {
  let turns: ThreadDetail["turns"];
  let olderTurnsCursor = current.olderTurnsCursor;
  if (changes.resetLatest) {
    const incomingIds = new Set(changes.turns.map((turn) => turn.id));
    const overlap = current.turns.findIndex((turn) => incomingIds.has(turn.id));
    turns =
      overlap < 0 ? changes.turns : mergeTurns(current.turns.slice(0, overlap), changes.turns);
    const currentTurnId = changes.summary.currentTurnId;
    if (currentTurnId && !turns.some((turn) => turn.id === currentTurnId)) {
      const localCurrentTurn = current.turns.find((turn) => turn.id === currentTurnId);
      if (localCurrentTurn) turns = [...turns, localCurrentTurn];
    }
    if (overlap < 0) olderTurnsCursor = changes.olderTurnsCursor;
  } else {
    turns = mergeTurns(current.turns, changes.turns);
  }
  return {
    ...current,
    summary: changes.summary,
    turns,
    queuedMessages: changes.queuedMessages,
    draft: changes.draft ?? null,
    olderTurnsCursor,
    syncPoint: changes.resetLatest
      ? changes.syncPoint
      : (changes.syncPoint ?? current.syncPoint ?? null),
  };
}

function applyEvent(state: ClientState, sequence: number, event: ServerEvent): ClientState {
  const snapshot = { ...state.snapshot!, sequence };
  switch (event.type) {
    case "connection.changed":
      snapshot.connection = event.connection;
      break;
    case "project.upserted":
      snapshot.projects = upsert(snapshot.projects, event.project);
      break;
    case "projects.reordered":
      snapshot.projects = event.projects;
      break;
    case "project.removed":
      snapshot.projects = snapshot.projects.filter((project) => project.id !== event.projectId);
      break;
    case "thread.upserted":
      snapshot.threads = sortThreads(upsert(snapshot.threads, event.thread));
      return applyThreadSummary({ ...state, snapshot }, event.thread);
    case "thread.removed":
      return removeThreadState({ ...state, snapshot }, event.threadId);
    case "attention.upserted":
      snapshot.attention = upsert(snapshot.attention, event.attention);
      break;
    case "attention.removed":
      snapshot.attention = snapshot.attention.filter((item) => item.id !== event.attentionId);
      break;
    case "models.changed":
      snapshot.models = event.models;
      break;
    case "defaultReasoningEffort.changed":
      snapshot.defaultReasoningEffort = event.reasoningEffort ?? undefined;
      break;
    case "taskDefaults.changed":
      snapshot.taskDefaults = event.taskDefaults;
      break;
    case "uiLanguage.changed":
      snapshot.uiLanguage = event.language;
      break;
    case "goal.changed":
      return {
        ...state,
        snapshot,
        goals: { ...state.goals, [event.threadId]: event.goal },
      };
    case "voiceTranscription.upserted":
      snapshot.voiceTranscriptions = upsert(snapshot.voiceTranscriptions ?? [], event.job);
      return {
        ...state,
        snapshot,
        voiceRemovals: withoutKey(state.voiceRemovals, event.job.threadId),
      };
    case "voiceTranscription.removed":
      snapshot.voiceTranscriptions = (snapshot.voiceTranscriptions ?? []).filter(
        (job) => job.threadId !== event.threadId,
      );
      return {
        ...state,
        snapshot,
        voiceRemovals: {
          ...state.voiceRemovals,
          [event.threadId]: { jobId: event.jobId, outcome: event.outcome },
        },
      };
    case "activity.upserted":
      return removeOptimisticMessage(
        applyActivity({ ...state, snapshot }, event.threadId, event.turnId, event.item),
        event.threadId,
        event.item.id,
      );
    case "turn.progressed":
      return applyProgress({ ...state, snapshot }, event.threadId, event.turnId, event.progress);
    case "queue.changed":
      return removeConfirmedQueuedMessages(
        applyQueue({ ...state, snapshot }, event.threadId, event.messages),
        event.threadId,
        event.messages,
      );
    case "resync.required":
      return { ...state, snapshot, snapshotEpoch: state.snapshotEpoch + 1 };
  }
  return { ...state, snapshot };
}

function removeThreadState(state: ClientState, threadId: string): ClientState {
  return {
    ...state,
    snapshot: state.snapshot
      ? {
          ...state.snapshot,
          threads: state.snapshot.threads.filter((thread) => thread.id !== threadId),
          voiceTranscriptions: (state.snapshot.voiceTranscriptions ?? []).filter(
            (job) => job.threadId !== threadId,
          ),
        }
      : null,
    details: withoutKey(state.details, threadId),
    expandedHistory: withoutKey(state.expandedHistory, threadId),
    optimisticMessages: withoutKey(state.optimisticMessages, threadId),
    goals: Object.fromEntries(
      Object.entries(state.goals).filter(([candidateId]) => candidateId !== threadId),
    ),
    voiceRemovals: withoutKey(state.voiceRemovals, threadId),
  };
}

function applyDetail(
  state: ClientState,
  detail: ThreadDetail,
  page: "latest" | "older" | "reset",
): ClientState {
  const threadId = detail.summary.id;
  const current = state.details[threadId];
  const expanded = state.expandedHistory[threadId] ?? false;
  const subagent = detail.summary.relation.kind === "subagent";
  const merged = current
    ? page === "reset"
      ? detail
      : {
          ...detail,
          turns: subagent
            ? page === "older"
              ? current.turns
              : detail.turns
            : page === "older"
              ? mergeTurns(detail.turns, current.turns)
              : mergeTurns(current.turns, detail.turns),
          olderTurnsCursor: subagent
            ? null
            : page === "latest" && expanded
              ? current.olderTurnsCursor
              : detail.olderTurnsCursor,
        }
    : subagent
      ? { ...detail, olderTurnsCursor: null }
      : detail;
  const confirmedUserIds = userMessageIds(merged);
  const reconciled = {
    ...merged,
    queuedMessages: merged.queuedMessages.filter((message) => !confirmedUserIds.has(message.id)),
  };
  const confirmedIds = new Set([
    ...confirmedUserIds,
    ...reconciled.queuedMessages.map((message) => message.id),
  ]);
  return {
    ...state,
    details: { ...state.details, [threadId]: reconciled },
    expandedHistory: subagent
      ? { ...state.expandedHistory, [threadId]: false }
      : page === "older"
        ? { ...state.expandedHistory, [threadId]: true }
        : page === "reset"
          ? { ...state.expandedHistory, [threadId]: false }
          : state.expandedHistory,
    optimisticMessages: setOptimisticMessages(
      state.optimisticMessages,
      threadId,
      (state.optimisticMessages[threadId] ?? []).filter((message) => !confirmedIds.has(message.id)),
    ),
  };
}

function applyThreadSummary(state: ClientState, thread: ThreadSummary): ClientState {
  if (!state.snapshot) return state;
  const detail = state.details[thread.id];
  return {
    ...state,
    snapshot: {
      ...state.snapshot,
      threads: sortThreads(upsert(state.snapshot.threads, thread)),
    },
    details: detail
      ? { ...state.details, [thread.id]: { ...detail, summary: thread } }
      : state.details,
  };
}

function applyActivity(
  state: ClientState,
  threadId: string,
  turnId: string,
  item: ActivityItem,
): ClientState {
  const detail = detailForEvent(state, threadId);
  if (!detail) return state;
  const turns = [...detail.turns];
  const index = turns.findIndex((turn) => turn.id === turnId);
  if (index < 0) {
    turns.push({
      id: turnId,
      status: "inProgress",
      startedAt: item.type === "userMessage" ? item.timestamp : null,
      completedAt: null,
      durationMs: null,
      progress: emptyProgress(),
      items: [item],
    });
  } else {
    const turn = turns[index];
    turns[index] = { ...turn, items: upsertActivity(turn.items, item) };
  }
  const queuedMessages =
    item.type === "userMessage"
      ? detail.queuedMessages.filter((message) => message.id !== item.id)
      : detail.queuedMessages;
  return {
    ...state,
    details: { ...state.details, [threadId]: { ...detail, turns, queuedMessages } },
  };
}

function upsertActivity(items: ActivityItem[], item: ActivityItem): ActivityItem[] {
  const existing = items.findIndex((candidate) => candidate.id === item.id);
  if (existing >= 0) {
    const next = [...items];
    next[existing] = fresherActivity(next[existing]!, item);
    return next;
  }
  if (item.type !== "userInputResponse" && item.type !== "planChecklist") {
    const anchoredArtifact = items.findIndex(
      (candidate) =>
        (candidate.type === "userInputResponse" || candidate.type === "planChecklist") &&
        candidate.afterItemId === item.id,
    );
    const insertion =
      anchoredArtifact >= 0 ? anchoredArtifact : chronologicalActivityPosition(items, item);
    if (insertion === items.length) return [...items, item];
    const next = [...items];
    next.splice(insertion, 0, item);
    return next;
  }
  const anchor = item.afterItemId
    ? items.findIndex((candidate) => candidate.id === item.afterItemId)
    : -1;
  let insertion = anchor >= 0 ? anchor + 1 : fallbackActivityPosition(items, item.type);
  while (insertion < items.length) {
    const candidate = items[insertion];
    if (
      !candidate ||
      (candidate.type !== "userInputResponse" && candidate.type !== "planChecklist") ||
      candidate.afterItemId !== item.afterItemId
    ) {
      break;
    }
    insertion += 1;
  }
  const next = [...items];
  next.splice(insertion, 0, item);
  return next;
}

function chronologicalActivityPosition(items: ActivityItem[], item: ActivityItem): number {
  if (!("timestamp" in item) || item.timestamp === null) return items.length;
  const timestamp = item.timestamp;
  const later = items.findIndex(
    (candidate) =>
      "timestamp" in candidate && candidate.timestamp !== null && candidate.timestamp > timestamp,
  );
  return later < 0 ? items.length : later;
}

function fallbackActivityPosition(
  items: ActivityItem[],
  type: "userInputResponse" | "planChecklist",
): number {
  if (type === "userInputResponse") {
    const finalResponse = items.findIndex(
      (item) =>
        item.type === "plan" || (item.type === "agentMessage" && item.phase === "final_answer"),
    );
    if (finalResponse >= 0) return finalResponse;
    return items.length;
  }
  let insertion = 0;
  while (items[insertion]?.type === "userMessage") insertion += 1;
  return insertion;
}

function applyProgress(
  state: ClientState,
  threadId: string,
  turnId: string,
  progress: ThreadDetail["turns"][number]["progress"],
): ClientState {
  const detail = detailForEvent(state, threadId);
  if (!detail) return state;
  const turns = [...detail.turns];
  const index = turns.findIndex((turn) => turn.id === turnId);
  if (index < 0) {
    turns.push({
      id: turnId,
      status: "inProgress",
      startedAt: progress.startedAt,
      completedAt: null,
      durationMs: null,
      progress,
      items: [],
    });
  } else {
    turns[index] = { ...turns[index], progress };
  }
  return { ...state, details: { ...state.details, [threadId]: { ...detail, turns } } };
}

function applyQueue(
  state: ClientState,
  threadId: string,
  queuedMessages: QueuedMessage[],
): ClientState {
  const detail = detailForEvent(state, threadId);
  if (!detail) return state;
  const confirmedIds = userMessageIds(detail);
  return {
    ...state,
    details: {
      ...state.details,
      [threadId]: {
        ...detail,
        queuedMessages: queuedMessages.filter((message) => !confirmedIds.has(message.id)),
      },
    },
  };
}

function detailForEvent(state: ClientState, threadId: string): ThreadDetail | undefined {
  const existing = state.details[threadId];
  if (existing) return existing;
  const summary = state.snapshot?.threads.find((thread) => thread.id === threadId);
  return summary ? { summary, turns: [], queuedMessages: [], olderTurnsCursor: null } : undefined;
}

function mergeTurns(
  first: ThreadDetail["turns"],
  second: ThreadDetail["turns"],
): ThreadDetail["turns"] {
  const result = [...first];
  for (const turn of second) {
    const index = result.findIndex((candidate) => candidate.id === turn.id);
    if (index < 0) result.push(turn);
    else result[index] = mergeTurn(result[index]!, turn);
  }
  return result;
}

function mergeTurn(
  current: ThreadDetail["turns"][number],
  incoming: ThreadDetail["turns"][number],
): ThreadDetail["turns"][number] {
  const preserveTerminal = current.status !== "inProgress" && incoming.status === "inProgress";
  return {
    ...incoming,
    ...(preserveTerminal
      ? {
          status: current.status,
          completedAt: current.completedAt,
          durationMs: current.durationMs,
        }
      : {}),
    items: mergeActivityItems(current.items, incoming.items),
  };
}

function mergeActivityItems(current: ActivityItem[], incoming: ActivityItem[]): ActivityItem[] {
  let result = [...current];
  const incomingIds = new Set(incoming.map((item) => item.id));
  for (const [itemIndex, item] of incoming.entries()) {
    const existing = result.findIndex((candidate) => candidate.id === item.id);
    if (existing >= 0) {
      let semanticAlias = -1;
      for (let candidateIndex = existing - 1; candidateIndex >= 0; candidateIndex -= 1) {
        const candidate = result[candidateIndex]!;
        if (candidate.type === "userInputResponse" || candidate.type === "planChecklist") continue;
        if (
          !incomingIds.has(candidate.id) &&
          sameRenderedActivity(
            candidate,
            item,
            candidate.status === "inProgress" || item.status === "inProgress",
          )
        ) {
          semanticAlias = candidateIndex;
        }
        break;
      }
      const canonical = fresherActivity(result[existing]!, item);
      if (semanticAlias >= 0) {
        const aliasId = result[semanticAlias]!.id;
        result[semanticAlias] = {
          ...fresherActivity(result[semanticAlias]!, canonical),
          id: item.id,
        } as ActivityItem;
        result = remapArtifactAnchors(result, aliasId, item.id);
        result.splice(existing, 1);
      } else {
        result[existing] = canonical;
      }
      continue;
    }
    const semanticMatch = result.findIndex(
      (candidate) =>
        !incomingIds.has(candidate.id) &&
        sameRenderedActivity(
          candidate,
          item,
          candidate.status === "inProgress" || item.status === "inProgress",
        ),
    );
    if (semanticMatch >= 0) {
      const aliasId = result[semanticMatch]!.id;
      result[semanticMatch] = {
        ...fresherActivity(result[semanticMatch]!, item),
        id: item.id,
      } as ActivityItem;
      result = remapArtifactAnchors(result, aliasId, item.id);
      continue;
    }
    if (item.type === "userInputResponse" || item.type === "planChecklist") {
      result = upsertActivity(result, item);
      continue;
    }
    const anchoredArtifact = result.findIndex(
      (candidate) =>
        (candidate.type === "userInputResponse" || candidate.type === "planChecklist") &&
        candidate.afterItemId === item.id,
    );
    const nextIncomingId = incoming
      .slice(itemIndex + 1)
      .find((candidate) => result.some((existingItem) => existingItem.id === candidate.id))?.id;
    const nextIncoming = nextIncomingId
      ? result.findIndex((candidate) => candidate.id === nextIncomingId)
      : -1;
    const insertion =
      anchoredArtifact >= 0 ? anchoredArtifact : nextIncoming >= 0 ? nextIncoming : result.length;
    result.splice(insertion, 0, item);
  }
  return result;
}

function remapArtifactAnchors(
  items: ActivityItem[],
  previousId: string,
  canonicalId: string,
): ActivityItem[] {
  return items.map((candidate) =>
    (candidate.type === "userInputResponse" || candidate.type === "planChecklist") &&
    candidate.afterItemId === previousId
      ? { ...candidate, afterItemId: canonicalId }
      : candidate,
  );
}

function fresherActivity(current: ActivityItem, incoming: ActivityItem): ActivityItem {
  if (current.status !== "inProgress" && incoming.status === "inProgress") return current;
  if (
    current.type === incoming.type &&
    "text" in current &&
    "text" in incoming &&
    current.text.startsWith(incoming.text) &&
    current.text.length > incoming.text.length
  ) {
    return { ...incoming, text: current.text } as ActivityItem;
  }
  if (
    current.type === "command" &&
    incoming.type === "command" &&
    current.output.startsWith(incoming.output) &&
    current.output.length > incoming.output.length
  ) {
    return { ...incoming, output: current.output };
  }
  return incoming;
}

function sameRenderedActivity(
  first: ActivityItem,
  second: ActivityItem,
  allowPrefix: boolean,
): boolean {
  if (
    first.type !== second.type ||
    !["agentMessage", "reasoning", "plan"].includes(first.type) ||
    !("text" in first) ||
    !("text" in second)
  ) {
    return false;
  }
  const compatiblePhase =
    first.phase === second.phase || first.phase === null || second.phase === null;
  if (!compatiblePhase) return false;
  if (first.text === second.text) return true;
  return (
    allowPrefix &&
    Boolean(first.text && second.text) &&
    (first.text.startsWith(second.text) || second.text.startsWith(first.text))
  );
}

function updateOptimisticMessage(
  state: ClientState,
  threadId: string,
  messageId: string,
  update: (message: OptimisticMessage) => OptimisticMessage,
): ClientState {
  const messages = state.optimisticMessages[threadId] ?? [];
  if (!messages.some((message) => message.id === messageId)) return state;
  return {
    ...state,
    optimisticMessages: setOptimisticMessages(
      state.optimisticMessages,
      threadId,
      messages.map((message) => (message.id === messageId ? update(message) : message)),
    ),
  };
}

function removeOptimisticMessage(
  state: ClientState,
  threadId: string,
  messageId: string,
): ClientState {
  const messages = state.optimisticMessages[threadId] ?? [];
  if (!messages.some((message) => message.id === messageId)) return state;
  return {
    ...state,
    optimisticMessages: setOptimisticMessages(
      state.optimisticMessages,
      threadId,
      messages.filter((message) => message.id !== messageId),
    ),
  };
}

function removeConfirmedQueuedMessages(
  state: ClientState,
  threadId: string,
  messages: QueuedMessage[],
): ClientState {
  const confirmedIds = new Set(messages.map((message) => message.id));
  if (!confirmedIds.size) return state;
  const optimistic = state.optimisticMessages[threadId] ?? [];
  return {
    ...state,
    optimisticMessages: setOptimisticMessages(
      state.optimisticMessages,
      threadId,
      optimistic.filter((message) => !confirmedIds.has(message.id)),
    ),
  };
}

function setOptimisticMessages(
  all: ClientState["optimisticMessages"],
  threadId: string,
  messages: OptimisticMessage[],
): ClientState["optimisticMessages"] {
  if (messages.length) return { ...all, [threadId]: messages };
  return withoutKey(all, threadId);
}

function isMessageConfirmed(state: ClientState, message: OptimisticMessage): boolean {
  const detail = state.details[message.threadId];
  if (!detail) return false;
  return (
    detail.queuedMessages.some((candidate) => candidate.id === message.id) ||
    userMessageIds(detail).has(message.id)
  );
}

function userMessageIds(detail: ThreadDetail): Set<string> {
  return new Set(
    detail.turns.flatMap((turn) =>
      turn.items.filter((item) => item.type === "userMessage").map((item) => item.id),
    ),
  );
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

function emptyProgress(): ThreadDetail["turns"][number]["progress"] {
  return {
    startedAt: null,
    explanation: null,
    steps: [],
    filesChanged: 0,
    additions: 0,
    deletions: 0,
  };
}

function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

export function sortThreads(threads: ThreadSummary[]): ThreadSummary[] {
  return [...threads].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function groupedThreads(
  projects: Project[],
  threads: ThreadSummary[],
): Array<{ project: Project | null; threads: ThreadSummary[] }> {
  return [
    ...projects.map((project) => ({
      project,
      threads: threads.filter((thread) => thread.projectId === project.id),
    })),
    { project: null, threads: threads.filter((thread) => !thread.projectId) },
  ].filter((group) => group.project || group.threads.length);
}
