import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { ThreadOutcome } from "@codexnest/protocol";

import { AttentionManager } from "../attention";
import { StateStore } from "../state/store";
import { ClaudeBackend } from "./backend";
import { DEFAULT_CLAUDE_MODELS } from "./models";
import { buildClaudeTurns } from "./projection";
import { loadRealSdk, readClaudeVersion } from "./sdk";
import type { ClaudeQuery, ClaudeSdk, ClaudeTranscriptMessage } from "./sdk";

// Two opt-in gates, both off by default so the normal suite never touches the CLI:
//   RUN_CLAUDE_INTEGRATION=1       — cheap real-CLI checks that make NO model calls
//                                    (version probe + a captured-transcript projection read).
//   RUN_CLAUDE_INTEGRATION_TURN=1  — the ONE real model turn (also requires the flag above);
//                                    a tiny haiku turn that pins includePartialMessages.
// CLAUDE_BIN overrides the binary path (defaults to this dev Mac's install).
const RUN = process.env.RUN_CLAUDE_INTEGRATION === "1";
const RUN_TURN = RUN && process.env.RUN_CLAUDE_INTEGRATION_TURN === "1";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "/Users/oryuro/.local/bin/claude";

const directories: string[] = [];
afterAll(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.skipIf(!RUN)("Claude live integration (RUN_CLAUDE_INTEGRATION=1)", () => {
  it("probes the real Claude CLI version (no model call)", async () => {
    const version = await readClaudeVersion(CLAUDE_BIN);
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("projects a captured real-CLI transcript fixture (no model call)", () => {
    // The fixtures are real getSessionMessages output captured from the Claude CLI
    // during the Stage 0 spike; asserting the current projection still consumes them
    // guards the read path against SDK transcript-shape drift. projection.test.ts owns
    // the exhaustive item-by-item assertions — this is the integration-level smoke.
    const raw = readFileSync(new URL("./fixtures/session-tools.json", import.meta.url), "utf8");
    const { messages } = JSON.parse(raw) as { messages: ClaudeTranscriptMessage[] };
    const turns = buildClaudeTurns(messages, "/tmp/project");
    expect(turns.length).toBeGreaterThanOrEqual(1);
    const items = turns.flatMap((turn) => turn.items);
    expect(items.some((item) => item.type === "agentMessage")).toBe(true);
  });
});

describe.skipIf(!RUN_TURN)("Claude real turn (RUN_CLAUDE_INTEGRATION_TURN=1)", () => {
  it("streams partial text deltas before the final assistant message and completes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codexnest-claude-integration-"));
    directories.push(dir);
    const store = new StateStore(join(dir, "state.json"));
    await store.load();
    // Observe the raw SDK message stream so we can pin includePartialMessages: at least
    // one stream_event text delta must arrive before the final structural assistant message.
    const markers: StreamMarker[] = [];
    const backend = new ClaudeBackend({
      store,
      sdk: observeSdk(await loadRealSdk(), markers),
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

    // includePartialMessages confirmation: a text delta streamed in before the final message.
    const firstDelta = markers.indexOf("delta");
    const lastAssistant = markers.lastIndexOf("assistant");
    expect(firstDelta).toBeGreaterThanOrEqual(0);
    expect(lastAssistant).toBeGreaterThanOrEqual(0);
    expect(firstDelta).toBeLessThan(lastAssistant);

    backend.stop();
    await store.flushed();
  }, 60_000);
});

type StreamMarker = "delta" | "assistant" | "result";

interface RawSdkMessage {
  type?: string;
  parent_tool_use_id?: string | null;
  event?: { type?: string; delta?: { type?: string } };
}

/**
 * Wraps a real SDK so every live-turn message is recorded as a coarse marker while it
 * passes through untouched. interrupt/setPermissionMode delegate to the real query.
 */
function observeSdk(sdk: ClaudeSdk, markers: StreamMarker[]): ClaudeSdk {
  return {
    ...sdk,
    query: (params) => {
      const inner = sdk.query(params);
      const wrapped = (async function* () {
        for await (const message of inner) {
          record(message as RawSdkMessage, markers);
          yield message;
        }
      })() as ClaudeQuery;
      wrapped.interrupt = () => inner.interrupt();
      if (inner.setPermissionMode) {
        wrapped.setPermissionMode = (mode: string) => inner.setPermissionMode!(mode);
      }
      return wrapped;
    },
  };
}

function record(message: RawSdkMessage, markers: StreamMarker[]): void {
  if (message.parent_tool_use_id) return; // sub-agent stream; not the main-thread turn
  if (message.type === "stream_event") {
    if (message.event?.type === "content_block_delta" && message.event.delta?.type === "text_delta")
      markers.push("delta");
    return;
  }
  if (message.type === "assistant") markers.push("assistant");
  else if (message.type === "result") markers.push("result");
}

async function waitFor(predicate: () => boolean, tries: number): Promise<void> {
  for (let index = 0; index < tries; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!predicate()) throw new Error("waitFor timed out");
}
