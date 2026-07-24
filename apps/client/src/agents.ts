import type { AgentId, AppSnapshot, BackendStatus, ModelOption } from "@codexnest/protocol";

/** User-facing agent names (Russian UI keeps these Latin brand names). */
export const AGENT_LABELS: Record<AgentId, string> = {
  codex: "Codex",
  claude: "Claude Code",
};

export function agentLabel(agent: AgentId): string {
  return AGENT_LABELS[agent] ?? agent;
}

/**
 * Per-backend status list. New servers populate `snapshot.backends`; older ones (and old
 * APKs) only carry the top-level connection/models, which are pinned to Codex — so we
 * synthesize a single Codex backend from them. Returns [] before the first snapshot.
 */
export function snapshotBackends(snapshot: AppSnapshot | null | undefined): BackendStatus[] {
  if (!snapshot) return [];
  if (snapshot.backends?.length) return snapshot.backends;
  return [{ agent: "codex", connection: snapshot.connection, models: snapshot.models }];
}

export function backendFor(
  snapshot: AppSnapshot | null | undefined,
  agent: AgentId,
): BackendStatus | undefined {
  return snapshotBackends(snapshot).find((backend) => backend.agent === agent);
}

/** Models offered by a given agent's backend (empty when the backend is absent). */
export function modelsForAgent(
  snapshot: AppSnapshot | null | undefined,
  agent: AgentId,
): ModelOption[] {
  return backendFor(snapshot, agent)?.models ?? [];
}

/** True once more than one backend is present — the trigger for dual-agent affordances. */
export function hasMultipleBackends(snapshot: AppSnapshot | null | undefined): boolean {
  return snapshotBackends(snapshot).length >= 2;
}

/** The agent selected by default on creation: Codex when available, else the first backend. */
export function defaultAgent(snapshot: AppSnapshot | null | undefined): AgentId {
  const backends = snapshotBackends(snapshot);
  return (
    backends.find((backend) => backend.agent === "codex")?.agent ?? backends[0]?.agent ?? "codex"
  );
}
