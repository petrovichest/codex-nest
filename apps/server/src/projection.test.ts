import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AttentionManager } from "./attention";
import type { CodexBridge } from "./codex/bridge";
import type { ServerNotification } from "./codex/generated/index";
import type { Thread } from "./codex/generated/v2/index";
import { AppProjection, diffStats } from "./projection";
import { StateStore } from "./state/store";

class FakeBridge extends EventEmitter {
  state = "ready" as const;
  constructor(private readonly active = false) {
    super();
  }
  request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "thread/list") {
      if (params.archived) return { data: [], nextCursor: null, backwardsCursor: null };
      if (!params.cursor)
        return {
          data: [
            thread(
              "one",
              "/work",
              5,
              this.active ? { type: "active", activeFlags: [] } : { type: "idle" },
            ),
          ],
          nextCursor: "next",
          backwardsCursor: null,
        };
      return { data: [thread("two", "/work/nested", 4)], nextCursor: null, backwardsCursor: null };
    }
    if (method === "thread/resume") return { thread: liveThread() };
    if (method === "thread/read") return { thread: liveThread() };
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
  it("counts files and changed lines in an aggregated turn diff", () => {
    expect(
      diffStats(
        "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n-old\n+new\ndiff --git a/b.ts b/b.ts\n+++ b/b.ts\n+added",
      ),
    ).toEqual({ filesChanged: 2, additions: 2, deletions: 1 });
  });

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
      state.threadMeta.one = {
        pinned: false,
        lastReadUpdatedAt: 5_000,
        settings: {
          collaborationMode: "default",
          sandboxMode: "read-only",
          approvalPolicy: "never",
          approvalsReviewer: "auto_review",
        } as never,
      };
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
    });
    expect(projection.summary("one")).toMatchObject({ state: "completed", unread: false });
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/turns/list"),
    ).toHaveLength(2);
    await projection.sync();
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/turns/list"),
    ).toHaveLength(2);

    const events: Array<{ type: string; [key: string]: unknown }> = [];
    projection.on("event", (_sequence, event) => events.push(event));
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
          startedAt: 123,
          completedAt: null,
          durationMs: null,
        },
      },
    } satisfies ServerNotification);
    expect(projection.summary("one")?.state).toBe("running");
    bridge.emit("notification", {
      method: "turn/plan/updated",
      params: {
        threadId: "one",
        turnId: "live",
        explanation: "Проверяем",
        plan: [
          { step: "Первый", status: "completed" },
          { step: "Второй", status: "inProgress" },
        ],
      },
    } satisfies ServerNotification);
    bridge.emit("notification", {
      method: "turn/diff/updated",
      params: {
        threadId: "one",
        turnId: "live",
        diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n-old\n+new",
      },
    } satisfies ServerNotification);
    await vi.waitFor(() =>
      expect(events.filter((event) => event.type === "turn.progressed").at(-1)).toMatchObject({
        progress: {
          startedAt: 123_000,
          explanation: "Проверяем",
          steps: [
            { step: "Первый", status: "completed" },
            { step: "Второй", status: "inProgress" },
          ],
          filesChanged: 1,
          additions: 1,
          deletions: 1,
        },
      }),
    );
    projection.setCurrentTurn("one", "steered");
    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "one",
        turn: {
          id: "live",
          items: [],
          itemsView: "summary",
          status: "interrupted",
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      },
    } satisfies ServerNotification);
    expect(projection.summary("one")).toMatchObject({
      state: "running",
      currentTurnId: "steered",
    });
    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "one",
        turn: {
          id: "steered",
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

  it("rejoins and restores an active turn once per app-server connection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge(true);
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );

    await projection.sync();
    expect(projection.summary("one")).toMatchObject({
      state: "running",
      currentTurnId: "live",
    });
    expect(bridge.request.mock.calls.filter(([method]) => method === "thread/resume")).toHaveLength(
      1,
    );
    expect((await projection.readThread("one")).turns[0]).toMatchObject({
      id: "live",
      status: "inProgress",
      progress: { startedAt: 3_000 },
      items: [{ id: "answer", type: "agentMessage", text: "В процессе" }],
    });

    await projection.sync();
    expect(bridge.request.mock.calls.filter(([method]) => method === "thread/resume")).toHaveLength(
      1,
    );

    bridge.emit("state", "unavailable");
    bridge.emit("state", "ready");
    await projection.sync();
    expect(bridge.request.mock.calls.filter(([method]) => method === "thread/resume")).toHaveLength(
      2,
    );
  });
});

function thread(
  id: string,
  cwd: string,
  updatedAt: number,
  status: Thread["status"] = { type: "idle" },
  turns: Thread["turns"] = [],
): Thread {
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
    status,
    path: null,
    cwd,
    cliVersion: "0.144.6",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns,
  };
}

function liveThread(): Thread {
  return thread("one", "/work", 5, { type: "active", activeFlags: [] }, [
    {
      id: "live",
      items: [
        {
          type: "agentMessage",
          id: "answer",
          text: "В процессе",
          phase: null,
        },
      ],
      itemsView: "full",
      status: "inProgress",
      error: null,
      startedAt: 3,
      completedAt: null,
      durationMs: null,
    },
  ]);
}
