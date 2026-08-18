import { appendFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  analyzeForkRollout,
  hasForkMaterializedCompaction,
  readFreshCompaction,
} from "./fork-rollout";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("fork rollout analysis", () => {
  it("streams through the selected turn and returns the safe compaction plus visible tail", async () => {
    const path = await rollout([
      record("turn_context", { turn_id: "earlier" }),
      record("compacted", {
        message: "",
        replacement_history: [
          message("summary", "compressed context"),
          {
            type: "compaction",
            id: "encrypted-summary",
            encrypted_content: "opaque",
          },
        ],
      }),
      record("response_item", message("tail-user", "later question")),
      record("turn_context", { turn_id: "selected" }),
      record("response_item", message("tail-answer", "selected answer", "assistant")),
      record("event_msg", { type: "task_complete", turn_id: "selected" }),
      record("response_item", message("after", "must not be included")),
    ]);

    const analysis = await analyzeForkRollout(path, "selected", "tail-answer");

    expect(analysis.estimate.sourceBytes).toBeGreaterThan(analysis.estimate.exact.estimatedBytes!);
    expect(analysis.estimate.compressed).toMatchObject({
      available: true,
      unavailableReason: null,
    });
    expect(analysis.compressedItems?.map((item) => item.id)).toEqual([
      "summary",
      "encrypted-summary",
      "tail-user",
      "tail-answer",
    ]);
    expect(analysis.forkPointValidation).toBe("valid");
  });

  it("keeps exact available when strict JSONL gates reject compressed mode", async () => {
    const path = await rollout([
      record("compacted", {
        message: "",
        replacement_history: [message("summary", "context")],
      }),
      "{broken-json",
      record("turn_context", { turn_id: "selected" }),
      record("event_msg", { type: "task_complete", turn_id: "selected" }),
    ]);

    const analysis = await analyzeForkRollout(path, "selected");

    expect(analysis.compressedItems).toBeNull();
    expect(analysis.estimate.compressed).toMatchObject({
      available: false,
      estimatedBytes: null,
      estimatedSeconds: null,
    });
    expect(analysis.estimate.exact.available).toBe(true);
    expect(analysis.estimate.exact.estimatedBytes).toBeTypeOf("number");
  });

  it("marks compressed unavailable when no safe compaction precedes the fork point", async () => {
    const path = await rollout([
      record("turn_context", { turn_id: "selected" }),
      record("response_item", message("answer", "answer", "assistant")),
      record("event_msg", { type: "task_complete", turn_id: "selected" }),
    ]);

    const analysis = await analyzeForkRollout(path, "selected");

    expect(analysis.estimate.compressed.available).toBe(false);
    expect(analysis.estimate.compressed.unavailableReason).toContain("No safe compaction");
    expect(analysis.estimate.exact.available).toBe(true);
  });

  it("keeps exact available when the streamed agent-message schema cannot validate compression", async () => {
    const path = await rollout([
      record("compacted", {
        message: "",
        replacement_history: [message("summary", "context")],
      }),
      record("turn_context", { turn_id: "selected" }),
      record("response_item", {
        type: "reasoning",
        id: "unsupported-agent-shape",
        summary: [],
        content: null,
      }),
      record("event_msg", { type: "task_complete", turn_id: "selected" }),
    ]);

    const analysis = await analyzeForkRollout(path, "selected", "selected-answer");

    expect(analysis.forkPointValidation).toBe("unknown");
    expect(analysis.estimate.compressed.available).toBe(false);
    expect(analysis.estimate.exact.available).toBe(true);
  });

  it("detects the original compact item after materialization", async () => {
    const path = await rollout([
      record("response_item", {
        type: "compaction",
        id: "cmp_original",
        encrypted_content: "opaque",
        internal_chat_message_metadata_passthrough: { turn_id: "injected" },
      }),
    ]);

    await expect(hasForkMaterializedCompaction(path, "cmp_original")).resolves.toBe(true);
    await expect(hasForkMaterializedCompaction(path, "cmp_different")).resolves.toBe(false);
  });

  it("reads only a newly appended compaction replacement", async () => {
    const path = await rollout([
      record("compacted", {
        message: "",
        replacement_history: [message("old-summary", "old context")],
      }),
    ]);
    const startBytes = (await stat(path)).size;
    await appendFile(
      path,
      `${record("compacted", {
        message: "",
        replacement_history: [
          message("fresh-summary", "fresh context"),
          { type: "compaction", id: "encrypted", encrypted_content: "opaque" },
        ],
      })}\n`,
      "utf8",
    );

    await expect(readFreshCompaction(path, startBytes)).resolves.toEqual([
      message("fresh-summary", "fresh context"),
      { type: "compaction", id: "encrypted", encrypted_content: "opaque" },
    ]);
  });

  it("rejects malformed or duplicate post-baseline compactions", async () => {
    const malformed = await rollout([record("session_meta", { id: "temporary" })]);
    const malformedStart = (await stat(malformed)).size;
    await appendFile(malformed, "{not-json}\n", "utf8");
    await expect(readFreshCompaction(malformed, malformedStart)).rejects.toThrow("malformed JSON");

    const duplicate = await rollout([record("session_meta", { id: "temporary" })]);
    const duplicateStart = (await stat(duplicate)).size;
    await appendFile(
      duplicate,
      `${record("compacted", { replacement_history: [message("first", "first")] })}\n${record(
        "compacted",
        { replacement_history: [message("second", "second")] },
      )}\n`,
      "utf8",
    );
    await expect(readFreshCompaction(duplicate, duplicateStart)).rejects.toThrow(
      "Multiple fresh compactions",
    );
  });
});

async function rollout(lines: string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codexnest-fork-rollout-test-"));
  directories.push(directory);
  const path = join(directory, "rollout.jsonl");
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
  return path;
}

function record(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", type, payload });
}

function message(id: string, text: string, role = "user"): Record<string, unknown> {
  return {
    type: "message",
    id,
    role,
    content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
  };
}
