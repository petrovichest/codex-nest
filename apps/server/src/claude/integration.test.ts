import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { ThreadOutcome } from "@codexnest/protocol";

import { AttentionManager } from "../attention";
import { StateStore } from "../state/store";
import { ClaudeBackend } from "./backend";
import { DEFAULT_CLAUDE_MODELS } from "./models";
import { loadRealSdk } from "./sdk";

// Gated smoke test: hits the real Claude CLI, so it is skipped unless RUN_CLAUDE_INTEGRATION=1.
// Keep it cheap — one haiku turn with a trivial prompt. Set CLAUDE_BIN to override the path.
const RUN = process.env.RUN_CLAUDE_INTEGRATION === "1";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "/Users/oryuro/.local/bin/claude";

const directories: string[] = [];
afterAll(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.skipIf(!RUN)("Claude live integration (RUN_CLAUDE_INTEGRATION=1)", () => {
  it("runs a real haiku turn end-to-end and completes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codexnest-claude-integration-"));
    directories.push(dir);
    const store = new StateStore(join(dir, "state.json"));
    await store.load();
    const backend = new ClaudeBackend({
      store,
      sdk: await loadRealSdk(),
      models: DEFAULT_CLAUDE_MODELS,
      bin: CLAUDE_BIN,
      attention: new AttentionManager(),
    });
    await backend.start();
    expect(backend.connection.state).toBe("ready");

    const thread = await backend.createThread("integration", dir, {
      collaborationMode: "default",
      model: "haiku",
    });
    const outcomes: ThreadOutcome[] = [];
    backend.on("event", (event) => {
      if (
        event.type === "thread.upserted" &&
        event.thread.id === thread.id &&
        !event.thread.currentTurnId
      ) {
        const state = event.thread.state;
        if (state === "completed" || state === "failed" || state === "interrupted")
          outcomes.push(state);
      }
    });

    await backend.startTurn(thread.id, {
      text: "Reply with exactly: ok",
      images: [],
      clientMessageId: null,
    });

    await waitFor(() => outcomes.length > 0, 600);
    expect(outcomes[0]).toBe("completed");

    const detail = await backend.readThread(thread.id);
    const agentText = detail.turns
      .at(-1)
      ?.items.filter((item) => item.type === "agentMessage")
      .map((item) => (item.type === "agentMessage" ? item.text : ""))
      .join("");
    expect(agentText?.toLowerCase()).toContain("ok");
    backend.stop();
    await store.flushed();
  }, 60_000);
});

async function waitFor(predicate: () => boolean, tries: number): Promise<void> {
  for (let index = 0; index < tries; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!predicate()) throw new Error("waitFor timed out");
}
