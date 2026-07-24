import type { ActivityItem, TurnPlanStep, TurnProgress, TurnView } from "@codexnest/protocol";

import { diffStats } from "../projection";
import type { ClaudeContentBlock, ClaudeTranscriptMessage } from "./sdk";

// The ClaudeContentBlock union ends in an open `{ type: string }` catch-all, which
// blocks precise narrowing on `block.type === "…"`; these aliases + casts recover it.
type ToolUseBlock = Extract<ClaudeContentBlock, { type: "tool_use" }>;
type ToolResultBlock = Extract<ClaudeContentBlock, { type: "tool_result" }>;
type ImageBlock = Extract<ClaudeContentBlock, { type: "image" }>;
// The userMessage/agentMessage/reasoning/plan members of ActivityItem share one shape;
// this is that text-bearing member (Extract by a `type` subset would collapse to never).
type TextActivityItem = Extract<ActivityItem, { text: string; images: string[] }>;

/** Mirrors Codex's THREAD_TURN_PAGE_SIZE so both backends paginate identically. */
export const CLAUDE_THREAD_TURN_PAGE_SIZE = 20;

const CLOSED_STOP_REASONS = new Set(["end_turn", "stop_sequence", "max_tokens"]);

// CLI-inserted markers that record why a turn stopped. They are `user` text messages
// but must NOT start a turn (they carry no user intent) and must not render as items.
const INTERRUPT_MARKER = /^\[Request interrupted by user/;

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
  // are represented by their parent Task tool_use in the main thread. Non-record
  // entries (a corrupt transcript line) and CLI interrupt markers are dropped so they
  // neither start a turn nor render as items.
  const mainThread = messages.filter(
    (message) =>
      isRecord(message) && message.parent_tool_use_id === null && !isInterruptMarker(message),
  );
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
  const turnId = prompt.uuid;
  const results = collectToolResults(group);
  const items = buildTurnItems(group, turnId, cwd, results);
  markFinalAnswer(items);

  const closed = isTurnClosed(group);
  const status: TurnView["status"] = !isFinalTurn || closed ? "completed" : "interrupted";
  const startedAt = timestampMs(prompt);
  const lastMessage = group.at(-1)!;
  const completedAt = status === "interrupted" ? null : timestampMs(lastMessage);
  const durationMs =
    startedAt !== null && completedAt !== null ? Math.max(0, completedAt - startedAt) : null;

  return {
    id: turnId,
    status,
    startedAt,
    completedAt,
    durationMs,
    progress: buildProgress(items, startedAt),
    items,
  };
}

/**
 * Maps a turn's messages (oldest→newest) into ActivityItems. Shared by the transcript
 * read path and the live turn. Item ids are stable and identical across both halves so
 * reopening a thread after a live turn dedupes cleanly:
 *  - text / thinking / image blocks → `${turnId}:${ordinal}` where ordinal counts those
 *    blocks in order (the SDK's streaming identity is disjoint from the persisted
 *    wrapper-message uuid — see ClaudeLiveTurn — so an order-based id is what both halves
 *    can compute, live under a growing stream and offline from the transcript);
 *  - tool_use blocks → the tool_use_id (present in both the stream and the transcript).
 */
export function buildTurnItems(
  group: ClaudeTranscriptMessage[],
  turnId: string,
  cwd: string | undefined,
  results: Map<string, ToolResult>,
): ActivityItem[] {
  const items: ActivityItem[] = [];
  const ordinal = new OrdinalCounter(turnId);
  for (const message of group) {
    const role = message.type === "user" ? "user" : "assistant";
    for (const block of contentBlocks(message)) {
      const item = renderBlock(block, {
        id: ordinal.idFor(block),
        role,
        cwd,
        results,
        timestamp: timestampMs(message),
        previousItemId: items.at(-1)?.id ?? null,
      });
      if (item) items.push(item);
    }
  }
  return items;
}

/** Assigns block ids: an incrementing ordinal for text-like blocks, the id for tools. */
class OrdinalCounter {
  private ordinal = 0;
  private unsupported = 0;
  constructor(private readonly turnId: string) {}

  idFor(block: ClaudeContentBlock): string {
    if (block.type === "text" || block.type === "thinking" || block.type === "image") {
      const id = `${this.turnId}:${this.ordinal}`;
      this.ordinal += 1;
      return id;
    }
    if (block.type === "tool_use") return (block as ToolUseBlock).id;
    // Unsupported blocks get their own running index so several in one turn never collide
    // on a single id (and don't perturb text ordinals). Both projection halves count them
    // identically, so live and transcript stay converged.
    const id = `${this.turnId}:x${this.unsupported}`;
    this.unsupported += 1;
    return id;
  }
}

interface RenderContext {
  id: string;
  role: "user" | "assistant";
  cwd: string | undefined;
  results: Map<string, ToolResult>;
  timestamp: number | null;
  previousItemId: string | null;
}

/** The single block→ActivityItem core used by both the transcript and live projections. */
function renderBlock(block: ClaudeContentBlock, context: RenderContext): ActivityItem | null {
  const { id, timestamp } = context;
  switch (block.type) {
    case "text": {
      const text = typeof block.text === "string" ? block.text : "";
      const type = context.role === "user" ? "userMessage" : "agentMessage";
      return { type, id, status: "completed", text, images: [], timestamp, phase: null };
    }
    case "thinking": {
      const text = typeof block.thinking === "string" ? block.thinking : "";
      return {
        type: "reasoning",
        id,
        status: "completed",
        text,
        images: [],
        timestamp,
        phase: null,
      };
    }
    case "image": {
      const url = imageDataUrl(block);
      return {
        type: "userMessage",
        id,
        status: "completed",
        text: "",
        images: url ? [url] : [],
        timestamp,
        phase: null,
      };
    }
    case "tool_use": {
      const toolUse = block as ToolUseBlock;
      return mapToolUse(
        toolUse,
        context.results.get(toolUse.id),
        context.cwd,
        timestamp,
        context.previousItemId,
      );
    }
    case "tool_result":
      // Paired into its tool_use item; standalone results carry no display value.
      return null;
    default:
      return {
        type: "unsupported",
        id,
        status: "failed",
        message: `Неподдерживаемый блок Claude: ${String(block.type)}`,
      };
  }
}

/** Sets the last agent text block of a turn as its final answer. */
function markFinalAnswer(items: ActivityItem[]): void {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.type === "agentMessage") {
      item.phase = "final_answer";
      return;
    }
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
        status:
          status === "failed" ? "failed" : status === "inProgress" ? "inProgress" : "completed",
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

export interface ToolResult {
  text: string;
  isError: boolean;
}

/**
 * A live, incrementally-built turn. The session feeds it SDK messages as they stream;
 * it produces the same ActivityItems (identical ids) the transcript read produces for
 * the finished turn, so a reopen after the turn ends dedupes cleanly. Text/thinking
 * blocks stream token-by-token under their ordinal id (the id their finalizing
 * `assistant` message will also get), so the growing item and its final form share one
 * id — the SDK never exposes the persisted wrapper uuid before the block completes.
 */
export class ClaudeLiveTurn {
  /** Finalized (closed) transcript messages, oldest→newest. */
  private readonly messages: ClaudeTranscriptMessage[] = [];
  private readonly toolResults = new Map<string, ToolResult>();
  private finalizedItems: ActivityItem[] = [];
  /** The currently-streaming text/thinking block, not yet closed by an assistant message. */
  private streaming: { item: TextActivityItem } | null = null;
  private startedAt: number | null = null;

  constructor(
    readonly turnId: string,
    private readonly cwd: string | undefined,
  ) {}

  /** Records the user prompt (text + images) as items; returns them to emit. */
  prompt(text: string, images: string[]): ActivityItem[] {
    const content: ClaudeContentBlock[] = [];
    if (text.trim()) content.push({ type: "text", text });
    for (const url of images) {
      const parsed = parseImageDataUrl(url);
      if (parsed) content.push({ type: "image", source: parsed });
    }
    const message: ClaudeTranscriptMessage = {
      type: "user",
      uuid: this.turnId,
      session_id: "",
      message: { role: "user", content },
      parent_tool_use_id: null,
      parent_agent_id: null,
      timestamp: new Date().toISOString(),
    };
    this.startedAt ??= Date.now();
    return this.appendStructural(message);
  }

  /** Ingests a completed assistant message (one content block). Returns items to emit. */
  ingestAssistant(message: ClaudeTranscriptMessage): ActivityItem[] {
    // Sub-agent (Task) messages are represented by the parent Task tool_use on the main
    // thread — the transcript's mainThread filter drops them, so the live half must too,
    // or a subagent-using turn diverges from its later transcript read.
    if (isInterruptMarker(message) || message.parent_tool_use_id !== null) return [];
    this.streaming = null; // the completed message supersedes any partial of this block
    return this.appendStructural(message);
  }

  /** Ingests a user message carrying tool_result blocks. Returns items to emit. */
  ingestToolResult(message: ClaudeTranscriptMessage): ActivityItem[] {
    if (isInterruptMarker(message) || message.parent_tool_use_id !== null) return [];
    for (const block of contentBlocks(message)) {
      if (block.type !== "tool_result") continue;
      const result = block as ToolResultBlock;
      if (typeof result.tool_use_id !== "string") continue;
      this.toolResults.set(result.tool_use_id, {
        text: toolResultText(result.content),
        isError: result.is_error === true,
      });
    }
    return this.appendStructural(message);
  }

  /** Grows the currently-open streaming block; returns the updated item (or null). */
  streamDelta(kind: "text" | "thinking", delta: string): ActivityItem | null {
    if (!delta) return null;
    const type = kind === "thinking" ? "reasoning" : "agentMessage";
    // Reuse the open item only when it is the same kind; a kind switch (e.g. thinking→text
    // before the thinking block's assistant message closes it) starts a fresh item so
    // answer text never lands in the reasoning bubble.
    const open = this.streaming?.item.type === type ? this.streaming.item : undefined;
    const current: TextActivityItem = open ?? {
      type,
      id: `${this.turnId}:${this.nextOrdinal()}`,
      status: "inProgress",
      text: "",
      images: [],
      timestamp: Date.now(),
      phase: null,
    };
    const item: TextActivityItem = { ...current, text: current.text + delta };
    this.streaming = { item };
    return item;
  }

  /** Marks the turn's last agent message as the final answer; returns it if changed. */
  finalize(): ActivityItem | null {
    this.streaming = null;
    for (let index = this.finalizedItems.length - 1; index >= 0; index -= 1) {
      const item = this.finalizedItems[index]!;
      if (item.type === "agentMessage") {
        if (item.phase === "final_answer") return null;
        const updated: ActivityItem = { ...item, phase: "final_answer" };
        this.finalizedItems[index] = updated;
        return updated;
      }
    }
    return null;
  }

  get progress(): TurnProgress {
    return buildProgress(this.items, this.startedAt);
  }

  /** All items (finalized + any open streaming block) — used to render the live turn. */
  get items(): ActivityItem[] {
    return this.streaming
      ? [...this.finalizedItems, this.streaming.item]
      : [...this.finalizedItems];
  }

  private appendStructural(message: ClaudeTranscriptMessage): ActivityItem[] {
    this.startedAt ??= timestampMs(message) ?? Date.now();
    this.messages.push(message);
    const previous = this.finalizedItems;
    this.finalizedItems = buildTurnItems(this.messages, this.turnId, this.cwd, this.toolResults);
    return diffItems(previous, this.finalizedItems);
  }

  private nextOrdinal(): number {
    return this.finalizedItems.filter(
      (item) =>
        item.type === "userMessage" || item.type === "agentMessage" || item.type === "reasoning",
    ).length;
  }
}

/** Returns items in `next` that are new or changed vs `previous` (matched by id). */
function diffItems(previous: ActivityItem[], next: ActivityItem[]): ActivityItem[] {
  const before = new Map(previous.map((item) => [item.id, item]));
  const changed: ActivityItem[] = [];
  for (const item of next) {
    const prior = before.get(item.id);
    if (!prior || JSON.stringify(prior) !== JSON.stringify(item)) changed.push(item);
  }
  return changed;
}

function collectToolResults(group: ClaudeTranscriptMessage[]): Map<string, ToolResult> {
  const results = new Map<string, ToolResult>();
  for (const message of group) {
    for (const block of contentBlocks(message)) {
      if (block.type !== "tool_result") continue;
      const result = block as ToolResultBlock;
      if (typeof result.tool_use_id !== "string") continue;
      results.set(result.tool_use_id, {
        text: toolResultText(result.content),
        isError: result.is_error === true,
      });
    }
  }
  return results;
}

/**
 * Safely extracts a message's content blocks, tolerating a malformed transcript
 * entry (missing `message`, non-array content, or null/non-record blocks).
 */
function contentBlocks(message: ClaudeTranscriptMessage): ClaudeContentBlock[] {
  const apiMessage = (message as { message?: unknown }).message;
  const content = isRecord(apiMessage) ? apiMessage.content : undefined;
  if (typeof content === "string") return [textBlock(content)];
  if (!Array.isArray(content)) return [];
  return content.filter(
    (block): block is ClaudeContentBlock => isRecord(block) && typeof block.type === "string",
  );
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
  if (!isRecord(message) || message.type !== "user" || isInterruptMarker(message)) return false;
  const apiMessage = (message as { message?: unknown }).message;
  const content = isRecord(apiMessage) ? apiMessage.content : undefined;
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((block) => isRecord(block) && block.type !== "tool_result");
}

/** True for CLI-inserted `[Request interrupted by user …]` markers (a user text message). */
export function isInterruptMarker(message: ClaudeTranscriptMessage): boolean {
  if (!isRecord(message) || message.type !== "user") return false;
  const apiMessage = (message as { message?: unknown }).message;
  const content = isRecord(apiMessage) ? apiMessage.content : undefined;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content) &&
          content.length === 1 &&
          isRecord(content[0]) &&
          content[0].type === "text"
        ? String(content[0].text ?? "")
        : null;
  return text !== null && INTERRUPT_MARKER.test(text.trim());
}

function isTurnClosed(group: ClaudeTranscriptMessage[]): boolean {
  for (let index = group.length - 1; index >= 0; index -= 1) {
    const message = group[index]!;
    if (!isRecord(message) || message.type !== "assistant") continue;
    const apiMessage = (message as { message?: unknown }).message;
    const stopReason = isRecord(apiMessage) ? apiMessage.stop_reason : undefined;
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

/** Parses a `data:<media_type>;base64,<data>` URL into an image block source. */
export function parseImageDataUrl(
  url: string,
): { type: "base64"; media_type: string; data: string } | null {
  const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,(.+)$/i.exec(url.trim());
  if (!match) return null;
  return { type: "base64", media_type: match[1]!, data: match[2]! };
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
  const timestamp = (message as { timestamp?: unknown }).timestamp;
  if (typeof timestamp !== "string") return null;
  const parsed = Date.parse(timestamp);
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
