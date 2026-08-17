import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";

import type { ForkEstimateResponse, ForkModeEstimate } from "@codexnest/protocol";

export interface ForkRolloutAnalysis {
  estimate: ForkEstimateResponse;
  compressedItems: Record<string, unknown>[] | null;
  forkPointValidation: "valid" | "invalid" | "unknown";
}

export const FORK_MATERIALIZATION_MARKER_KEY = "codexnest_fork_operation_id";

export function freshCompressedForkEstimate(): ForkModeEstimate {
  return available(null, { minSeconds: 60, maxSeconds: 600 });
}

const RESPONSE_ITEM_TYPES = new Set([
  "message",
  "agent_message",
  "reasoning",
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "tool_search_call",
  "tool_search_output",
  "web_search_call",
  "computer_call",
  "computer_call_output",
  "local_shell_call",
  "local_shell_call_output",
  "mcp_call",
  "mcp_list_tools",
  "mcp_approval_request",
  "mcp_approval_response",
  "image_generation_call",
  "compaction",
  "compaction_trigger",
  "context_compaction",
]);

export async function analyzeForkRollout(
  path: string | null,
  lastTurnId: string,
  agentMessageId?: string,
): Promise<ForkRolloutAnalysis> {
  if (!path) {
    return {
      estimate: {
        sourceBytes: null,
        compressed: unavailable("The source rollout path is not available"),
        exact: available(null, { minSeconds: 30, maxSeconds: 180 }),
      },
      compressedItems: null,
      forkPointValidation: "unknown",
    };
  }

  let sourceBytes: number;
  try {
    sourceBytes = (await stat(path)).size;
  } catch {
    return {
      estimate: {
        sourceBytes: null,
        compressed: unavailable("The source rollout cannot be read"),
        exact: available(null, { minSeconds: 30, maxSeconds: 180 }),
      },
      compressedItems: null,
      forkPointValidation: "unknown",
    };
  }

  let bytesRead = 0;
  let bytesThroughTurn: number | null = null;
  let selectedTurnSeen = false;
  let compressedItems: Record<string, unknown>[] | null = null;
  let compressedReason = "No safe compaction exists at or before the selected turn";
  let schemaUnsafe = false;
  let activeTurnId: string | null = null;
  let lastSelectedAgentMessageId: string | null = null;
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      bytesRead += Buffer.byteLength(line) + 1;
      let entry: unknown;
      try {
        entry = JSON.parse(line) as unknown;
      } catch {
        compressedItems = null;
        compressedReason = "The source rollout contains invalid JSONL";
        schemaUnsafe = true;
        continue;
      }
      if (!isRecord(entry) || typeof entry.type !== "string" || !isRecord(entry.payload)) {
        compressedItems = null;
        compressedReason = "The source rollout contains an unsupported record schema";
        schemaUnsafe = true;
        continue;
      }

      if (entry.type === "turn_context" && entry.payload.turn_id === lastTurnId) {
        selectedTurnSeen = true;
      }
      if (
        (entry.type === "turn_context" ||
          (entry.type === "event_msg" && entry.payload.type === "task_started")) &&
        typeof entry.payload.turn_id === "string"
      ) {
        activeTurnId = entry.payload.turn_id;
      }
      if (entry.type === "response_item") {
        const itemTurnId = responseItemTurnId(entry.payload) ?? activeTurnId;
        if (itemTurnId === lastTurnId && isNonEmptyAssistantMessage(entry.payload)) {
          lastSelectedAgentMessageId = entry.payload.id as string;
        }
      }
      if (entry.type === "compacted") {
        const replacement = validReplacementHistory(entry.payload.replacement_history);
        if (replacement && !schemaUnsafe) {
          compressedItems = replacement;
          compressedReason = "";
        } else {
          compressedItems = null;
          if (!schemaUnsafe) compressedReason = "The latest compaction has an unsupported schema";
          schemaUnsafe = true;
        }
      } else if (entry.type === "response_item" && compressedItems) {
        if (isResponseItem(entry.payload)) compressedItems.push(entry.payload);
        else {
          compressedItems = null;
          compressedReason = "The model-visible tail has an unsupported item schema";
          schemaUnsafe = true;
        }
      }

      if (
        entry.type === "event_msg" &&
        entry.payload.type === "task_complete" &&
        entry.payload.turn_id === lastTurnId
      ) {
        selectedTurnSeen = true;
        bytesThroughTurn = Math.min(bytesRead, sourceBytes);
        break;
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }

  if (!selectedTurnSeen || bytesThroughTurn === null) {
    compressedItems = null;
    compressedReason = "The selected completed turn was not found in the source rollout";
  }
  const exactBytes = bytesThroughTurn;
  const exact = available(exactBytes, coarseTime(exactBytes, false));
  const forkPointValidation =
    agentMessageId === undefined || lastSelectedAgentMessageId === null
      ? "unknown"
      : lastSelectedAgentMessageId === agentMessageId
        ? "valid"
        : "invalid";
  if (agentMessageId !== undefined && forkPointValidation !== "valid" && compressedItems) {
    compressedItems = null;
    compressedReason =
      forkPointValidation === "invalid"
        ? "agentMessageId does not select the last agent message of the turn"
        : "The selected agent message could not be verified from the source rollout";
  }
  if (!compressedItems) {
    return {
      estimate: { sourceBytes, compressed: unavailable(compressedReason), exact },
      compressedItems: null,
      forkPointValidation,
    };
  }
  const compressedBytes = Buffer.byteLength(JSON.stringify(compressedItems));
  return {
    estimate: {
      sourceBytes,
      compressed: available(compressedBytes, coarseTime(compressedBytes, true)),
      exact,
    },
    compressedItems,
    forkPointValidation,
  };
}

export async function hasForkMaterializationMarker(
  path: string | null,
  operationId: string,
): Promise<boolean | null> {
  if (!path) return null;
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let entry: unknown;
      try {
        entry = JSON.parse(line) as unknown;
      } catch {
        return null;
      }
      if (
        isRecord(entry) &&
        entry.type === "response_item" &&
        isRecord(entry.payload) &&
        isRecord(entry.payload.internal_chat_message_metadata_passthrough) &&
        entry.payload.internal_chat_message_metadata_passthrough[
          FORK_MATERIALIZATION_MARKER_KEY
        ] === operationId
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return null;
  } finally {
    lines.close();
    input.destroy();
  }
}

export async function readFreshCompaction(
  path: string,
  startBytes: number,
): Promise<Record<string, unknown>[] | null> {
  const input = createReadStream(path, { encoding: "utf8", start: startBytes });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let latest: Record<string, unknown>[] | null = null;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      if (!isRecord(entry) || entry.type !== "compacted" || !isRecord(entry.payload)) continue;
      const replacement = validReplacementHistory(entry.payload.replacement_history);
      if (!replacement) throw new Error("The fresh compaction has an unsupported schema");
      latest = replacement;
    }
    return latest;
  } finally {
    lines.close();
    input.destroy();
  }
}

function validReplacementHistory(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isResponseItem)) return null;
  return structuredClone(value) as Record<string, unknown>[];
}

function isResponseItem(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.type === "string" && RESPONSE_ITEM_TYPES.has(value.type);
}

function responseItemTurnId(value: Record<string, unknown>): string | null {
  const metadata = value.internal_chat_message_metadata_passthrough;
  return isRecord(metadata) && typeof metadata.turn_id === "string" ? metadata.turn_id : null;
}

function isNonEmptyAssistantMessage(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { id: string } {
  if (value.type !== "message" || value.role !== "assistant" || typeof value.id !== "string") {
    return false;
  }
  return (
    Array.isArray(value.content) &&
    value.content.some(
      (content) =>
        isRecord(content) && typeof content.text === "string" && Boolean(content.text.trim()),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function available(
  estimatedBytes: number | null,
  estimatedSeconds: { minSeconds: number; maxSeconds: number },
): ForkModeEstimate {
  return { available: true, estimatedBytes, estimatedSeconds, unavailableReason: null };
}

function unavailable(reason: string): ForkModeEstimate {
  return {
    available: false,
    estimatedBytes: null,
    estimatedSeconds: null,
    unavailableReason: reason,
  };
}

function coarseTime(
  bytes: number | null,
  compressed: boolean,
): { minSeconds: number; maxSeconds: number } {
  if (bytes === null) return { minSeconds: 30, maxSeconds: 180 };
  const mib = bytes / (1024 * 1024);
  if (compressed) {
    if (mib <= 2) return { minSeconds: 5, maxSeconds: 30 };
    if (mib <= 20) return { minSeconds: 10, maxSeconds: 60 };
    return { minSeconds: 30, maxSeconds: 180 };
  }
  if (mib <= 10) return { minSeconds: 15, maxSeconds: 60 };
  if (mib <= 100) return { minSeconds: 30, maxSeconds: 180 };
  return { minSeconds: 60, maxSeconds: 600 };
}
