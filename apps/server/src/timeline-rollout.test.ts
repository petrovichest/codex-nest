import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Turn } from "./codex/generated/v2/index";
import type { TimelineArtifact } from "./state/store";
import { recoverTimelineOrder } from "./timeline-rollout";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const turn: Turn = {
  id: "turn",
  status: "inProgress",
  itemsView: "full",
  error: null,
  startedAt: 1,
  completedAt: null,
  durationMs: null,
  items: [
    { type: "userMessage", id: "raw-user", clientId: "client-user", content: [] },
    {
      type: "agentMessage",
      id: "explanation",
      text: "Пояснение",
      phase: "commentary",
      memoryCitation: null,
    },
  ],
};
function answers(): Record<string, TimelineArtifact[]> {
  return {
    turn: [
      {
        type: "userInputResponse",
        id: "call_quiz-response",
        status: "completed",
        entries: [],
        timestamp: 50_000,
        afterItemId: "call_quiz",
      },
    ],
  };
}
async function rollout(records: unknown[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codexnest-timeline-rollout-test-"));
  directories.push(directory);
  const path = join(directory, "rollout.jsonl");
  await writeFile(
    path,
    records
      .map((record) => (typeof record === "string" ? record : JSON.stringify(record)))
      .join("\n"),
  );
  return path;
}
const record = (payload: object, turnId = "turn") => ({
  type: "response_item",
  timestamp: "1970-01-01T00:00:20Z",
  payload: { ...payload, internal_chat_message_metadata_passthrough: { turn_id: turnId } },
});

describe("legacy quiz anchors", () => {
  it("uses response-time order and explicit turn metadata, including a user-message client ID", async () => {
    const path = await rollout([
      record({ type: "message", id: "explanation", role: "assistant" }, "other-turn"),
      record({ type: "message", id: "raw-user", role: "user" }),
      record({ type: "function_call_output", call_id: "call_quiz" }, "other-turn"),
      record({ type: "function_call_output", call_id: "call_quiz" }),
      '{"partially_written":',
    ]);
    const artifacts = answers();
    await recoverTimelineOrder(path, [turn], artifacts);
    expect(artifacts.turn?.[0]).toMatchObject({ afterItemId: "client-user", timestamp: 20_000 });
  });

  it("does not guess anchors across corrupt records or unavailable journals", async () => {
    const path = await rollout([
      record({ type: "message", id: "explanation", role: "assistant" }),
      "broken JSON",
      record({ type: "function_call_output", call_id: "call_quiz" }),
    ]);
    for (const source of [path, `${path}.missing`, null]) {
      const artifacts = answers();
      await recoverTimelineOrder(source, [turn], artifacts);
      expect(artifacts).toEqual(answers());
    }
  });

  it("leaves valid anchors and unrelated turns intact", async () => {
    const artifacts = answers();
    artifacts.turn![0]!.afterItemId = "explanation";
    const path = await rollout([
      record({ type: "message", id: "raw-user", role: "user" }),
      record({ type: "function_call_output", call_id: "explanation" }),
    ]);
    await recoverTimelineOrder(path, [turn], artifacts);
    expect(artifacts.turn?.[0]).toMatchObject({ afterItemId: "explanation", timestamp: 50_000 });
  });
});

describe("reused plan ordering", () => {
  const message = (id: string, role: string, text: string) =>
    record({
      type: "message",
      id,
      role,
      content: [{ type: "output_text", text }],
    });
  function projected(): Turn {
    return {
      ...turn,
      status: "completed",
      completedAt: 40,
      items: [
        {
          type: "userMessage",
          id: "root",
          clientId: "root-client",
          content: [{ type: "text", text: "Plan it", text_elements: [] }],
        },
        { type: "plan", id: "turn-plan", text: "Updated plan" },
        {
          type: "userMessage",
          id: "clarification",
          clientId: "reply-client",
          content: [{ type: "text", text: "All bots", text_elements: [] }],
        },
        {
          type: "agentMessage",
          id: "commentary",
          text: "Updating",
          phase: "commentary",
          memoryCitation: null,
        },
      ],
    };
  }

  it("places the latest matching revision after clarification and commentary, without duplicating it", async () => {
    const source = projected();
    const path = await rollout([
      message("root", "user", "Plan it"),
      message("old-plan", "assistant", "<proposed_plan>Old plan</proposed_plan>"),
      message("raw-reply", "user", "All bots"),
      message("commentary", "assistant", "Updating"),
      message("new-plan", "assistant", "<proposed_plan>\nUpdated plan\n</proposed_plan>"),
    ]);
    await recoverTimelineOrder(path, [source], {});
    expect(source.items.map((item) => item.id)).toEqual([
      "root",
      "clarification",
      "commentary",
      "turn-plan",
    ]);
    await recoverTimelineOrder(path, [source], {});
    expect(source.items.filter((item) => item.type === "plan")).toHaveLength(1);
  });

  it("matches a unique steered user message when history and rollout use different IDs", async () => {
    const source = projected();
    source.items.pop();
    const path = await rollout([
      message("root", "user", "Plan it"),
      message("old-plan", "assistant", "<proposed_plan>Updated plan</proposed_plan>"),
      message("raw-reply", "user", "All bots"),
      message("new-plan", "assistant", "<proposed_plan>Updated plan</proposed_plan>"),
    ]);
    await recoverTimelineOrder(path, [source], {});
    expect(source.items.map((item) => item.id)).toEqual(["root", "clarification", "turn-plan"]);
  });

  it("keeps a truly stale plan before the unanswered clarification", async () => {
    const source = projected();
    const path = await rollout([
      message("root", "user", "Plan it"),
      message("old-plan", "assistant", "<proposed_plan>Updated plan</proposed_plan>"),
      message("raw-reply", "user", "All bots"),
      message("commentary", "assistant", "Updating"),
    ]);
    await recoverTimelineOrder(path, [source], {});
    expect(source.items.map((item) => item.id)).toEqual([
      "root",
      "turn-plan",
      "clarification",
      "commentary",
    ]);
  });

  it("does not guess a new position when the matching response or its anchor is unavailable", async () => {
    for (const records of [
      [
        message("commentary", "assistant", "Updating"),
        message("new-plan", "assistant", "<proposed_plan>Different plan</proposed_plan>"),
      ],
      [
        message("commentary", "assistant", "Updating"),
        "broken",
        message("new-plan", "assistant", "<proposed_plan>Updated plan</proposed_plan>"),
      ],
    ]) {
      const source = projected();
      await recoverTimelineOrder(await rollout(records), [source], {});
      expect(source.items.map((item) => item.id)).toEqual([
        "root",
        "turn-plan",
        "clarification",
        "commentary",
      ]);
    }
  });
});
