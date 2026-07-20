import type {
  ActivityItem,
  AppSnapshot,
  Project,
  ServerEvent,
  ThreadDetail,
  ThreadSummary,
} from "@codexnest/protocol";

export interface ClientState {
  snapshot: AppSnapshot | null;
  details: Record<string, ThreadDetail>;
  network: "connecting" | "connected" | "offline";
  error: string | null;
  snapshotEpoch: number;
}

export type ClientAction =
  | { type: "network"; network: ClientState["network"]; error?: string | null }
  | { type: "snapshot"; snapshot: AppSnapshot }
  | { type: "event"; sequence: number; event: ServerEvent }
  | { type: "detail"; detail: ThreadDetail }
  | { type: "clear" };

export const initialState: ClientState = {
  snapshot: null,
  details: {},
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
    case "snapshot":
      return {
        ...state,
        snapshot: action.snapshot,
        network: "connected",
        error: null,
        snapshotEpoch: state.snapshotEpoch + 1,
      };
    case "detail":
      return {
        ...state,
        details: { ...state.details, [action.detail.summary.id]: action.detail },
      };
    case "event":
      if (!state.snapshot) return state;
      return applyEvent(state, action.sequence, action.event);
  }
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
    case "project.removed":
      snapshot.projects = snapshot.projects.filter((project) => project.id !== event.projectId);
      break;
    case "thread.upserted":
      snapshot.threads = sortThreads(upsert(snapshot.threads, event.thread));
      break;
    case "thread.removed":
      snapshot.threads = snapshot.threads.filter((thread) => thread.id !== event.threadId);
      break;
    case "attention.upserted":
      snapshot.attention = upsert(snapshot.attention, event.attention);
      break;
    case "attention.removed":
      snapshot.attention = snapshot.attention.filter((item) => item.id !== event.attentionId);
      break;
    case "models.changed":
      snapshot.models = event.models;
      break;
    case "activity.upserted":
      return applyActivity({ ...state, snapshot }, event.threadId, event.turnId, event.item);
    case "resync.required":
      break;
  }
  return { ...state, snapshot };
}

function applyActivity(
  state: ClientState,
  threadId: string,
  turnId: string,
  item: ActivityItem,
): ClientState {
  const detail = state.details[threadId];
  if (!detail) return state;
  const turns = [...detail.turns];
  const index = turns.findIndex((turn) => turn.id === turnId);
  if (index < 0) {
    turns.push({ id: turnId, status: "inProgress", items: [item] });
  } else {
    const turn = turns[index];
    turns[index] = { ...turn, items: upsert(turn.items, item) };
  }
  return { ...state, details: { ...state.details, [threadId]: { ...detail, turns } } };
}

function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

export function sortThreads(threads: ThreadSummary[]): ThreadSummary[] {
  return [...threads].sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
}

function rank(thread: ThreadSummary): number {
  if (thread.state === "needsAttention") return 0;
  if (thread.state === "running") return 1;
  if (thread.unread && ["completed", "failed", "interrupted"].includes(thread.state)) return 2;
  if (thread.pinned) return 3;
  return 4;
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
