import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import type { Turn } from "./codex/generated/v2/index";
import type { TimelineArtifact } from "./state/store";

/** Recover ordering omitted by app-server: quiz anchors and revisions of a reused plan ID. */
export async function recoverTimelineOrder(
  path: string | null,
  turns: Turn[],
  artifacts: Record<string, TimelineArtifact[]>,
): Promise<void> {
  if (!path) return;
  const missing = new Map<string, { turnId: string; artifact: TimelineArtifact }>();
  const messageIds = new Map<string, Map<string, string>>();
  const plans = new Map<
    string,
    {
      turn: Turn;
      item: Extract<Turn["items"][number], { type: "plan" }>;
      afterId?: string;
    }
  >();
  for (const turn of turns) {
    const planItems = turn.items.filter((item) => item.type === "plan");
    const plan = planItems.length === 1 ? planItems[0] : undefined;
    if (
      turn.status !== "inProgress" &&
      plan &&
      turn.items
        .slice(turn.items.indexOf(plan) + 1)
        .some((item) => item.type === "userMessage" || item.type === "agentMessage")
    ) {
      plans.set(turn.id, { turn, item: plan });
    }
    const ids = new Set(
      turn.items.flatMap((item) =>
        item.type === "userMessage" ? [item.id, item.clientId ?? item.id] : [item.id],
      ),
    );
    messageIds.set(
      turn.id,
      new Map(
        turn.items.flatMap((item) =>
          item.type === "userMessage" || item.type === "agentMessage" || item.type === "plan"
            ? [[item.id, item.type === "userMessage" ? (item.clientId ?? item.id) : item.id]]
            : [],
        ),
      ),
    );
    for (const artifact of artifacts[turn.id] ?? []) {
      if (
        artifact.type === "userInputResponse" &&
        artifact.afterItemId &&
        artifact.id === `${artifact.afterItemId}-response` &&
        !ids.has(artifact.afterItemId)
      ) {
        missing.set(artifact.afterItemId, { turnId: turn.id, artifact });
      }
    }
  }
  if (!missing.size && !plans.size) return;

  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let activeTurnId: string | null = null;
  const preceding = new Map<string, string>();
  try {
    for await (const line of lines) {
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        // An active rollout may end with a partially written record.
        preceding.clear();
        continue;
      }
      if (!isRecord(entry) || !isRecord(entry.payload)) continue;
      const payload = entry.payload;
      if (
        (entry.type === "turn_context" ||
          (entry.type === "event_msg" && payload.type === "task_started")) &&
        typeof payload.turn_id === "string"
      ) {
        activeTurnId = payload.turn_id;
      }
      if (entry.type !== "response_item") continue;
      const metadata = payload.internal_chat_message_metadata_passthrough;
      const turnId =
        isRecord(metadata) && typeof metadata.turn_id === "string"
          ? metadata.turn_id
          : activeTurnId;
      if (!turnId) continue;
      const plan = plans.get(turnId);
      if (plan && payload.type === "message") {
        const text = messageText(payload.content);
        if (payload.role === "assistant" && proposedPlan(text) === plan.item.text.trim()) {
          // The daemon projects all revisions as `${turnId}-plan` at the first
          // revision's position. Only the last matching response owns its position.
          plan.afterId = preceding.get(turnId);
          continue;
        }
        const exact =
          typeof payload.id === "string" ? messageIds.get(turnId)?.get(payload.id) : undefined;
        const users =
          payload.role === "user" && text
            ? plan.turn.items.filter(
                (item) => item.type === "userMessage" && messageText(item.content) === text,
              )
            : [];
        const user = users.length === 1 ? users[0] : undefined;
        const anchor =
          exact ?? (user?.type === "userMessage" ? (user.clientId ?? user.id) : undefined);
        if (anchor) preceding.set(turnId, anchor);
        else preceding.delete(turnId);
      }
      const messageId =
        typeof payload.id === "string" ? messageIds.get(turnId)?.get(payload.id) : undefined;
      if (payload.type === "message" && messageId) preceding.set(turnId, messageId);
      if (payload.type !== "function_call_output" || typeof payload.call_id !== "string") {
        continue;
      }
      const target = missing.get(payload.call_id);
      const anchor = preceding.get(turnId);
      if (!target || target.turnId !== turnId || !anchor) continue;
      target.artifact.afterItemId = anchor;
      // Old records could be timestamped only after slow draft persistence finished.
      const timestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
      if (Number.isFinite(timestamp)) target.artifact.timestamp = timestamp;
      missing.delete(payload.call_id);
      if (!missing.size && !plans.size) break;
    }
  } catch {
    // Missing/unreadable legacy journals must not prevent loading the conversation.
  } finally {
    lines.close();
    input.destroy();
  }
  for (const { turn, item, afterId } of plans.values()) {
    if (!afterId || afterId === item.id) continue;
    const anchor = turn.items.find(
      (candidate) =>
        candidate.id === afterId ||
        (candidate.type === "userMessage" && candidate.clientId === afterId),
    );
    if (!anchor) continue;
    turn.items.splice(turn.items.indexOf(item), 1);
    turn.items.splice(turn.items.indexOf(anchor) + 1, 0, item);
  }
}

function messageText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .filter(isRecord)
    .map((item) => (typeof item.text === "string" ? item.text : ""))
    .join("")
    .trim();
}

function proposedPlan(text: string): string | undefined {
  return /^\s*<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>\s*$/.exec(text)?.[1]?.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
