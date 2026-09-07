import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Turn } from "./codex/generated/v2/index";
import type { TimelineArtifact } from "./state/store";
import { recoverUserInputAnchors } from "./timeline-rollout";

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
    await recoverUserInputAnchors(path, [turn], artifacts);
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
      await recoverUserInputAnchors(source, [turn], artifacts);
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
    await recoverUserInputAnchors(path, [turn], artifacts);
    expect(artifacts.turn?.[0]).toMatchObject({ afterItemId: "explanation", timestamp: 50_000 });
  });
});
