import type { ActivityItem, TurnPlanStep, TurnProgress, TurnView } from "@codexnest/protocol";

import { diffStats } from "../projection";
import type { ClaudeContentBlock, ClaudeTranscriptMessage } from "./sdk";

// The ClaudeContentBlock union ends in an open `{ type: string }` catch-all, which
// blocks precise narrowing on `block.type === "…"`; these aliases + casts recover it.
type ToolUseBlock = Extract<ClaudeContentBlock, { type: "tool_use" }>;
type ToolResultBlock = Extract<ClaudeContentBlock, { type: "tool_result" }>;
type ImageBlock = Extract<ClaudeContentBlock, { type: "image" }>;

/** Mirrors Codex's THREAD_TURN_PAGE_SIZE so both backends paginate identically. */
export const CLAUDE_THREAD_TURN_PAGE_SIZE = 20;

const CLOSED_STOP_REASONS = new Set(["end_turn", "stop_sequence", "max_tokens"]);

export interface ProjectClaudeTurnsOptions {
  cwd?: string;
  cursor?: string | null;
  pageSize?: number;
}

export interface ClaudeTurnsPage {
  turns: TurnView[];
  olderTurnsCursor: string | null;
}

/**
 * Maps a full transcript (from `getSessionMessages`) into the last page of
 * `TurnView`s. Turns are grouped by main-thread user prompts (turn id = the
 * prompt message's uuid) and ordered oldest→newest within the page, matching the
 * Codex read path.
 */
export function projectClaudeTurns(
  messages: ClaudeTranscriptMessage[],
  options: ProjectClaudeTurnsOptions = {},
): ClaudeTurnsPage {
  const turns = buildClaudeTurns(messages, options.cwd);
  return paginateClaudeTurns(turns, options.cursor ?? null, options.pageSize);
}

/** Groups every transcript message into ordered turns (oldest→newest). */
export function buildClaudeTurns(messages: ClaudeTranscriptMessage[], cwd?: string): TurnView[] {
  // Only the main session is projected; sub-agent messages (parent_tool_use_id set)
  // are represented by their parent Task tool_use in the main thread.
  const mainThread = messages.filter((message) => message.parent_tool_use_id === null);
  const groups: ClaudeTranscriptMessage[][] = [];
  for (const message of mainThread) {
    if (isUserPrompt(message)) {
      groups.push([message]);
    } else if (groups.length > 0) {
      groups[groups.length - 1]!.push(message);
    }
    // Messages before the first user prompt are ignored (defensive; unusual).
  }
  const total = groups.length;
  return groups.map((group, index) => buildTurn(group, cwd, index === total - 1));
}

/** Returns the last `pageSize` turns ending before `cursor` (an older-turn id). */
export function paginateClaudeTurns(
  all: TurnView[],
  cursor: string | null,
  pageSize: number = CLAUDE_THREAD_TURN_PAGE_SIZE,
): ClaudeTurnsPage {
  let end = all.length;
  if (cursor) {
    const index = all.findIndex((turn) => turn.id === cursor);
    if (index >= 0) end = index;
  }
  const start = Math.max(0, end - pageSize);
  const turns = all.slice(start, end);
  const olderTurnsCursor = start > 0 && turns.length > 0 ? turns[0]!.id : null;
  return { turns, olderTurnsCursor };
}

function buildTurn(
  group: ClaudeTranscriptMessage[],
  cwd: string | undefined,
  isFinalTurn: boolean,
): TurnView {
  const prompt = group[0]!;
  const results = collectToolResults(group);
  const items: ActivityItem[] = [];
  let lastAgentMessageId: string | null = null;

  for (const message of group) {
    const content = message.message.content;
    const blocks = typeof content === "string" ? [textBlock(content)] : content;
    blocks.forEach((block, blockIndex) => {
      const item = mapBlock(message, block, blockIndex, results, cwd, items.at(-1)?.id ?? null);
      if (!item) return;
      if (item.type === "agentMessage") lastAgentMessageId = item.id;
      items.push(item);
    });
  }

  // The last text block of the final assistant message is the turn's final answer.
  if (lastAgentMessageId) {
    const finalAnswer = items.find(
      (item) => item.id === lastAgentMessageId && item.type === "agentMessage",
    );
    if (finalAnswer && finalAnswer.type === "agentMessage") finalAnswer.phase = "final_answer";
  }

  const closed = isTurnClosed(group);
  const status: TurnView["status"] = !isFinalTurn || closed ? "completed" : "interrupted";
  const startedAt = timestampMs(prompt);
  const lastMessage = group.at(-1)!;
  const completedAt = status === "interrupted" ? null : timestampMs(lastMessage);
  const durationMs =
    startedAt !== null && completedAt !== null ? Math.max(0, completedAt - startedAt) : null;

  return {
    id: prompt.uuid,
    status,
    startedAt,
    completedAt,
    durationMs,
    progress: buildProgress(items, startedAt),
    items,
  };
}

function mapBlock(
  message: ClaudeTranscriptMessage,
  block: ClaudeContentBlock,
  blockIndex: number,
  results: Map<string, ToolResult>,
  cwd: string | undefined,
  previousItemId: string | null,
): ActivityItem | null {
  const blockId = `${message.uuid}:${blockIndex}`;
  const timestamp = timestampMs(message);
  switch (block.type) {
    case "text": {
      const text = typeof block.text === "string" ? block.text : "";
      const type = message.type === "user" ? "userMessage" : "agentMessage";
      return { type, id: blockId, status: "completed", text, images: [], timestamp, phase: null };
    }
    case "thinking": {
      const text = typeof block.thinking === "string" ? block.thinking : "";
      return {
        type: "reasoning",
        id: blockId,
        status: "completed",
        text,
        images: [],
        timestamp,
        phase: null,
      };
    }
    case "image": {
      // A user-supplied image reaches us as its own block; reconstruct the data URL.
      const url = imageDataUrl(block);
      return {
        type: "userMessage",
        id: blockId,
        status: "completed",
        text: "",
        images: url ? [url] : [],
        timestamp,
        phase: null,
      };
    }
    case "tool_use": {
      const toolUse = block as ToolUseBlock;
      return mapToolUse(toolUse, results.get(toolUse.id), cwd, timestamp, previousItemId);
    }
    case "tool_result":
      // Paired into its tool_use item; standalone results carry no display value.
      return null;
    default:
      return {
        type: "unsupported",
        id: blockId,
        status: "failed",
        message: `Неподдерживаемый блок Claude: ${String(block.type)}`,
      };
  }
}

function mapToolUse(
  block: ToolUseBlock,
  result: ToolResult | undefined,
  cwd: string | undefined,
  timestamp: number | null,
  previousItemId: string | null,
): ActivityItem {
  const id = block.id;
  const input = (block.input ?? {}) as Record<string, unknown>;
  const status = toolStatus(result);
  switch (block.name) {
    case "Bash":
      return {
        type: "command",
        id,
        status,
        kind: "command",
        command: stringField(input.command),
        cwd: cwd ?? null,
        output: resultText(result),
        exitCode: null,
      };
    case "Read":
      return readCommand(
        id,
        status,
        `Read ${relativizePath(stringField(input.file_path), cwd)}`,
        result,
        cwd,
        "read",
      );
    case "Glob":
      return readCommand(
        id,
        status,
        `Glob ${stringField(input.pattern)}${input.path ? ` в ${relativizePath(stringField(input.path), cwd)}` : ""}`,
        result,
        cwd,
        "search",
      );
    case "Grep":
      return readCommand(id, status, `Grep ${stringField(input.pattern)}`, result, cwd, "search");
    case "WebSearch":
      return readCommand(
        id,
        status,
        `Веб-поиск: ${stringField(input.query)}`,
        result,
        cwd,
        "search",
      );
    case "WebFetch":
      return readCommand(id, status, `Загрузка ${stringField(input.url)}`, result, cwd, "search");
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": {
      const change = synthesizeFileChange(block.name, input, cwd);
      return { type: "fileChange", id, status, path: change.path, patch: change.patch };
    }
    case "TodoWrite":
      return {
        type: "planChecklist",
        id,
        status: status === "failed" ? "failed" : "completed",
        explanation: null,
        steps: todoSteps(input.todos),
        timestamp: timestamp ?? 0,
        afterItemId: previousItemId,
      };
    default:
      return {
        type: "tool",
        id,
        status,
        title: block.name,
        detail: result?.isError ? "Инструмент завершился с ошибкой" : "Инструмент Claude",
      };
  }
}

function readCommand(
  id: string,
  status: ActivityItem["status"],
  command: string,
  result: ToolResult | undefined,
  cwd: string | undefined,
  kind: "read" | "search",
): ActivityItem {
  return {
    type: "command",
    id,
    status,
    kind,
    command,
    cwd: cwd ?? null,
    output: resultText(result),
    exitCode: null,
  };
}

interface ToolResult {
  text: string;
  isError: boolean;
}

function collectToolResults(group: ClaudeTranscriptMessage[]): Map<string, ToolResult> {
  const results = new Map<string, ToolResult>();
  for (const message of group) {
    const content = message.message.content;
    if (typeof content === "string") continue;
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const result = block as ToolResultBlock;
      results.set(result.tool_use_id, {
        text: toolResultText(result.content),
        isError: result.is_error === true,
      });
    }
  }
  return results;
}

function toolResultText(content: ToolResultContent): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`))
      .join("\n");
  }
  return "";
}

type ToolResultContent = Extract<ClaudeContentBlock, { type: "tool_result" }>["content"];

function resultText(result: ToolResult | undefined): string {
  return result?.text ?? "";
}

function toolStatus(result: ToolResult | undefined): ActivityItem["status"] {
  if (!result) return "inProgress"; // dangling call — the turn was interrupted mid-tool.
  return result.isError ? "failed" : "completed";
}

function synthesizeFileChange(
  name: string,
  input: Record<string, unknown>,
  cwd: string | undefined,
): { path: string | null; patch: string } {
  if (name === "Write") {
    const path = stringField(input.file_path);
    return {
      path: path || null,
      patch: additionDiff(diffPath(path, cwd), stringField(input.content)),
    };
  }
  if (name === "NotebookEdit") {
    const path = stringField(input.notebook_path) || stringField(input.file_path);
    return {
      path: path || null,
      patch: additionDiff(diffPath(path, cwd), stringField(input.new_source)),
    };
  }
  if (name === "MultiEdit") {
    const path = stringField(input.file_path);
    const relative = diffPath(path, cwd);
    const edits = Array.isArray(input.edits) ? input.edits : [];
    const hunks = edits
      .map((edit) =>
        isRecord(edit)
          ? replaceHunk(stringField(edit.old_string), stringField(edit.new_string))
          : "",
      )
      .filter(Boolean)
      .join("\n");
    return { path: path || null, patch: `--- a/${relative}\n+++ b/${relative}\n${hunks}` };
  }
  // Edit
  const path = stringField(input.file_path);
  const relative = diffPath(path, cwd);
  return {
    path: path || null,
    patch: `--- a/${relative}\n+++ b/${relative}\n${replaceHunk(stringField(input.old_string), stringField(input.new_string))}`,
  };
}

function additionDiff(relativePath: string, content: string): string {
  const lines = content.split("\n");
  const body = lines.map((line) => `+${line}`).join("\n");
  return `--- /dev/null\n+++ b/${relativePath}\n@@ -0,0 +1,${lines.length} @@\n${body}`;
}

function replaceHunk(oldString: string, newString: string): string {
  const oldLines = oldString.split("\n");
  const newLines = newString.split("\n");
  const body = [...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`)].join(
    "\n",
  );
  return `@@ -1,${oldLines.length} +1,${newLines.length} @@\n${body}`;
}

function todoSteps(todos: unknown): TurnPlanStep[] {
  if (!Array.isArray(todos)) return [];
  return todos.filter(isRecord).map((todo) => ({
    step: stringField(todo.content),
    status:
      todo.status === "completed"
        ? "completed"
        : todo.status === "in_progress"
          ? "inProgress"
          : "pending",
  }));
}

function buildProgress(items: ActivityItem[], startedAt: number | null): TurnProgress {
  const patch = items
    .filter(
      (item): item is Extract<ActivityItem, { type: "fileChange" }> => item.type === "fileChange",
    )
    .map((item) => item.patch)
    .join("\n");
  const stats = patch ? diffStats(patch) : { filesChanged: 0, additions: 0, deletions: 0 };
  const lastChecklist = [...items]
    .reverse()
    .find(
      (item): item is Extract<ActivityItem, { type: "planChecklist" }> =>
        item.type === "planChecklist",
    );
  return {
    startedAt,
    explanation: lastChecklist?.explanation ?? null,
    steps: lastChecklist?.steps ?? [],
    filesChanged: stats.filesChanged,
    additions: stats.additions,
    deletions: stats.deletions,
  };
}

function isUserPrompt(message: ClaudeTranscriptMessage): boolean {
  if (message.type !== "user") return false;
  const content = message.message.content;
  if (typeof content === "string") return content.trim().length > 0;
  return content.some((block) => block.type !== "tool_result");
}

function isTurnClosed(group: ClaudeTranscriptMessage[]): boolean {
  for (let index = group.length - 1; index >= 0; index -= 1) {
    const message = group[index]!;
    if (message.type !== "assistant") continue;
    const stopReason = message.message.stop_reason;
    return typeof stopReason === "string" && CLOSED_STOP_REASONS.has(stopReason);
  }
  return false;
}

function imageDataUrl(block: ClaudeContentBlock): string | null {
  if (block.type !== "image") return null;
  const source = (block as ImageBlock).source;
  if (!source || source.type !== "base64" || !source.media_type || !source.data) return null;
  return `data:${source.media_type};base64,${source.data}`;
}

function relativizePath(path: string, cwd: string | undefined): string {
  if (!path) return path;
  if (cwd && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
  if (path.startsWith("./")) return path.slice(2);
  return path;
}

/** Path for a git-style diff header: relativized, with any leading slash dropped so `b/` never doubles up. */
function diffPath(path: string, cwd: string | undefined): string {
  return relativizePath(path, cwd).replace(/^\/+/, "");
}

function timestampMs(message: ClaudeTranscriptMessage): number | null {
  if (!message.timestamp) return null;
  const parsed = Date.parse(message.timestamp);
  return Number.isNaN(parsed) ? null : parsed;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function textBlock(text: string): ClaudeContentBlock {
  return { type: "text", text };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
