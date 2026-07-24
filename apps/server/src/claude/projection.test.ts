import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildClaudeTurns, paginateClaudeTurns, projectClaudeTurns } from "./projection";
import type { ClaudeContentBlock, ClaudeSessionInfo, ClaudeTranscriptMessage } from "./sdk";

interface Fixture {
  info: ClaudeSessionInfo;
  messages: ClaudeTranscriptMessage[];
}

function loadFixture(name: string): Fixture {
  const raw = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
  return JSON.parse(raw) as Fixture;
}

const SANDBOX_CWD =
  "/private/tmp/claude-1938894507/-Users-oryuro-Desktop-codex-nest/bd971c14-a99d-4773-848a-84d84fc48a83/scratchpad/spike/sandbox";

let uuidCounter = 0;
function nextUuid(): string {
  uuidCounter += 1;
  return `uuid-${uuidCounter}`;
}

function userPrompt(text: string, timestamp = "2026-01-01T00:00:00.000Z"): ClaudeTranscriptMessage {
  return message("user", [{ type: "text", text }], timestamp);
}

function assistantBlocks(
  blocks: ClaudeContentBlock[],
  stopReason: string | null,
  timestamp = "2026-01-01T00:00:05.000Z",
): ClaudeTranscriptMessage {
  return {
    ...message("assistant", blocks, timestamp),
    message: { role: "assistant", content: blocks, stop_reason: stopReason },
  };
}

function toolResult(toolUseId: string, content: string, isError = false): ClaudeTranscriptMessage {
  return message("user", [
    { type: "tool_result", tool_use_id: toolUseId, content, is_error: isError },
  ]);
}

function message(
  type: "user" | "assistant",
  content: ClaudeContentBlock[],
  timestamp = "2026-01-01T00:00:00.000Z",
): ClaudeTranscriptMessage {
  return {
    type,
    uuid: nextUuid(),
    session_id: "session",
    message: { role: type, content },
    parent_tool_use_id: null,
    parent_agent_id: null,
    timestamp,
  };
}

describe("buildClaudeTurns (real transcripts)", () => {
  it("maps a plain-text session to one completed turn with thinking + final answer", () => {
    const { messages } = loadFixture("session-plain-text.json");
    const turns = buildClaudeTurns(messages, SANDBOX_CWD);

    expect(turns).toHaveLength(1);
    const turn = turns[0]!;
    expect(turn.id).toBe(messages[0]!.uuid);
    expect(turn.status).toBe("completed");
    expect(turn.startedAt).toBe(Date.parse("2026-07-23T20:43:18.731Z"));
    expect(turn.completedAt).toBe(Date.parse("2026-07-23T20:43:20.094Z"));
    expect(turn.durationMs).toBeGreaterThan(0);

    expect(turn.items.map((item) => item.type)).toEqual([
      "userMessage",
      "reasoning",
      "agentMessage",
    ]);
    const [user, reasoning, answer] = turn.items;
    expect(user).toMatchObject({ type: "userMessage", text: "Reply with exactly: ok", images: [] });
    expect(reasoning).toMatchObject({ type: "reasoning" });
    expect(reasoning.type === "reasoning" && reasoning.text).toContain("reply with exactly");
    expect(answer).toMatchObject({ type: "agentMessage", text: "ok", phase: "final_answer" });
  });

  it("pairs Bash/Write tool_use with their results and synthesizes a Write diff", () => {
    const { messages } = loadFixture("session-tools.json");
    const turns = buildClaudeTurns(messages, SANDBOX_CWD);

    expect(turns).toHaveLength(1);
    const turn = turns[0]!;
    expect(turn.status).toBe("completed");

    const bash = turn.items.find((item) => item.type === "command");
    expect(bash).toMatchObject({
      type: "command",
      kind: "command",
      command: "echo hi",
      output: "hi",
      status: "completed",
      exitCode: null,
    });

    const write = turn.items.find((item) => item.type === "fileChange");
    expect(write).toMatchObject({ type: "fileChange", path: "/tmp/note.txt", status: "completed" });
    expect(write?.type === "fileChange" && write.patch).toContain("--- /dev/null");
    expect(write?.type === "fileChange" && write.patch).toContain("+++ b/tmp/note.txt");
    expect(write?.type === "fileChange" && write.patch).toContain("+ok");

    // Tool item ids are the transcript tool_use_id (stable across reads).
    const toolUseIds = messages
      .flatMap((message) => (Array.isArray(message.message.content) ? message.message.content : []))
      .filter((block) => block.type === "tool_use")
      .map((block) => (block as { id: string }).id);
    expect(toolUseIds).toContain(bash?.id);

    // Exactly one final answer, and it is the last agentMessage.
    const answers = turn.items.filter(
      (item) => item.type === "agentMessage" && item.phase === "final_answer",
    );
    expect(answers).toHaveLength(1);
    expect(turn.items.at(-1)).toMatchObject({ type: "agentMessage", phase: "final_answer" });
  });

  it("humanizes a Read tool as a read-kind command and stringifies image output", () => {
    const { messages } = loadFixture("session-read.json");
    const turn = buildClaudeTurns(messages, SANDBOX_CWD)[0]!;
    const read = turn.items.find((item) => item.type === "command");
    expect(read).toMatchObject({ type: "command", kind: "read", command: "Read red.png" });
    expect(read?.type === "command" && read.output).toContain("[image]");
  });
});

describe("buildClaudeTurns (tool coverage)", () => {
  it("synthesizes an Edit replacement diff", () => {
    const use = {
      type: "tool_use" as const,
      id: "t-edit",
      name: "Edit",
      input: {
        file_path: `${SANDBOX_CWD}/src/x.ts`,
        old_string: "const a = 1;",
        new_string: "const a = 2;",
      },
    };
    const turns = buildClaudeTurns(
      [
        userPrompt("edit it"),
        assistantBlocks([use], "tool_use"),
        toolResult("t-edit", "ok"),
        assistantBlocks([{ type: "text", text: "done" }], "end_turn"),
      ],
      SANDBOX_CWD,
    );
    const change = turns[0]!.items.find((item) => item.type === "fileChange");
    expect(change).toMatchObject({ type: "fileChange", path: `${SANDBOX_CWD}/src/x.ts` });
    expect(change?.type === "fileChange" && change.patch).toContain("--- a/src/x.ts");
    expect(change?.type === "fileChange" && change.patch).toContain("-const a = 1;");
    expect(change?.type === "fileChange" && change.patch).toContain("+const a = 2;");
  });

  it("synthesizes a MultiEdit diff with one header and multiple hunks", () => {
    const use = {
      type: "tool_use" as const,
      id: "t-multi",
      name: "MultiEdit",
      input: {
        file_path: "src/y.ts",
        edits: [
          { old_string: "a", new_string: "b" },
          { old_string: "c", new_string: "d" },
        ],
      },
    };
    const turns = buildClaudeTurns([
      userPrompt("multi"),
      assistantBlocks([use], "tool_use"),
      toolResult("t-multi", "ok"),
      assistantBlocks([{ type: "text", text: "ok" }], "end_turn"),
    ]);
    const patch = (turns[0]!.items.find((item) => item.type === "fileChange") as { patch: string })
      .patch;
    expect(patch.match(/\+\+\+ b\/src\/y\.ts/g)).toHaveLength(1);
    expect(patch).toContain("-a");
    expect(patch).toContain("+b");
    expect(patch).toContain("-c");
    expect(patch).toContain("+d");
  });

  it("maps TodoWrite to a plan checklist with status mapping", () => {
    const use = {
      type: "tool_use" as const,
      id: "t-todo",
      name: "TodoWrite",
      input: {
        todos: [
          { content: "Explore", status: "completed", activeForm: "Exploring" },
          { content: "Build", status: "in_progress", activeForm: "Building" },
          { content: "Test", status: "pending", activeForm: "Testing" },
        ],
      },
    };
    const turn = buildClaudeTurns([
      userPrompt("plan"),
      assistantBlocks([use], "tool_use"),
      toolResult("t-todo", "ok"),
      assistantBlocks([{ type: "text", text: "ok" }], "end_turn"),
    ])[0]!;
    const checklist = turn.items.find((item) => item.type === "planChecklist");
    expect(checklist).toMatchObject({
      type: "planChecklist",
      steps: [
        { step: "Explore", status: "completed" },
        { step: "Build", status: "inProgress" },
        { step: "Test", status: "pending" },
      ],
    });
    expect(turn.progress.steps).toHaveLength(3);
  });

  it("maps Grep/WebSearch to search commands and unknown tools to a generic tool item", () => {
    const grep = { type: "tool_use" as const, id: "g", name: "Grep", input: { pattern: "TODO" } };
    const web = {
      type: "tool_use" as const,
      id: "w",
      name: "WebSearch",
      input: { query: "claude sdk" },
    };
    const custom = {
      type: "tool_use" as const,
      id: "c",
      name: "AskUserQuestion",
      input: { questions: [] },
    };
    const turn = buildClaudeTurns([
      userPrompt("go"),
      assistantBlocks([grep, web, custom], "tool_use"),
      toolResult("g", "hit"),
      toolResult("w", "results"),
      toolResult("c", "answered"),
      assistantBlocks([{ type: "text", text: "ok" }], "end_turn"),
    ])[0]!;
    expect(turn.items.find((item) => item.id === "g")).toMatchObject({
      type: "command",
      kind: "search",
      command: "Grep TODO",
    });
    expect(turn.items.find((item) => item.id === "w")).toMatchObject({
      type: "command",
      kind: "search",
    });
    expect(turn.items.find((item) => item.id === "c")).toMatchObject({
      type: "tool",
      title: "AskUserQuestion",
    });
  });

  it("marks a failed tool result and a dangling tool_use", () => {
    const failing = {
      type: "tool_use" as const,
      id: "bad",
      name: "Bash",
      input: { command: "false" },
    };
    const dangling = {
      type: "tool_use" as const,
      id: "hang",
      name: "Bash",
      input: { command: "sleep" },
    };
    const turn = buildClaudeTurns([
      userPrompt("run"),
      assistantBlocks([failing], "tool_use"),
      toolResult("bad", "boom", true),
      assistantBlocks([dangling], "tool_use"),
    ])[0]!;
    expect(turn.items.find((item) => item.id === "bad")).toMatchObject({ status: "failed" });
    expect(turn.items.find((item) => item.id === "hang")).toMatchObject({ status: "inProgress" });
  });
});

describe("turn status and interruption", () => {
  it("marks the trailing turn interrupted when it never closes", () => {
    const turns = buildClaudeTurns([
      userPrompt("first"),
      assistantBlocks([{ type: "text", text: "done" }], "end_turn"),
      userPrompt("second"),
      assistantBlocks(
        [{ type: "tool_use", id: "x", name: "Bash", input: { command: "echo" } }],
        "tool_use",
      ),
    ]);
    expect(turns.map((turn) => turn.status)).toEqual(["completed", "interrupted"]);
    expect(turns[1]!.completedAt).toBeNull();
    expect(turns[1]!.durationMs).toBeNull();
  });

  it("treats a non-final unclosed turn as completed (only the final turn detects interruption)", () => {
    const turns = buildClaudeTurns([
      userPrompt("first"),
      assistantBlocks(
        [{ type: "tool_use", id: "x", name: "Bash", input: { command: "echo" } }],
        "tool_use",
      ),
      userPrompt("second"),
      assistantBlocks([{ type: "text", text: "done" }], "end_turn"),
    ]);
    expect(turns.map((turn) => turn.status)).toEqual(["completed", "completed"]);
  });
});

describe("paginateClaudeTurns", () => {
  function turnList(count: number) {
    return Array.from(
      { length: count },
      (_unused, index) => ({ id: `turn-${index}` }) as ReturnType<typeof buildClaudeTurns>[number],
    );
  }

  it("returns the last page and a cursor to older turns", () => {
    const all = turnList(25);
    const page = paginateClaudeTurns(all, null, 20);
    expect(page.turns.map((turn) => turn.id)).toEqual(all.slice(5).map((turn) => turn.id));
    expect(page.olderTurnsCursor).toBe("turn-5");
  });

  it("walks older pages via the cursor and stops with a null cursor", () => {
    const all = turnList(25);
    const older = paginateClaudeTurns(all, "turn-5", 20);
    expect(older.turns.map((turn) => turn.id)).toEqual(all.slice(0, 5).map((turn) => turn.id));
    expect(older.olderTurnsCursor).toBeNull();
  });

  it("returns everything with no cursor when the transcript fits in one page", () => {
    const page = projectClaudeTurns(
      [userPrompt("hi"), assistantBlocks([{ type: "text", text: "ok" }], "end_turn")],
      { pageSize: 20 },
    );
    expect(page.turns).toHaveLength(1);
    expect(page.olderTurnsCursor).toBeNull();
  });
});
