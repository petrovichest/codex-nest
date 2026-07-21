import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AttentionManager } from "./attention";
import type { CodexBridge } from "./codex/bridge";
import type { ServerNotification } from "./codex/generated/index";
import type { Thread } from "./codex/generated/v2/index";
import { AppProjection } from "./projection";
import { StateStore } from "./state/store";

class FakeBridge extends EventEmitter {
  state = "ready" as const;
  request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "thread/list") {
      if (params.archived) return { data: [], nextCursor: null, backwardsCursor: null };
      if (!params.cursor)
        return { data: [thread("one", "/work", 5)], nextCursor: "next", backwardsCursor: null };
      return { data: [thread("two", "/work/nested", 4)], nextCursor: null, backwardsCursor: null };
    }
    if (method === "model/list") {
      return {
        data: [
          {
            id: "gpt",
            model: "gpt",
            displayName: "GPT",
            description: "",
            hidden: false,
            supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }],
            defaultReasoningEffort: "high",
            inputModalities: ["text"],
            supportsPersonality: true,
            additionalSpeedTiers: [],
            serviceTiers: [],
            defaultServiceTier: null,
            isDefault: true,
          },
        ],
        nextCursor: null,
      };
    }
    if (method === "thread/turns/list")
      return {
        data: [
          {
            id: "last",
            items: [],
            itemsView: "notLoaded",
            status: "completed",
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
          },
        ],
        nextCursor: null,
        backwardsCursor: null,
      };
    throw new Error(`Unexpected ${method}`);
  });
}

const directories: string[] = [];
afterEach(async () =>
  Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  ),
);

describe("AppProjection", () => {
  it("paginates exact thread count, reconciles outcomes once, and updates live terminal state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.projects.push({
        id: "root",
        displayName: "Root",
        path: "/work",
        createdAt: "x",
        updatedAt: "x",
      });
      state.projects.push({
        id: "nested",
        displayName: "Nested",
        path: "/work/nested",
        createdAt: "x",
        updatedAt: "x",
      });
    });
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );
    await projection.sync();
    expect(projection.threadCount).toBe(2);
    expect(projection.summary("two")?.projectId).toBe("nested");
    expect(projection.summary("one")?.settings).toEqual({
      collaborationMode: "default",
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
    });
    expect(projection.summary("one")).toMatchObject({ state: "completed", unread: false });
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/turns/list"),
    ).toHaveLength(2);
    await projection.sync();
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/turns/list"),
    ).toHaveLength(2);

    bridge.emit("notification", {
      method: "turn/started",
      params: {
        threadId: "one",
        turn: {
          id: "live",
          items: [],
          itemsView: "summary",
          status: "inProgress",
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      },
    } satisfies ServerNotification);
    expect(projection.summary("one")?.state).toBe("running");
    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "one",
        turn: {
          id: "live",
          items: [],
          itemsView: "summary",
          status: "failed",
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      },
    } satisfies ServerNotification);
    await vi.waitFor(() =>
      expect(projection.summary("one")).toMatchObject({ state: "failed", unread: true }),
    );
    await store.flushed();
  });
});

function thread(id: string, cwd: string, updatedAt: number): Thread {
  return {
    id,
    extra: null,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: id,
    ephemeral: false,
    historyMode: "full",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt,
    recencyAt: updatedAt,
    status: { type: "idle" },
    path: null,
    cwd,
    cliVersion: "0.144.6",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}
