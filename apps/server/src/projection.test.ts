import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActivityItem, ThreadGoal } from "@codexnest/protocol";

import { AttentionManager } from "./attention";
import type { CodexBridge } from "./codex/bridge";
import type { ServerNotification, ServerRequest } from "./codex/generated/index";
import { RpcError, type JsonlTransport } from "./codex/transport";
import type { Thread } from "./codex/generated/v2/index";
import { AppProjection, diffStats } from "./projection";
import { StateStore } from "./state/store";

class FakeBridge extends EventEmitter {
  state = "ready" as const;
  constructor(
    private readonly active = false,
    private readonly activeGoal = false,
    private readonly resumedUpdatedAt = 5,
  ) {
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
    if (method === "thread/resume") return { thread: liveThread(this.resumedUpdatedAt) };
    if (method === "thread/read") return { thread: liveThread() };
    if (method === "thread/name/set") return {};
    if (method === "thread/goal/get") {
      return { goal: this.activeGoal ? goalNotification("active").params.goal : null };
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
    if (method === "thread/turns/list" && this.active && params.itemsView === "summary") {
      return {
        data: liveThread().turns,
        nextCursor: null,
        backwardsCursor: null,
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
  it("forwards skill catalog invalidations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );
    const events: Array<{ type: string }> = [];
    projection.on("event", (_sequence, event) => events.push(event));

    bridge.emit("notification", {
      method: "skills/changed",
      params: {},
    } satisfies ServerNotification);

    await vi.waitFor(() => expect(events).toContainEqual({ type: "skills.changed" }));
  });

  it("counts files and changed lines in an aggregated turn diff", () => {
    expect(
      diffStats(
        "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n-old\n+new\ndiff --git a/b.ts b/b.ts\n+++ b/b.ts\n+added",
      ),
    ).toEqual({ filesChanged: 2, additions: 2, deletions: 1 });
  });

  it("reuses one zero-copy state view while materializing thread views", async () => {
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
      state.threadMeta.empty = {
        pinned: false,
        lastReadUpdatedAt: 0,
        unmaterialized: true,
      };
    });
    const projection = new AppProjection(
      new FakeBridge() as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );
    const stateViews = vi.spyOn(store, "view");

    projection.upsertThread(thread("one", "/work", 1));
    expect(stateViews).toHaveBeenCalledTimes(1);

    stateViews.mockClear();
    projection.upsertThread({ ...thread("empty", "/work", 2), preview: "" });
    expect(stateViews).toHaveBeenCalledTimes(1);

    stateViews.mockClear();
    expect(projection.snapshot().threads.map((candidate) => candidate.id)).toEqual([
      "empty",
      "one",
    ]);
    expect(stateViews).toHaveBeenCalledTimes(1);

    stateViews.mockClear();
    expect(projection.emptyThreadCandidates("root")).toEqual([
      {
        thread: expect.objectContaining({ id: "empty", projectId: "root" }),
        knownUnmaterialized: true,
      },
    ]);
    expect(stateViews).toHaveBeenCalledTimes(1);
  });

  it("skips outcome reconciliation for unmaterialized threads during full sync", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.threadMeta.one = {
        pinned: false,
        lastReadUpdatedAt: 0,
        unmaterialized: true,
      };
    });
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );

    await expect(projection.sync()).resolves.toBeUndefined();

    const outcomeReads = bridge.request.mock.calls.filter(
      ([method]) => method === "thread/turns/list",
    );
    expect(outcomeReads.map(([, params]) => params.threadId)).toEqual(["two"]);
  });

  it("does not reactivate a turn after its completion notification wins the response race", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );
    projection.upsertThread(thread("one", "/work", 10));
    await projection.setCurrentTurn("one", "turn");

    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "one",
        turn: {
          id: "turn",
          items: [],
          itemsView: "summary",
          status: "completed",
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      },
    } satisfies ServerNotification);
    await vi.waitFor(() => expect(projection.summary("one")?.currentTurnId).toBeNull());

    await projection.setCurrentTurn("one", "turn");
    expect(projection.summary("one")).toMatchObject({
      state: "completed",
      currentTurnId: null,
    });
    await store.flushed();
  });

  it("does not roll a live turn back when a stale full sync finishes later", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new EventEmitter() as EventEmitter & {
      state: "ready";
      request: ReturnType<typeof vi.fn>;
    };
    bridge.state = "ready";
    let releaseList!: () => void;
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    bridge.request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/list") {
        if (params.archived) return { data: [], nextCursor: null, backwardsCursor: null };
        await listGate;
        return {
          data: [thread("one", "/work", 5, { type: "idle" })],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      if (method === "thread/loaded/list") return { data: [], nextCursor: null };
      if (method === "model/list") return { data: [], nextCursor: null };
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );
    projection.upsertThread(thread("one", "/work", 5, { type: "idle" }));

    const syncing = projection.sync();
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
          startedAt: 10,
          completedAt: null,
          durationMs: null,
        },
      },
    } satisfies ServerNotification);
    await vi.waitFor(() => expect(projection.summary("one")?.currentTurnId).toBe("live"));
    releaseList();
    await syncing;

    expect(projection.summary("one")).toMatchObject({ state: "running", currentTurnId: "live" });
  });

  it("does not resurrect a thread deleted while a full sync is listing it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new EventEmitter() as EventEmitter & {
      state: "ready";
      request: ReturnType<typeof vi.fn>;
    };
    bridge.state = "ready";
    let releaseList!: () => void;
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    bridge.request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/list") {
        if (params.archived) return { data: [], nextCursor: null, backwardsCursor: null };
        await listGate;
        return {
          data: [thread("one", "/work", 5, { type: "idle" })],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      if (method === "thread/loaded/list") return { data: [], nextCursor: null };
      if (method === "model/list") return { data: [], nextCursor: null };
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );
    projection.upsertThread(thread("one", "/work", 5, { type: "idle" }));

    const syncing = projection.sync();
    bridge.emit("notification", {
      method: "thread/deleted",
      params: { threadId: "one" },
    } satisfies ServerNotification);
    await vi.waitFor(() => expect(projection.summary("one")).toBeUndefined());
    releaseList();
    await syncing;

    expect(projection.summary("one")).toBeUndefined();
  });

  it("projects managed spawn tools as linked subagent launch activities", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );
    const activities: ActivityItem[] = [];
    projection.on("event", (_sequence, event) => {
      if (event.type === "activity.upserted") activities.push(event.item);
    });

    bridge.emit("notification", {
      method: "item/started",
      params: {
        threadId: "one",
        turnId: "parent-turn",
        item: {
          type: "dynamicToolCall",
          id: "spawn-child",
          namespace: "codexnest",
          tool: "spawn_task",
          arguments: {
            title: "Проверить интерфейс",
            prompt: "Review the interface.",
          },
          status: "inProgress",
          contentItems: null,
          success: null,
        },
        startedAtMs: 1_000,
      },
    } satisfies ServerNotification);
    bridge.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "one",
        turnId: "parent-turn",
        item: {
          type: "dynamicToolCall",
          id: "spawn-child",
          namespace: "codexnest",
          tool: "spawn_task",
          arguments: {
            title: "Проверить интерфейс",
            prompt: "Review the interface.",
          },
          status: "completed",
          contentItems: [
            {
              type: "inputText",
              text: JSON.stringify({
                taskId: "task",
                threadId: "child",
                status: "queued",
              }),
            },
          ],
          success: true,
        },
        completedAtMs: 2_000,
      },
    } satisfies ServerNotification);

    expect(activities).toEqual([
      {
        type: "subagentLaunch",
        id: "spawn-child",
        status: "inProgress",
        title: "Проверить интерфейс",
        threadId: null,
      },
      {
        type: "subagentLaunch",
        id: "spawn-child",
        status: "completed",
        title: "Проверить интерфейс",
        threadId: "child",
      },
    ]);
  });

  it("keeps ephemeral helper threads out of the client projection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );
    const events: Array<{ type: string }> = [];
    projection.on("event", (_sequence, event) => events.push(event));
    const hidden = { ...thread("title", "/work", 1), ephemeral: true };

    bridge.emit("notification", {
      method: "thread/started",
      params: { thread: hidden },
    } satisfies ServerNotification);
    bridge.emit("notification", {
      method: "turn/started",
      params: {
        threadId: hidden.id,
        turn: {
          id: "title-turn",
          items: [],
          itemsView: "summary",
          status: "inProgress",
          error: null,
          startedAt: 1,
          completedAt: null,
          durationMs: null,
        },
      },
    } satisfies ServerNotification);

    expect(projection.threadCount).toBe(0);
    expect(events).toEqual([]);
  });

  it("projects native spawned subagents and keeps them after they close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );
    const child = {
      ...thread("child", "/work", 2),
      ephemeral: true,
      parentThreadId: "one",
      agentNickname: "tester",
      agentRole: "worker",
    };

    bridge.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "one",
        turnId: "parent-turn",
        item: {
          type: "collabAgentToolCall",
          id: "spawn-child",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: "one",
          receiverThreadIds: ["child"],
          prompt: "Task: Проверить мобильную вёрстку субагента\n\nПроверить экран на узкой ширине.",
          model: null,
          reasoningEffort: null,
          agentsStates: {},
        },
        completedAtMs: 1_000,
      },
    } satisfies ServerNotification);
    bridge.emit("notification", {
      method: "thread/started",
      params: { thread: child },
    } satisfies ServerNotification);

    await vi.waitFor(() =>
      expect(projection.summary("child")).toMatchObject({
        title: "Проверить мобильную вёрстку субагента",
        relation: {
          kind: "subagent",
          sessionId: "child",
          parentThreadId: "one",
          nickname: "tester",
          role: "worker",
        },
      }),
    );
    expect(bridge.request).toHaveBeenCalledWith("thread/name/set", {
      threadId: "child",
      name: "Проверить мобильную вёрстку субагента",
    });

    bridge.emit("notification", {
      method: "thread/closed",
      params: { threadId: "child" },
    } satisfies ServerNotification);

    expect(projection.summary("child")).toMatchObject({
      id: "child",
      state: "idle",
      currentTurnId: null,
    });
  });

  it("deduplicates native wait delivery and bounds replay markers to the source event", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      for (const threadId of ["child-a", "child-b"]) {
        state.threadMeta[threadId] = {
          pinned: false,
          lastReadUpdatedAt: 0,
          lastOutcome: "completed",
          outcomeUpdatedAt: 10_000,
        };
      }
    });
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );
    for (const threadId of ["child-a", "child-b"]) {
      projection.upsertThread({
        ...thread(threadId, "/work", 10),
        parentThreadId: "one",
        ephemeral: true,
      });
    }
    expect(projection.summary("child-a")?.unread).toBe(true);
    expect(projection.summary("child-b")?.unread).toBe(true);

    const updates = vi.spyOn(store, "update");
    const published: string[] = [];
    projection.on("event", (_sequence, event) => {
      if (event.type === "thread.upserted") published.push(event.thread.id);
    });
    const firstWait = collabWaitNotification("wait-first", "completed", ["child-a", "child-b"], {
      "child-a": { status: "completed", message: "Result A" },
      "child-b": { status: "completed", message: "Result B" },
    });
    bridge.emit("notification", firstWait);
    bridge.emit("notification", firstWait);

    await vi.waitFor(() => {
      expect(store.snapshot().threadMeta["child-a"]?.lastReadUpdatedAt).toBe(10_000);
      expect(store.snapshot().threadMeta["child-b"]?.lastReadUpdatedAt).toBe(10_000);
    });
    expect(updates).toHaveBeenCalledTimes(1);
    expect(projection.summary("child-a")?.unread).toBe(false);
    expect(projection.summary("child-b")?.unread).toBe(false);
    expect(published).toEqual(expect.arrayContaining(["child-a", "child-b"]));

    bridge.emit("notification", firstWait);
    await nextImmediate();
    expect(updates).toHaveBeenCalledTimes(1);

    projection.upsertThread({
      ...thread("child-a", "/work", 11),
      parentThreadId: "one",
      ephemeral: true,
    });
    expect(projection.summary("child-a")?.unread).toBe(true);
    bridge.emit("notification", firstWait);
    await nextImmediate();
    expect(updates).toHaveBeenCalledTimes(1);
    expect(store.snapshot().threadMeta["child-a"]?.lastReadUpdatedAt).toBe(10_000);
    expect(projection.summary("child-a")?.unread).toBe(true);

    const replayBridge = new FakeBridge();
    const replayProjection = new AppProjection(
      replayBridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );
    replayProjection.upsertThread({
      ...thread("child-a", "/work", 11),
      parentThreadId: "one",
      ephemeral: true,
    });
    replayBridge.emit("notification", firstWait);
    await vi.waitFor(() =>
      expect(store.snapshot().threadMeta["child-a"]?.lastReadUpdatedAt).toBe(10_500),
    );
    expect(replayProjection.summary("child-a")?.unread).toBe(true);

    replayBridge.emit(
      "notification",
      collabWaitNotification(
        "wait-second",
        "completed",
        ["child-a"],
        {
          "child-a": { status: "completed", message: "A newer result" },
        },
        11_500,
      ),
    );

    await vi.waitFor(() =>
      expect(store.snapshot().threadMeta["child-a"]?.lastReadUpdatedAt).toBe(11_000),
    );
    expect(replayProjection.summary("child-a")?.unread).toBe(false);
  });

  it("does not clear native subagents for timeout, running, empty, or failed results", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.threadMeta.child = {
        pinned: false,
        lastReadUpdatedAt: 0,
        lastOutcome: "completed",
        outcomeUpdatedAt: 10_000,
      };
    });
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );
    projection.upsertThread({
      ...thread("child", "/work", 10),
      parentThreadId: "one",
      ephemeral: true,
    });
    const updates = vi.spyOn(store, "update");

    bridge.emit(
      "notification",
      collabWaitNotification("wait-timeout", "failed", ["child"], {
        child: { status: "completed", message: "Late result" },
      }),
    );
    bridge.emit(
      "notification",
      collabWaitNotification("wait-running", "completed", ["child"], {
        child: { status: "running", message: "Still running" },
      }),
    );
    bridge.emit(
      "notification",
      collabWaitNotification("wait-empty", "completed", ["child"], {
        child: { status: "completed", message: "   " },
      }),
    );
    bridge.emit(
      "notification",
      collabWaitNotification("wait-errored", "completed", ["child"], {
        child: { status: "errored", message: "Failed" },
      }),
    );
    bridge.emit(
      "notification",
      collabWaitNotification("wait-interrupted", "completed", ["child"], {
        child: { status: "interrupted", message: "Interrupted" },
      }),
    );
    await nextImmediate();

    expect(updates).not.toHaveBeenCalled();
    expect(store.snapshot().threadMeta.child?.lastReadUpdatedAt).toBe(0);
    expect(projection.summary("child")?.unread).toBe(true);
  });

  it("applies managed result markers only with the first atomic artifact insert", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      for (const [threadId, outcome] of [
        ["completed-child", "completed"],
        ["failed-child", "failed"],
        ["interrupted-child", "interrupted"],
      ] as const) {
        state.threadMeta[threadId] = {
          pinned: false,
          lastReadUpdatedAt: 0,
          lastOutcome: outcome,
          outcomeUpdatedAt: 10_000,
        };
      }
    });
    const projection = new AppProjection(
      new FakeBridge() as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );
    projection.upsertThread(thread("parent", "/work", 10));
    for (const threadId of ["completed-child", "failed-child", "interrupted-child"]) {
      projection.upsertThread({
        ...thread(threadId, "/work", 10),
        parentThreadId: "parent",
        ephemeral: true,
      });
    }
    const agents = [
      {
        threadId: "completed-child",
        title: "Completed",
        nickname: null,
        outcome: "completed" as const,
      },
      {
        threadId: "failed-child",
        title: "Failed",
        nickname: null,
        outcome: "failed" as const,
      },
      {
        threadId: "interrupted-child",
        title: "Interrupted",
        nickname: null,
        outcome: "interrupted" as const,
      },
    ];

    const first = projection.recordOrchestrationNotice("parent", "parent-turn", agents, null);
    const duplicate = projection.recordOrchestrationNotice("parent", "parent-turn", agents, null);
    projection.upsertThread({
      ...thread("completed-child", "/work", 11),
      parentThreadId: "parent",
      ephemeral: true,
    });
    await Promise.all([first, duplicate]);

    expect(store.snapshot().threadMeta.parent?.timelineArtifacts?.["parent-turn"]).toHaveLength(1);
    expect(store.snapshot().threadMeta["completed-child"]?.lastReadUpdatedAt).toBe(10_000);
    expect(store.snapshot().threadMeta["failed-child"]?.lastReadUpdatedAt).toBe(0);
    expect(store.snapshot().threadMeta["interrupted-child"]?.lastReadUpdatedAt).toBe(0);
    expect(projection.summary("completed-child")?.unread).toBe(true);
    expect(projection.summary("failed-child")?.unread).toBe(true);
    expect(projection.summary("interrupted-child")?.unread).toBe(true);

    await projection.recordOrchestrationNotice("parent", "parent-turn", agents, null);
    expect(store.snapshot().threadMeta["completed-child"]?.lastReadUpdatedAt).toBe(10_000);
    expect(projection.summary("completed-child")?.unread).toBe(true);

    await projection.recordOrchestrationNotice("parent", "next-parent-turn", [agents[0]!], null);
    expect(store.snapshot().threadMeta["completed-child"]?.lastReadUpdatedAt).toBe(11_000);
    expect(projection.summary("completed-child")?.unread).toBe(false);
  });

  it("persists rich managed result notices without dropping v2 metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const projection = new AppProjection(
      new FakeBridge() as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );
    const agent = {
      threadId: "child",
      taskId: "task-v2",
      title: "Review the client",
      nickname: "reviewer",
      outcome: "completed" as const,
      result: {
        outcome: "partial" as const,
        summary: "The presentation is implemented.",
        checks: [{ name: "client tests", outcome: "passed" as const, details: "12 passed" }],
      },
      budgetReason: "tokenBudget" as const,
      failureReason: "One optional visual check was not run.",
      changedPaths: ["apps/client/src/components/ThreadPage.tsx"],
      changedPathCount: 24,
      workspaceIntegrationStatus: "integrated" as const,
    };

    await projection.recordOrchestrationNotice("parent", "parent-turn", [agent], null);

    expect(store.snapshot().threadMeta.parent?.timelineArtifacts?.["parent-turn"]).toEqual([
      expect.objectContaining({
        type: "orchestrationNotice",
        id: "orchestration-parent-turn-child",
        agents: [agent],
      }),
    ]);
  });

  it("recovers loaded subagents omitted from thread/list once per connection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const parent = thread("parent", "/work", 2, { type: "notLoaded" });
    const child = {
      ...thread("child", "/work", 3, { type: "active", activeFlags: [] }),
      parentThreadId: "parent",
      ephemeral: true,
      agentNickname: "reviewer",
      agentRole: "worker",
      name: "Проверить восстановление",
    };
    bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/list") {
        return {
          data: params.archived ? [] : [parent],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      if (method === "thread/loaded/list") {
        return { data: ["parent", "child"], nextCursor: null };
      }
      if (method === "thread/read" && params.threadId === "child") {
        return { thread: child };
      }
      if (method === "thread/resume" && params.threadId === "parent") {
        return { thread: parent };
      }
      if (method === "model/list") return { data: [], nextCursor: null };
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );

    await projection.sync();

    expect(projection.summary("child")).toMatchObject({
      state: "running",
      relation: {
        kind: "subagent",
        parentThreadId: "parent",
        nickname: "reviewer",
      },
    });
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/loaded/list"),
    ).toHaveLength(1);
    expect(
      bridge.request.mock.calls.filter(
        ([method, params]) => method === "thread/read" && params.threadId === "child",
      ),
    ).toHaveLength(1);

    await projection.sync();

    expect(projection.summary("child")?.state).toBe("running");
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/loaded/list"),
    ).toHaveLength(1);
    expect(
      bridge.request.mock.calls.filter(
        ([method, params]) => method === "thread/read" && params.threadId === "child",
      ),
    ).toHaveLength(1);

    bridge.emit("state", "ready");
    await projection.sync();

    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/loaded/list"),
    ).toHaveLength(2);
    expect(
      bridge.request.mock.calls.filter(
        ([method, params]) => method === "thread/read" && params.threadId === "child",
      ),
    ).toHaveLength(2);
  });

  it("recovers and retains a loaded user session omitted from thread/list", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const omitted = thread("omitted", "/work", 7, { type: "notLoaded" });
    const resumed = {
      ...thread("omitted", "/work", 7, { type: "active", activeFlags: [] }),
      turns: [testTurn("live", "inProgress")],
    };
    bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/list") {
        return { data: [], nextCursor: null, backwardsCursor: null };
      }
      if (method === "thread/loaded/list") {
        return { data: ["omitted"], nextCursor: null };
      }
      if (method === "thread/read" && params.threadId === "omitted") {
        return { thread: omitted };
      }
      if (method === "thread/resume" && params.threadId === "omitted") {
        return { thread: resumed };
      }
      if (method === "thread/goal/get" && params.threadId === "omitted") {
        return { goal: null };
      }
      if (method === "model/list") return { data: [], nextCursor: null };
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );

    await projection.sync();

    expect(projection.summary("omitted")).toMatchObject({
      state: "running",
      currentTurnId: "live",
      relation: { kind: "session", sessionId: "omitted" },
    });
    expect(
      bridge.request.mock.calls.filter(
        ([method, params]) => method === "thread/read" && params.threadId === "omitted",
      ),
    ).toHaveLength(1);
    expect(
      bridge.request.mock.calls.filter(
        ([method, params]) => method === "thread/resume" && params.threadId === "omitted",
      ),
    ).toHaveLength(1);

    bridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "omitted", turn: testTurn("live", "completed") },
    } satisfies ServerNotification);
    await vi.waitFor(() =>
      expect(projection.summary("omitted")).toMatchObject({
        state: "completed",
        unread: true,
        currentTurnId: null,
      }),
    );

    await projection.sync();

    expect(projection.summary("omitted")).toMatchObject({ state: "completed", unread: true });
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/loaded/list"),
    ).toHaveLength(1);
    expect(
      bridge.request.mock.calls.filter(
        ([method, params]) => method === "thread/resume" && params.threadId === "omitted",
      ),
    ).toHaveLength(1);
  });

  it("hydrates user sessions from durable snapshots before app-server sync", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const statePath = join(directory, "state.json");
    const store = new StateStore(statePath);
    await store.load();
    const projection = new AppProjection(
      new FakeBridge() as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );
    projection.upsertThread(
      thread("persistent", "/work", 8, { type: "active", activeFlags: [] }, [
        testTurn("live", "inProgress"),
      ]),
    );
    projection.upsertThread(thread("archived", "/work", 7));
    await projection.setArchived("archived", true);
    await store.flushed();

    const reloadedStore = new StateStore(statePath);
    await reloadedStore.load();
    const bridge = new FakeBridge();
    bridge.request.mockImplementation(async (method: string) => {
      if (method === "thread/list") {
        return { data: [], nextCursor: null, backwardsCursor: null };
      }
      if (method === "thread/loaded/list") return { data: [], nextCursor: null };
      if (method === "model/list") return { data: [], nextCursor: null };
      throw new Error(`Unexpected ${method}`);
    });
    const reloaded = new AppProjection(
      bridge as unknown as CodexBridge,
      reloadedStore,
      new AttentionManager(),
      false,
    );

    expect(reloaded.summary("persistent")).toMatchObject({
      state: "running",
      currentTurnId: "live",
      title: "persistent",
    });
    expect(reloaded.summary("archived")?.archived).toBe(true);

    await reloaded.sync();

    expect(reloaded.summary("persistent")).toMatchObject({
      state: "running",
      currentTurnId: "live",
    });
    expect(reloaded.summary("archived")?.archived).toBe(true);
  });

  it("keeps a user session when app-server closes its in-memory thread", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.threadMeta.one = {
        pinned: false,
        lastReadUpdatedAt: 0,
        lastOutcome: "completed",
        outcomeUpdatedAt: 10_000,
      };
    });
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );
    projection.upsertThread(thread("one", "/work", 10));
    const removed: string[] = [];
    projection.on("event", (_sequence, event) => {
      if (event.type === "thread.removed") removed.push(event.threadId);
    });

    bridge.emit("notification", {
      method: "thread/closed",
      params: { threadId: "one" },
    } satisfies ServerNotification);

    await vi.waitFor(() =>
      expect(store.snapshot().threadMeta.one?.sessionSnapshot?.currentTurnId).toBeNull(),
    );
    expect(projection.summary("one")).toMatchObject({
      state: "completed",
      unread: true,
      currentTurnId: null,
    });
    expect(removed).toEqual([]);
  });

  it("retries loaded-session recovery after a transient app-server failure", async () => {
    vi.useFakeTimers();
    try {
      const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
      directories.push(directory);
      const store = new StateStore(join(directory, "state.json"));
      await store.load();
      const bridge = new FakeBridge();
      let loadedReads = 0;
      const omitted = thread("retry", "/work", 6, { type: "notLoaded" });
      const resumed = {
        ...thread("retry", "/work", 6, { type: "active", activeFlags: [] }),
        turns: [testTurn("live", "inProgress")],
      };
      bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
        if (method === "thread/list") {
          return { data: [], nextCursor: null, backwardsCursor: null };
        }
        if (method === "thread/loaded/list") {
          loadedReads += 1;
          if (loadedReads === 1) throw new Error("Thread index is warming up");
          return { data: ["retry"], nextCursor: null };
        }
        if (method === "thread/read" && params.threadId === "retry") {
          return { thread: omitted };
        }
        if (method === "thread/resume" && params.threadId === "retry") {
          return { thread: resumed };
        }
        if (method === "thread/goal/get") return { goal: null };
        if (method === "model/list") return { data: [], nextCursor: null };
        throw new Error(`Unexpected ${method}`);
      });
      const projection = new AppProjection(
        bridge as unknown as CodexBridge,
        store,
        new AttentionManager(),
        false,
      );

      await projection.sync();
      expect(projection.summary("retry")).toBeUndefined();

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(projection.summary("retry")).toMatchObject({
        state: "running",
        currentTurnId: "live",
      });
      expect(loadedReads).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes only loaded listed sessions whose status is notLoaded", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.threadMeta.idle = {
        pinned: false,
        lastReadUpdatedAt: 4_000,
        lastOutcome: "completed",
        outcomeUpdatedAt: 4_000,
        awaitingPlanResponse: false,
      };
    });
    const bridge = new FakeBridge();
    const notLoaded = thread("not-loaded", "/work", 5, { type: "notLoaded" });
    const idle = thread("idle", "/work", 4);
    const resumed = {
      ...thread("not-loaded", "/work", 5, { type: "active", activeFlags: [] }),
      turns: [testTurn("live", "inProgress")],
    };
    bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/list") {
        return {
          data: params.archived ? [] : [notLoaded, idle],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      if (method === "thread/loaded/list") {
        return { data: ["not-loaded", "idle"], nextCursor: null };
      }
      if (method === "thread/resume" && params.threadId === "not-loaded") {
        return { thread: resumed };
      }
      if (method === "thread/goal/get" && params.threadId === "not-loaded") {
        return { goal: null };
      }
      if (method === "model/list") return { data: [], nextCursor: null };
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );

    await projection.sync();

    expect(projection.summary("not-loaded")).toMatchObject({
      state: "running",
      currentTurnId: "live",
    });
    expect(projection.summary("idle")).toMatchObject({ state: "completed", unread: false });
    expect(
      bridge.request.mock.calls
        .filter(([method]) => method === "thread/resume")
        .map(([, params]) => params.threadId),
    ).toEqual(["not-loaded"]);
  });

  it("does not recover loaded internal sessions omitted from thread/list", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const execThread = { ...thread("exec", "/work", 3), source: "exec" as const };
    const ephemeralThread = { ...thread("ephemeral", "/work", 4), ephemeral: true };
    bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/list") {
        return { data: [], nextCursor: null, backwardsCursor: null };
      }
      if (method === "thread/loaded/list") {
        return { data: ["exec", "ephemeral"], nextCursor: null };
      }
      if (method === "thread/read" && params.threadId === "exec") {
        return { thread: execThread };
      }
      if (method === "thread/read" && params.threadId === "ephemeral") {
        return { thread: ephemeralThread };
      }
      if (method === "model/list") return { data: [], nextCursor: null };
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );

    await projection.sync();

    expect(projection.summary("exec")).toBeUndefined();
    expect(projection.summary("ephemeral")).toBeUndefined();
    expect(bridge.request.mock.calls.filter(([method]) => method === "thread/resume")).toHaveLength(
      0,
    );
  });

  it("recovers and retains loaded managed children omitted from thread/list", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.threadMeta.parent = {
        pinned: false,
        lastReadUpdatedAt: 0,
        teamOrchestration: {
          tasks: {
            task: {
              id: "task",
              childThreadId: "child",
              title: "Проверить восстановление",
              prompt: "Продолжить работу после рестарта.",
              status: "running",
              createdAt: 1,
              lastActivityAt: 1,
            },
          },
        },
      };
      state.threadMeta.child = {
        pinned: false,
        lastReadUpdatedAt: 0,
        managedParent: { parentThreadId: "parent", taskId: "task" },
      };
    });
    const bridge = new FakeBridge();
    const parent = thread("parent", "/work", 2, { type: "notLoaded" });
    const child = {
      ...thread("child", "/work", 3, { type: "active", activeFlags: [] }),
      name: "Проверить восстановление",
    };
    bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/list") {
        return {
          data: params.archived ? [] : [parent],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      if (method === "thread/loaded/list") {
        return { data: ["parent", "child"], nextCursor: null };
      }
      if (method === "thread/read" && params.threadId === "child") {
        return { thread: child };
      }
      if (method === "thread/resume" && params.threadId === "parent") {
        return { thread: parent };
      }
      if (method === "thread/resume" && params.threadId === "child") {
        return { thread: child };
      }
      if (method === "thread/goal/get" && params.threadId === "child") {
        return { goal: null };
      }
      if (method === "model/list") return { data: [], nextCursor: null };
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );

    await projection.sync();

    expect(projection.summary("child")).toMatchObject({
      state: "running",
      relation: {
        kind: "subagent",
        parentThreadId: "parent",
      },
    });
    expect(
      bridge.request.mock.calls.filter(
        ([method, params]) => method === "thread/read" && params.threadId === "child",
      ),
    ).toHaveLength(1);

    await projection.sync();

    expect(projection.summary("child")).toMatchObject({
      state: "running",
      relation: {
        kind: "subagent",
        parentThreadId: "parent",
      },
    });
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/loaded/list"),
    ).toHaveLength(1);
    expect(
      bridge.request.mock.calls.filter(
        ([method, params]) => method === "thread/read" && params.threadId === "child",
      ),
    ).toHaveLength(1);
  });

  it("retries persisted managed threads that are temporarily unavailable during sync", async () => {
    vi.useFakeTimers();
    try {
      const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
      directories.push(directory);
      const store = new StateStore(join(directory, "state.json"));
      await store.load();
      await store.update((state) => {
        state.threadMeta.parent = {
          pinned: false,
          lastReadUpdatedAt: 0,
          teamOrchestration: {
            tasks: {
              task: {
                id: "task",
                childThreadId: "child",
                title: "Продолжить после рестарта",
                prompt: "Восстановить временно отсутствующую задачу.",
                status: "running",
                createdAt: 1,
                lastActivityAt: 1,
              },
            },
          },
        };
        state.threadMeta.child = {
          pinned: false,
          lastReadUpdatedAt: 0,
          managedParent: { parentThreadId: "parent", taskId: "task" },
        };
      });
      const bridge = new FakeBridge();
      const reads = new Map<string, number>();
      bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
        if (method === "thread/list") {
          return { data: [], nextCursor: null, backwardsCursor: null };
        }
        if (method === "thread/loaded/list") return { data: [], nextCursor: null };
        if (method === "thread/read") {
          const threadId = String(params.threadId);
          const count = (reads.get(threadId) ?? 0) + 1;
          reads.set(threadId, count);
          if (count === 1) throw new Error("Thread index is still warming up");
          return {
            thread: {
              ...thread(threadId, "/work", threadId === "parent" ? 2 : 3),
              name: threadId === "parent" ? "Основная сессия" : "Дочерняя сессия",
            },
          };
        }
        if (method === "model/list") return { data: [], nextCursor: null };
        throw new Error(`Unexpected ${method}`);
      });
      const projection = new AppProjection(
        bridge as unknown as CodexBridge,
        store,
        new AttentionManager(),
        false,
      );

      await projection.sync();

      expect(projection.summary("parent")).toBeUndefined();
      expect(projection.summary("child")).toBeUndefined();

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(projection.summary("parent")).toMatchObject({
        title: "Основная сессия",
        relation: { kind: "session", sessionId: "parent" },
      });
      expect(projection.summary("child")).toBeUndefined();

      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(projection.summary("child")).toMatchObject({
        title: "Дочерняя сессия",
        state: "running",
        relation: { kind: "subagent", parentThreadId: "parent" },
      });
      expect(reads).toEqual(
        new Map([
          ["parent", 2],
          ["child", 2],
        ]),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a recovered user parent after its managed metadata is removed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.threadMeta.parent = {
        pinned: false,
        lastReadUpdatedAt: 0,
      };
      state.threadMeta.child = {
        pinned: false,
        lastReadUpdatedAt: 0,
        managedParent: { parentThreadId: "parent", taskId: "task" },
      };
    });
    const bridge = new FakeBridge();
    const parent = thread("parent", "/work", 7, { type: "notLoaded" });
    bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/list") {
        return { data: [], nextCursor: null, backwardsCursor: null };
      }
      if (method === "thread/loaded/list") return { data: [], nextCursor: null };
      if (method === "thread/read" && params.threadId === "parent") return { thread: parent };
      if (method === "model/list") return { data: [], nextCursor: null };
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );

    await projection.sync();

    expect(projection.summary("parent")).toMatchObject({
      id: "parent",
      updatedAt: 7_000,
      relation: { kind: "session", sessionId: "parent" },
    });

    await projection.sync();

    expect(projection.summary("parent")?.id).toBe("parent");
    expect(
      bridge.request.mock.calls.filter(
        ([method, params]) => method === "thread/read" && params.threadId === "parent",
      ),
    ).toHaveLength(2);

    await store.update((state) => {
      delete state.threadMeta.parent;
    });
    await projection.sync();

    expect(projection.summary("parent")?.id).toBe("parent");
    expect(
      bridge.request.mock.calls.filter(
        ([method, params]) => method === "thread/read" && params.threadId === "parent",
      ),
    ).toHaveLength(2);
  });

  it("backfills an unnamed subagent from its own first input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const parent = thread("parent", "/work", 2, { type: "notLoaded" });
    const child = {
      ...thread("child", "/work", 3, { type: "notLoaded" }),
      parentThreadId: "parent",
      preview: parent.preview,
      ephemeral: true,
      agentNickname: "reviewer",
      agentRole: "worker",
    };
    bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/list") {
        return {
          data: params.archived ? [] : [child, parent],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      if (method === "model/list") return { data: [], nextCursor: null };
      if (method === "thread/turns/list") {
        expect(params).toMatchObject({
          threadId: "child",
          limit: 20,
          sortDirection: "desc",
          itemsView: "full",
        });
        return {
          data: [
            {
              id: "child-turn",
              items: [
                {
                  type: "userMessage",
                  id: "child-input",
                  clientId: null,
                  content: [
                    {
                      type: "text",
                      text: "Проверить восстановление названий старых субагентов",
                      text_elements: [],
                    },
                  ],
                },
              ],
              itemsView: "full",
              status: "completed",
              error: null,
              startedAt: 1,
              completedAt: 2,
              durationMs: 1_000,
            },
            {
              id: "inherited-parent-turn",
              items: [
                {
                  type: "userMessage",
                  id: "parent-input",
                  clientId: null,
                  content: [
                    {
                      type: "text",
                      text: "Родительская задача, которую нельзя использовать",
                      text_elements: [],
                    },
                  ],
                },
              ],
              itemsView: "full",
              status: "completed",
              error: null,
              startedAt: 0,
              completedAt: 1,
              durationMs: 1_000,
            },
          ],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      if (method === "thread/name/set") return {};
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );

    await projection.sync();

    await vi.waitFor(() =>
      expect(projection.summary("child")?.title).toBe(
        "Проверить восстановление названий старых субагентов",
      ),
    );
    expect(bridge.request).toHaveBeenCalledWith("thread/name/set", {
      threadId: "child",
      name: "Проверить восстановление названий старых субагентов",
    });
  });

  it("returns only one coordinator input and the subagent's own history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method !== "thread/turns/list") throw new Error(`Unexpected ${method}`);
      expect(params).toMatchObject({
        threadId: "child",
        cursor: null,
        limit: 20,
        sortDirection: "desc",
        itemsView: "summary",
      });
      return {
        data: [
          {
            id: "child-followup",
            items: [
              {
                type: "userMessage",
                id: "child-steer",
                clientId: null,
                content: [{ type: "text", text: "Уточнение от координатора", text_elements: [] }],
              },
              {
                type: "agentMessage",
                id: "child-final",
                text: "Финальный результат субагента",
                phase: "final_answer",
                memoryCitation: null,
              },
            ],
            itemsView: "full",
            status: "completed",
            error: null,
            startedAt: 3,
            completedAt: 4,
            durationMs: 1_000,
          },
          {
            id: "child-task",
            items: [
              {
                type: "userMessage",
                id: "child-input",
                clientId: null,
                content: [
                  {
                    type: "text",
                    text: "Проверить мобильную вёрстку субагента",
                    text_elements: [],
                  },
                ],
              },
              {
                type: "agentMessage",
                id: "child-progress",
                text: "Проверяю мобильную вёрстку",
                phase: "commentary",
                memoryCitation: null,
              },
            ],
            itemsView: "full",
            status: "completed",
            error: null,
            startedAt: 2,
            completedAt: 3,
            durationMs: 1_000,
          },
          {
            id: "inherited-parent",
            items: [
              {
                type: "userMessage",
                id: "parent-input",
                clientId: null,
                content: [
                  { type: "text", text: "Вся история родительской сессии", text_elements: [] },
                ],
              },
              {
                type: "agentMessage",
                id: "parent-answer",
                text: "Старый ответ главного агента",
                phase: "final_answer",
                memoryCitation: null,
              },
            ],
            itemsView: "full",
            status: "completed",
            error: null,
            startedAt: 1,
            completedAt: 2,
            durationMs: 1_000,
          },
        ],
        nextCursor: "parent-history",
        backwardsCursor: null,
      };
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );
    projection.upsertThread({
      ...thread("child", "/work", 4, { type: "notLoaded" }),
      parentThreadId: "parent",
      ephemeral: true,
      name: "Проверить мобильную вёрстку субагента",
      agentNickname: "reviewer",
      agentRole: "worker",
    });

    const detail = await projection.readThread("child", "stale-parent-cursor");

    expect(detail.olderTurnsCursor).toBeNull();
    expect(detail.turns.map((turn) => turn.id)).toEqual(["child-task", "child-followup"]);
    expect(detail.turns.flatMap((turn) => turn.items.map((item) => item.id))).toEqual([
      "child-input",
      "child-progress",
      "child-final",
    ]);
    expect(
      detail.turns.flatMap((turn) => turn.items).filter((item) => item.type === "userMessage"),
    ).toHaveLength(1);

    projection.upsertThread({
      ...thread("child", "/work", 4, { type: "notLoaded" }),
      parentThreadId: "parent",
      ephemeral: true,
      name: "Несовпадающая задача",
      agentNickname: "reviewer",
      agentRole: "worker",
    });
    expect((await projection.readThread("child")).turns).toEqual([]);
  });

  it("filters managed root-child history and resets incremental reads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.threadMeta.parent = {
        pinned: false,
        lastReadUpdatedAt: 0,
      };
      state.threadMeta.child = {
        pinned: false,
        lastReadUpdatedAt: 0,
        managedParent: { parentThreadId: "parent", taskId: "task" },
      };
    });
    const bridge = new FakeBridge();
    bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method !== "thread/turns/list") throw new Error(`Unexpected ${method}`);
      expect(params).toMatchObject({
        threadId: "child",
        cursor: null,
        limit: 20,
        sortDirection: "desc",
        itemsView: "summary",
      });
      return {
        data: [
          {
            id: "child-task",
            items: [
              {
                type: "userMessage",
                id: "child-input-one",
                clientId: null,
                content: [
                  {
                    type: "text",
                    text: "Проверить managed transcript с длинным coordinator prompt",
                    text_elements: [],
                  },
                ],
              },
              {
                type: "userMessage",
                id: "child-input-two",
                clientId: null,
                content: [
                  {
                    type: "text",
                    text: "Проверить managed transcript с длинным coordinator prompt",
                    text_elements: [],
                  },
                ],
              },
              {
                type: "agentMessage",
                id: "child-final",
                text: "Managed transcript исправлен",
                phase: "final_answer",
                memoryCitation: null,
              },
            ],
            itemsView: "full",
            status: "completed",
            error: null,
            startedAt: 2,
            completedAt: 3,
            durationMs: 1_000,
          },
        ],
        nextCursor: "parent-history",
        backwardsCursor: "parent-sync",
      };
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );
    projection.upsertThread({
      ...thread("child", "/work", 4, { type: "notLoaded" }),
      parentThreadId: null,
      name: "Короткий заголовок",
    });

    const detail = await projection.readThread("child", "parent-cursor");

    expect(detail.turns.map((turn) => turn.id)).toEqual(["child-task"]);
    expect(detail.turns.flatMap((turn) => turn.items.map((item) => item.id))).toEqual([
      "child-input-one",
      "child-final",
    ]);
    expect(
      detail.turns.flatMap((turn) => turn.items).filter((item) => item.type === "userMessage"),
    ).toHaveLength(1);
    expect(detail.olderTurnsCursor).toBeNull();
    expect(detail).not.toHaveProperty("syncPoint");

    bridge.request.mockClear();
    const changes = await projection.readThreadChanges("child", {
      cursor: "parent-sync",
      anchorTurnId: "stale-parent-turn",
      anchorRevision: "parent-revision",
    });

    expect(changes.resetLatest).toBe(true);
    expect(changes.turns.flatMap((turn) => turn.items.map((item) => item.id))).toEqual([
      "child-input-one",
      "child-final",
    ]);
    expect(
      changes.turns.flatMap((turn) => turn.items).filter((item) => item.type === "userMessage"),
    ).toHaveLength(1);
    expect(changes.continuationCursor).toBeNull();
    expect(changes.olderTurnsCursor).toBeNull();
    expect(changes.syncPoint).toBeNull();
    expect(bridge.request).toHaveBeenCalledTimes(1);
  });

  it("sorts sessions only by most recent activity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );
    projection.upsertThread(thread("running", "/work", 10, { type: "active", activeFlags: [] }));
    projection.upsertThread({
      ...thread("blank", "/work", 20),
      preview: "",
      name: null,
    });

    expect(projection.snapshot().threads.map((item) => item.id)).toEqual(["blank", "running"]);
  });

  it("hides sessions from dismissed project paths and restores them when registered again", async () => {
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
    });
    const projection = new AppProjection(
      new FakeBridge() as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );
    projection.upsertThread(thread("root-thread", "/work/src", 3));
    projection.upsertThread(thread("nested-thread", "/work/nested", 2));
    projection.upsertThread(thread("unrelated", "/other", 1));

    await store.update((state) => {
      state.projects = [];
      state.dismissedProjectPaths = ["/work"];
    });
    projection.removeProject("root");
    expect(projection.snapshot().threads.map((item) => item.id)).toEqual(["unrelated"]);

    await store.update((state) => {
      state.projects.push({
        id: "nested",
        displayName: "Nested",
        path: "/work/nested",
        createdAt: "x",
        updatedAt: "x",
      });
    });
    projection.publishProject("nested");
    expect(projection.snapshot().threads.map((item) => item.id)).toEqual([
      "nested-thread",
      "unrelated",
    ]);

    await store.update((state) => {
      state.projects.push({
        id: "restored",
        displayName: "Root",
        path: "/work",
        createdAt: "y",
        updatedAt: "y",
      });
      delete state.dismissedProjectPaths;
    });
    projection.publishProject("restored");
    expect(projection.snapshot().threads.map((item) => item.id)).toEqual([
      "root-thread",
      "nested-thread",
      "unrelated",
    ]);
    expect(projection.snapshot().threads.find((item) => item.id === "root-thread")?.projectId).toBe(
      "restored",
    );

    await store.update((state) => {
      state.projects = state.projects.filter((project) => project.id !== "nested");
      state.dismissedProjectPaths = ["/work/nested"];
    });
    projection.removeProject("nested");
    expect(projection.snapshot().threads.map((item) => item.id)).toEqual([
      "root-thread",
      "unrelated",
    ]);
  });

  it("only clears a completed session through its observed update", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.threadMeta.one = {
        pinned: false,
        lastReadUpdatedAt: 0,
        lastOutcome: "completed",
        outcomeUpdatedAt: 10_000,
      };
    });
    const projection = new AppProjection(
      new FakeBridge() as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );
    projection.upsertThread(thread("one", "/work", 10));

    expect(projection.summary("one")).toMatchObject({
      state: "completed",
      unread: true,
      unseen: true,
    });

    await projection.markViewed("one", 5_000);
    expect(projection.summary("one")).toMatchObject({ unread: true, unseen: true });

    await projection.markRead("one", 5_000);
    expect(projection.summary("one")?.unread).toBe(true);

    await projection.markViewed("one", 10_000);
    expect(projection.summary("one")).toMatchObject({ unread: true, unseen: false });

    await projection.markRead("one", 10_000);
    expect(projection.summary("one")).toMatchObject({ unread: false, unseen: false });

    projection.upsertThread(thread("one", "/work", 11));
    expect(projection.summary("one")).toMatchObject({
      state: "completed",
      unread: true,
      unseen: true,
    });
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
    expect(
      bridge.request.mock.calls.find(([method]) => method === "thread/list")?.[1],
    ).toMatchObject({
      sourceKinds: ["cli", "vscode", "appServer", "subAgentThreadSpawn"],
    });
    expect(projection.summary("two")?.projectId).toBe("nested");
    expect(projection.summary("two")?.settings).toEqual({ collaborationMode: "default" });
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
    const goal = {
      threadId: "one",
      objective: "Довести задачу до конца",
      status: "active" as const,
      tokenBudget: null,
      tokensUsed: 42,
      timeUsedSeconds: 7,
      createdAt: 1,
      updatedAt: 2,
    };
    bridge.emit("notification", {
      method: "thread/goal/updated",
      params: { threadId: "one", turnId: null, goal },
    } satisfies ServerNotification);
    bridge.emit("notification", {
      method: "thread/goal/cleared",
      params: { threadId: "one" },
    } satisfies ServerNotification);
    expect(events.filter((event) => event.type === "goal.changed").slice(-2)).toEqual([
      { type: "goal.changed", threadId: "one", goal },
      { type: "goal.changed", threadId: "one", goal: null },
    ]);
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
    await projection.setCurrentTurn("one", "steered");
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

  it("keeps an active turn running across a transient idle status", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    projection.on("event", (_sequence, event) => events.push(event));
    projection.upsertThread(thread("one", "/work", 10));

    bridge.emit("notification", {
      method: "turn/started",
      params: { threadId: "one", turn: testTurn("first", "inProgress") },
    } satisfies ServerNotification);
    bridge.emit("notification", {
      method: "thread/status/changed",
      params: { threadId: "one", status: { type: "idle" } },
    } satisfies ServerNotification);
    bridge.emit("notification", {
      method: "item/agentMessage/delta",
      params: {
        threadId: "one",
        turnId: "first",
        itemId: "continuation",
        delta: "Продолжаю работу",
      },
    } satisfies ServerNotification);

    expect(projection.summary("one")).toMatchObject({
      state: "running",
      currentTurnId: "first",
      unread: false,
    });
    expect(events.filter((event) => event.type === "activity.upserted").at(-1)).toMatchObject({
      threadId: "one",
      turnId: "first",
      item: { type: "agentMessage", text: "Продолжаю работу" },
    });

    bridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "one", turn: testTurn("first", "completed") },
    } satisfies ServerNotification);
    await vi.waitFor(() =>
      expect(projection.summary("one")).toMatchObject({
        state: "completed",
        currentTurnId: null,
        unread: true,
      }),
    );
    await store.flushed();
  });

  it("restores a lost active turn from a user-input request and keeps it running after the answer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const attention = new AttentionManager();
    const projection = new AppProjection(
      new FakeBridge() as unknown as CodexBridge,
      store,
      attention,
      false,
    );
    projection.upsertThread(thread("one", "/work", 10, { type: "active", activeFlags: [] }, []));

    const request = attention.receive(
      {
        method: "item/tool/requestUserInput",
        id: 7,
        params: {
          threadId: "one",
          turnId: "question-turn",
          itemId: "question",
          autoResolutionMs: null,
          questions: [],
        },
      } as ServerRequest,
      {
        respond: vi.fn(),
        respondError: vi.fn(),
      } as unknown as JsonlTransport,
    );
    expect(projection.summary("one")).toMatchObject({
      state: "needsAttention",
      currentTurnId: "question-turn",
      unread: false,
    });

    attention.resolve(request.id, { kind: "userInput", answers: {} });
    expect(projection.summary("one")).toMatchObject({
      state: "running",
      currentTurnId: "question-turn",
      unread: false,
    });
  });

  it("keeps an active goal running between turns and releases terminal state when stopped", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );
    projection.upsertThread(thread("one", "/work", 10));

    bridge.emit("notification", goalNotification("active"));
    bridge.emit("notification", {
      method: "turn/started",
      params: { threadId: "one", turn: testTurn("first", "inProgress") },
    } satisfies ServerNotification);
    bridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "one", turn: testTurn("first", "completed") },
    } satisfies ServerNotification);

    await vi.waitFor(() =>
      expect(projection.summary("one")).toMatchObject({
        state: "running",
        currentTurnId: null,
        unread: false,
      }),
    );

    bridge.emit("notification", goalNotification("paused", 3));
    expect(projection.summary("one")).toMatchObject({ state: "completed", unread: true });

    bridge.emit("notification", goalNotification("active", 4));
    expect(projection.summary("one")).toMatchObject({ state: "running", unread: false });

    bridge.emit("notification", {
      method: "thread/goal/cleared",
      params: { threadId: "one" },
    } satisfies ServerNotification);
    expect(projection.summary("one")).toMatchObject({ state: "completed", unread: true });
    await store.flushed();
  });

  it("publishes completion only after both the final turn and goal complete", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );
    projection.upsertThread(thread("one", "/work", 10));

    bridge.emit("notification", goalNotification("active"));
    bridge.emit("notification", {
      method: "turn/started",
      params: { threadId: "one", turn: testTurn("goal-first", "inProgress") },
    } satisfies ServerNotification);
    bridge.emit("notification", goalNotification("complete", 3));
    expect(projection.summary("one")?.state).toBe("running");

    bridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "one", turn: testTurn("goal-first", "completed") },
    } satisfies ServerNotification);
    await vi.waitFor(() => expect(projection.summary("one")?.state).toBe("completed"));

    bridge.emit("notification", goalNotification("active", 4));
    bridge.emit("notification", {
      method: "turn/started",
      params: { threadId: "one", turn: testTurn("turn-first", "inProgress") },
    } satisfies ServerNotification);
    bridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "one", turn: testTurn("turn-first", "completed") },
    } satisfies ServerNotification);
    await vi.waitFor(() => expect(projection.summary("one")?.state).toBe("running"));

    bridge.emit("notification", goalNotification("complete", 5));
    expect(projection.summary("one")).toMatchObject({ state: "completed", unread: true });
    await store.flushed();
  });

  it("fails immediately when an active thread reports a system error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );
    projection.upsertThread(thread("one", "/work", 10));
    bridge.emit("notification", goalNotification("active"));
    bridge.emit("notification", {
      method: "turn/started",
      params: { threadId: "one", turn: testTurn("first", "inProgress") },
    } satisfies ServerNotification);

    bridge.emit("notification", {
      method: "thread/status/changed",
      params: { threadId: "one", status: { type: "systemError" } },
    } satisfies ServerNotification);

    expect(projection.summary("one")).toMatchObject({
      state: "failed",
      currentTurnId: null,
    });
  });

  it("persists chronological plan checklists and marks a finished plan for attention", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const statePath = join(directory, "state.json");
    const store = new StateStore(statePath);
    await store.load();
    const bridge = new FakeBridge();
    const historicalTurn = {
      id: "plan-turn",
      items: [
        {
          type: "userMessage" as const,
          id: "question-tool",
          clientId: null,
          content: [{ type: "text" as const, text: "Вопрос", text_elements: [] }],
        },
        {
          type: "agentMessage" as const,
          id: "progress-message",
          text: "Перехожу к следующему шагу",
          phase: "commentary" as const,
          memoryCitation: null,
        },
        { type: "plan" as const, id: "final-plan", text: "Готовый план" },
      ],
      itemsView: "full" as const,
      status: "completed" as const,
      error: null,
      startedAt: 10,
      completedAt: 20,
      durationMs: 10_000,
    };
    bridge.request.mockImplementation(async (method: string) => {
      if (method === "thread/turns/list") {
        return { data: [historicalTurn], nextCursor: null, backwardsCursor: null };
      }
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );
    projection.upsertThread(thread("one", "/work", 10));
    await projection.setSettings("one", { collaborationMode: "plan" });

    bridge.emit("notification", {
      method: "turn/started",
      params: {
        threadId: "one",
        turn: { ...historicalTurn, items: [], status: "inProgress", completedAt: null },
      },
    } satisfies ServerNotification);
    bridge.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "one",
        turnId: "plan-turn",
        item: historicalTurn.items[0],
        completedAtMs: 10_100,
      },
    } as ServerNotification);
    bridge.emit("notification", {
      method: "turn/plan/updated",
      params: {
        threadId: "one",
        turnId: "plan-turn",
        explanation: "Проверяю решение",
        plan: [
          { step: "Исследовать", status: "inProgress" },
          { step: "Составить план", status: "pending" },
        ],
      },
    } satisfies ServerNotification);
    await vi.waitFor(() =>
      expect(store.snapshot().threadMeta.one?.timelineArtifacts?.["plan-turn"]).toHaveLength(1),
    );
    bridge.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "one",
        turnId: "plan-turn",
        item: historicalTurn.items[1],
        completedAtMs: 10_150,
      },
    } as ServerNotification);
    bridge.emit("notification", {
      method: "turn/plan/updated",
      params: {
        threadId: "one",
        turnId: "plan-turn",
        explanation: "Составляю итоговый план",
        plan: [
          { step: "Исследовать", status: "completed" },
          { step: "Составить план", status: "inProgress" },
        ],
      },
    } satisfies ServerNotification);
    await vi.waitFor(() =>
      expect(store.snapshot().threadMeta.one?.timelineArtifacts?.["plan-turn"]).toHaveLength(2),
    );

    await projection.recordAttentionResponse(
      {
        id: "attention-1",
        kind: "userInput",
        threadId: "one",
        turnId: "plan-turn",
        itemId: "question-tool",
        createdAt: 10_200,
        autoResolutionMs: null,
        questions: [
          {
            id: "token",
            header: "Токен",
            question: "Какое значение?",
            isOther: true,
            isSecret: true,
            options: null,
          },
        ],
      },
      { kind: "userInput", answers: { token: ["secret-value"] } },
    );
    bridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "one", turn: historicalTurn },
    } satisfies ServerNotification);

    await vi.waitFor(() => expect(projection.summary("one")?.state).toBe("needsAttention"));
    const artifacts = store.snapshot().threadMeta.one?.timelineArtifacts?.["plan-turn"] ?? [];
    expect(artifacts).toMatchObject([
      {
        type: "planChecklist",
        status: "completed",
        afterItemId: "question-tool",
        steps: [
          { step: "Исследовать", status: "inProgress" },
          { step: "Составить план", status: "pending" },
        ],
      },
      {
        type: "planChecklist",
        status: "completed",
        afterItemId: "progress-message",
        steps: [
          { step: "Исследовать", status: "completed" },
          { step: "Составить план", status: "inProgress" },
        ],
      },
      {
        type: "userInputResponse",
        entries: [{ question: "Какое значение?", answers: ["secret-value"] }],
      },
    ]);
    const checklistIds = artifacts
      .filter((item) => item.type === "planChecklist")
      .map((item) => item.id);
    expect(new Set(checklistIds).size).toBe(2);

    const detail = await projection.readThread("one");
    expect(detail.turns[0]?.items.map((item) => item.id)).toEqual([
      "question-tool",
      checklistIds[0],
      "question-tool-response",
      "progress-message",
      checklistIds[1],
      "final-plan",
    ]);
    const reloadedStore = new StateStore(statePath);
    await reloadedStore.load();
    expect(reloadedStore.snapshot().threadMeta.one?.timelineArtifacts?.["plan-turn"]).toMatchObject(
      [
        { type: "planChecklist", id: checklistIds[0] },
        { type: "planChecklist", id: checklistIds[1] },
        { entries: [{ answers: ["secret-value"] }] },
      ],
    );

    await projection.setCurrentTurn("one", "implementation-turn");
    expect(projection.summary("one")?.state).toBe("running");
    expect(store.snapshot().threadMeta.one?.awaitingPlanResponse).toBe(false);
  });

  it("uses only the latest checklist to detect an incomplete successful turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );
    projection.upsertThread(thread("one", "/work", 10));

    bridge.emit("notification", {
      method: "turn/started",
      params: { threadId: "one", turn: testTurn("finished-plan", "inProgress") },
    } satisfies ServerNotification);
    bridge.emit("notification", {
      method: "turn/plan/updated",
      params: {
        threadId: "one",
        turnId: "finished-plan",
        explanation: "Начинаю",
        plan: [
          { step: "Первый", status: "inProgress" },
          { step: "Второй", status: "pending" },
        ],
      },
    } satisfies ServerNotification);
    bridge.emit("notification", {
      method: "turn/plan/updated",
      params: {
        threadId: "one",
        turnId: "finished-plan",
        explanation: "Готово",
        plan: [
          { step: "Первый", status: "completed" },
          { step: "Второй", status: "completed" },
        ],
      },
    } satisfies ServerNotification);
    await vi.waitFor(() =>
      expect(store.snapshot().threadMeta.one?.timelineArtifacts?.["finished-plan"]).toHaveLength(2),
    );
    bridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "one", turn: testTurn("finished-plan", "completed") },
    } satisfies ServerNotification);

    await vi.waitFor(() => {
      expect(projection.summary("one")?.state).toBe("completed");
      expect(store.snapshot().threadMeta.one?.awaitingPlanResponse).toBe(false);
    });

    await projection.setCurrentTurn("one", "unfinished-plan");
    bridge.emit("notification", {
      method: "turn/plan/updated",
      params: {
        threadId: "one",
        turnId: "unfinished-plan",
        explanation: "Нужно решение",
        plan: [
          { step: "Первый", status: "completed" },
          { step: "Второй", status: "inProgress" },
          { step: "Третий", status: "pending" },
        ],
      },
    } satisfies ServerNotification);
    await vi.waitFor(() =>
      expect(store.snapshot().threadMeta.one?.timelineArtifacts?.["unfinished-plan"]).toHaveLength(
        1,
      ),
    );
    bridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "one", turn: testTurn("unfinished-plan", "completed") },
    } satisfies ServerNotification);

    await vi.waitFor(() => expect(projection.summary("one")?.state).toBe("needsAttention"));
    expect(projection.summary("one")?.currentTurnId).toBeNull();
    expect(store.snapshot().threadMeta.one?.awaitingPlanResponse).toBe(true);
  });

  it.each(["failed", "interrupted"] as const)(
    "keeps the %s outcome when its latest checklist is incomplete",
    async (outcome) => {
      const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
      directories.push(directory);
      const store = new StateStore(join(directory, "state.json"));
      await store.load();
      const bridge = new FakeBridge();
      const projection = new AppProjection(
        bridge as unknown as CodexBridge,
        store,
        new AttentionManager(),
        false,
      );
      projection.upsertThread(thread("one", "/work", 10));
      await projection.setCurrentTurn("one", `${outcome}-plan`);
      bridge.emit("notification", {
        method: "turn/plan/updated",
        params: {
          threadId: "one",
          turnId: `${outcome}-plan`,
          explanation: "Не закончено",
          plan: [{ step: "Проверить", status: "inProgress" }],
        },
      } satisfies ServerNotification);
      await vi.waitFor(() =>
        expect(
          store.snapshot().threadMeta.one?.timelineArtifacts?.[`${outcome}-plan`],
        ).toHaveLength(1),
      );
      bridge.emit("notification", {
        method: "turn/completed",
        params: {
          threadId: "one",
          turn: { ...testTurn(`${outcome}-plan`, "completed"), status: outcome },
        },
      } satisfies ServerNotification);

      await vi.waitFor(() => {
        expect(projection.summary("one")?.state).toBe(outcome);
        expect(store.snapshot().threadMeta.one?.awaitingPlanResponse).toBe(false);
      });
    },
  );

  it("does not report a phantom active thread without an in-progress turn as running", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const projection = new AppProjection(
      new FakeBridge() as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );

    const value = projection.upsertThread(
      thread("phantom", "/work", 10, { type: "active", activeFlags: [] }, []),
    );
    expect(value.currentTurnId).toBeNull();
    expect(value.state).not.toBe("running");
  });

  it("restores a newer active turn from an authoritative history page", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.threadMeta.one = {
        pinned: false,
        lastReadUpdatedAt: 0,
        lastOutcome: "completed",
        outcomeUpdatedAt: 3_000,
      };
    });
    const bridge = new FakeBridge();
    bridge.request.mockImplementation(async (method: string) => {
      if (method === "thread/turns/list") {
        return {
          data: [{ ...testTurn("live", "inProgress"), startedAt: 3 }],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );
    projection.upsertThread(thread("one", "/work", 3));

    const detail = await projection.readThread("one");

    expect(detail.summary).toMatchObject({
      state: "running",
      currentTurnId: "live",
      unread: false,
    });
    expect(projection.summary("one")).toMatchObject({
      state: "running",
      currentTurnId: "live",
    });
  });

  it("does not restore an active history turn older than the terminal outcome", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.threadMeta.one = {
        pinned: false,
        lastReadUpdatedAt: 0,
        lastOutcome: "completed",
        outcomeUpdatedAt: 4_000,
      };
    });
    const bridge = new FakeBridge();
    bridge.request.mockImplementation(async (method: string) => {
      if (method === "thread/turns/list") {
        return {
          data: [{ ...testTurn("stale", "inProgress"), startedAt: 3 }],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );
    projection.upsertThread(thread("one", "/work", 4));

    const detail = await projection.readThread("one");

    expect(detail.summary).toMatchObject({
      state: "completed",
      currentTurnId: null,
    });
  });

  it("reads only turns after the cached history anchor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const first = testTurn("first", "completed");
    const second = testTurn("second", "completed");
    bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method !== "thread/turns/list") throw new Error(`Unexpected ${method}`);
      if (params.sortDirection === "asc") {
        return {
          data: [first, second],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      return {
        data: params.limit === 1 ? [second] : [first],
        nextCursor: null,
        backwardsCursor: params.limit === 1 ? "next-delta" : "delta-cursor",
      };
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );
    projection.upsertThread(thread("one", "/work", 10));

    const initial = await projection.readThread("one");
    expect(initial.turns.map((turn) => turn.id)).toEqual(["first"]);
    expect(initial.syncPoint).toMatchObject({
      cursor: "delta-cursor",
      anchorTurnId: "first",
    });
    bridge.request.mockClear();

    const changes = await projection.readThreadChanges("one", initial.syncPoint!);

    expect(changes.resetLatest).toBe(false);
    expect(changes.turns.map((turn) => turn.id)).toEqual(["second"]);
    expect(changes.syncPoint).toMatchObject({
      cursor: "next-delta",
      anchorTurnId: "second",
    });
    expect(bridge.request).toHaveBeenNthCalledWith(
      1,
      "thread/turns/list",
      expect.objectContaining({
        threadId: "one",
        cursor: "delta-cursor",
        sortDirection: "asc",
      }),
      30_000,
    );
    expect(bridge.request).toHaveBeenNthCalledWith(
      2,
      "thread/turns/list",
      expect.objectContaining({ threadId: "one", limit: 1, sortDirection: "desc" }),
      30_000,
    );
  });

  it("falls back to a full page when the incremental turn read returns an RPC error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const first = testTurn("first", "completed");
    const second = testTurn("second", "completed");
    let incremental = false;
    bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method !== "thread/turns/list") throw new Error(`Unexpected ${method}`);
      if (params.sortDirection === "asc") {
        incremental = true;
        throw new RpcError(-32_000, "Rollout changed while reading turns");
      }
      return {
        data: incremental ? [second, first] : [first],
        nextCursor: null,
        backwardsCursor: incremental ? "fresh-cursor" : "stale-cursor",
      };
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );
    projection.upsertThread(thread("one", "/work", 10));
    const initial = await projection.readThread("one");
    bridge.request.mockClear();

    const changes = await projection.readThreadChanges("one", initial.syncPoint!);

    expect(changes.resetLatest).toBe(true);
    expect(changes.turns.map((turn) => turn.id)).toEqual(["first", "second"]);
    expect(bridge.request).toHaveBeenNthCalledWith(
      1,
      "thread/turns/list",
      expect.objectContaining({ cursor: "stale-cursor", sortDirection: "asc" }),
      30_000,
    );
    expect(bridge.request).toHaveBeenNthCalledWith(
      2,
      "thread/turns/list",
      expect.objectContaining({ cursor: null, sortDirection: "desc" }),
      30_000,
    );
  });

  it("overlays accepted user messages onto a lagging turn read", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const laggingTurn = {
      ...testTurn("live", "inProgress"),
      itemsView: "full" as const,
      items: [
        {
          type: "agentMessage" as const,
          id: "agent",
          text: "Уже отвечаю",
          phase: "commentary" as const,
          memoryCitation: null,
        },
      ],
    };
    bridge.request.mockImplementation(async (method: string) => {
      if (method === "thread/turns/list") {
        return { data: [laggingTurn], nextCursor: null, backwardsCursor: null };
      }
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );
    projection.upsertThread(thread("one", "/work", 10));

    projection.recordUserMessage("one", "live", "client-user", "Мой запрос", ["image"]);

    expect((await projection.readThread("one")).turns[0]?.items).toMatchObject([
      { type: "userMessage", id: "client-user", text: "Мой запрос", images: ["image"] },
      { type: "agentMessage", id: "agent", text: "Уже отвечаю" },
    ]);

    bridge.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "one",
        turnId: "live",
        item: {
          type: "userMessage",
          id: "server-user",
          clientId: "client-user",
          content: [{ type: "text", text: "Канонический запрос", text_elements: [] }],
        },
        completedAtMs: 11_000,
      },
    } as ServerNotification);
    expect((await projection.readThread("one")).turns[0]?.items[0]).toMatchObject({
      id: "client-user",
      text: "Канонический запрос",
    });

    projection.recordUserMessage("one", "live", "client-steer", "Уточнение", []);
    laggingTurn.items = [
      {
        type: "userMessage",
        id: "server-user",
        clientId: "client-user",
        content: [{ type: "text", text: "Канонический запрос", text_elements: [] }],
      },
      laggingTurn.items[0]!,
      {
        type: "agentMessage",
        id: "after-steer",
        text: "Продолжаю после уточнения",
        phase: "commentary",
        memoryCitation: null,
      },
    ];
    bridge.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "one",
        turnId: "live",
        item: laggingTurn.items[2],
        completedAtMs: 12_000,
      },
    } as ServerNotification);
    expect((await projection.readThread("one")).turns[0]?.items.map((item) => item.id)).toEqual([
      "client-user",
      "agent",
      "client-steer",
      "after-steer",
    ]);
  });

  it("loads one turn's canonical items through bounded full-turn pages", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method !== "thread/turns/list") throw new Error(`Unexpected ${method}`);
      if (!params.cursor) {
        return {
          data: [{ ...testTurn("newer", "completed"), itemsView: "full" }],
          nextCursor: "next",
          backwardsCursor: null,
        };
      }
      return {
        data: [
          {
            ...testTurn("turn", "completed"),
            startedAt: 10,
            completedAt: 12,
            itemsView: "full",
            items: [
              {
                type: "userMessage",
                id: "user",
                clientId: null,
                content: [{ type: "text", text: "Запрос", text_elements: [] }],
              },
              {
                type: "userMessage",
                id: "internal",
                clientId: "codexnest-team-claim:task",
                content: [{ type: "text", text: "Продолжить задачу", text_elements: [] }],
              },
              {
                type: "userMessage",
                id: "internal-v2",
                clientId: "codexnest-team-continuation:task-v2",
                content: [{ type: "text", text: "Continue Team", text_elements: [] }],
              },
              { type: "plan", id: "plan", text: "План" },
            ],
          },
        ],
        nextCursor: "unused",
        backwardsCursor: null,
      };
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );

    const response = await projection.readTurnItems("one", "turn");

    expect(response).toEqual({
      threadId: "one",
      turnId: "turn",
      items: [
        {
          type: "userMessage",
          id: "user",
          status: "completed",
          text: "Запрос",
          images: [],
          timestamp: 10_000,
          phase: null,
        },
        {
          type: "plan",
          id: "plan",
          status: "completed",
          text: "План",
          images: [],
          timestamp: 12_000,
          phase: null,
        },
      ],
    });
    expect(bridge.request).toHaveBeenNthCalledWith(
      1,
      "thread/turns/list",
      {
        threadId: "one",
        cursor: null,
        limit: 100,
        sortDirection: "desc",
        itemsView: "full",
      },
      30_000,
    );
    expect(bridge.request).toHaveBeenNthCalledWith(
      2,
      "thread/turns/list",
      {
        threadId: "one",
        cursor: "next",
        limit: 100,
        sortDirection: "desc",
        itemsView: "full",
      },
      30_000,
    );
    expect(bridge.request).toHaveBeenCalledTimes(2);
    expect(bridge.request.mock.calls.some(([method]) => method === "thread/items/list")).toBe(
      false,
    );
  });

  it("returns an empty item list when the requested turn is absent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    bridge.request.mockResolvedValue({
      data: [{ ...testTurn("other", "completed"), itemsView: "full" }],
      nextCursor: null,
      backwardsCursor: null,
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );

    await expect(projection.readTurnItems("one", "missing")).resolves.toEqual({
      threadId: "one",
      turnId: "missing",
      items: [],
    });
    expect(bridge.request).toHaveBeenCalledWith(
      "thread/turns/list",
      {
        threadId: "one",
        cursor: null,
        limit: 100,
        sortDirection: "desc",
        itemsView: "full",
      },
      30_000,
    );
  });

  it("reconciles a streamed agent message when the canonical item id changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const canonicalTurn = {
      ...testTurn("live", "completed"),
      itemsView: "full" as const,
      items: [
        {
          type: "agentMessage" as const,
          id: "canonical-agent",
          text: "Готово",
          phase: "final_answer" as const,
          memoryCitation: null,
        },
      ],
    };
    bridge.request.mockImplementation(async (method: string) => {
      if (method === "thread/turns/list") {
        return { data: [canonicalTurn], nextCursor: null, backwardsCursor: null };
      }
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );
    const activities: ActivityItem[] = [];
    projection.on("event", (_sequence, event) => {
      if (event.type === "activity.upserted") activities.push(event.item);
    });
    projection.upsertThread(thread("one", "/work", 10));

    bridge.emit("notification", {
      method: "item/agentMessage/delta",
      params: {
        threadId: "one",
        turnId: "live",
        itemId: "stream-agent",
        delta: "Готово",
      },
    } satisfies ServerNotification);
    bridge.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "one",
        turnId: "live",
        item: canonicalTurn.items[0],
        completedAtMs: 12_000,
      },
    } as ServerNotification);
    bridge.emit("notification", {
      method: "turn/plan/updated",
      params: {
        threadId: "one",
        turnId: "live",
        explanation: "Готово",
        plan: [{ step: "Ответить", status: "completed" }],
      },
    } satisfies ServerNotification);
    await vi.waitFor(() =>
      expect(store.snapshot().threadMeta.one?.timelineArtifacts?.live).toHaveLength(1),
    );

    expect(activities.slice(0, 2).map((item) => item.id)).toEqual(["stream-agent", "stream-agent"]);
    const items = (await projection.readThread("one")).turns[0]?.items ?? [];
    expect(items.map((item) => item.id)).toEqual([
      "canonical-agent",
      expect.stringContaining("live-plan-checklist-"),
    ]);
    expect(items[1]).toMatchObject({
      type: "planChecklist",
      afterItemId: "canonical-agent",
    });
  });

  it("keeps live activities chronological when a later canonical message has a different id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const canonicalTurn = {
      ...testTurn("live", "completed"),
      itemsView: "full" as const,
      items: [
        {
          type: "agentMessage" as const,
          id: "canonical-final",
          text: "Работа завершена",
          phase: "final_answer" as const,
          memoryCitation: null,
        },
      ],
    };
    bridge.request.mockImplementation(async (method: string) => {
      if (method === "thread/turns/list") {
        return { data: [canonicalTurn], nextCursor: null, backwardsCursor: null };
      }
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
      false,
    );
    projection.upsertThread(thread("one", "/work", 10));

    bridge.emit("notification", {
      method: "item/agentMessage/delta",
      params: {
        threadId: "one",
        turnId: "live",
        itemId: "stream-commentary",
        delta: "Сейчас дополнительно проверяю",
      },
    } satisfies ServerNotification);
    bridge.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "one",
        turnId: "live",
        item: {
          type: "commandExecution",
          id: "command",
          command: "npm test",
          cwd: "/work",
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: "passed",
          exitCode: 0,
          durationMs: 1,
        },
        completedAtMs: 11_000,
      },
    } as ServerNotification);
    bridge.emit("notification", {
      method: "item/agentMessage/delta",
      params: {
        threadId: "one",
        turnId: "live",
        itemId: "stream-final",
        delta: "Работа завершена",
      },
    } satisfies ServerNotification);
    bridge.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "one",
        turnId: "live",
        item: canonicalTurn.items[0],
        completedAtMs: 12_000,
      },
    } as ServerNotification);

    expect((await projection.readThread("one")).turns[0]?.items.map((item) => item.id)).toEqual([
      "stream-commentary",
      "command",
      "canonical-final",
    ]);
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
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/goal/get"),
    ).toHaveLength(1);
    expect((await projection.readThread("one")).turns[0]).toMatchObject({
      id: "live",
      status: "inProgress",
      startedAt: 3_000,
      completedAt: null,
      durationMs: null,
      progress: { startedAt: 3_000 },
      items: [
        {
          id: "client-user",
          type: "userMessage",
          text: "Запрос",
          images: ["data:image/png;base64,aW1hZ2U="],
          timestamp: 3_000,
          phase: null,
        },
        {
          id: "answer",
          type: "agentMessage",
          text: "В процессе",
          timestamp: 3_000,
          phase: null,
          images: [],
        },
      ],
    });
    expect(bridge.request).toHaveBeenCalledWith(
      "thread/turns/list",
      {
        threadId: "one",
        cursor: null,
        limit: 20,
        sortDirection: "desc",
        itemsView: "summary",
      },
      30_000,
    );

    await projection.sync();
    expect(bridge.request.mock.calls.filter(([method]) => method === "thread/resume")).toHaveLength(
      1,
    );
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/goal/get"),
    ).toHaveLength(1);
    expect(projection.summary("one")).toMatchObject({
      state: "running",
      currentTurnId: "live",
      unread: false,
    });

    bridge.emit("state", "unavailable");
    bridge.emit("state", "ready");
    await projection.sync();
    expect(bridge.request.mock.calls.filter(([method]) => method === "thread/resume")).toHaveLength(
      2,
    );
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/goal/get"),
    ).toHaveLength(2);
  });

  it("does not replace fresh list timestamps with stale resume metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge(true, false, 1);
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
      updatedAt: 5_000,
    });
  });

  it("restores an active goal after restart before the resumed turn completes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge(true, true);
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
      unread: false,
    });
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/goal/get"),
    ).toHaveLength(1);

    bridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "one", turn: testTurn("live", "completed") },
    } satisfies ServerNotification);
    await vi.waitFor(() =>
      expect(projection.summary("one")).toMatchObject({
        state: "running",
        currentTurnId: null,
        unread: false,
      }),
    );

    bridge.emit("notification", goalNotification("complete", 3));
    expect(projection.summary("one")).toMatchObject({ state: "completed", unread: true });
    await store.flushed();
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

function liveThread(updatedAt = 5): Thread {
  return thread("one", "/work", updatedAt, { type: "active", activeFlags: [] }, [
    {
      id: "live",
      items: [
        {
          type: "userMessage",
          id: "user",
          clientId: "client-user",
          content: [
            { type: "text", text: "Запрос", text_elements: [] },
            { type: "image", url: "data:image/png;base64,aW1hZ2U=" },
          ],
        },
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

function testTurn(id: string, status: "inProgress" | "completed"): Thread["turns"][number] {
  return {
    id,
    items: [],
    itemsView: "summary",
    status,
    error: null,
    startedAt: 1,
    completedAt: status === "completed" ? 2 : null,
    durationMs: status === "completed" ? 1_000 : null,
  };
}

type CollabToolCall = Extract<
  Thread["turns"][number]["items"][number],
  { type: "collabAgentToolCall" }
>;

function collabWaitNotification(
  id: string,
  status: CollabToolCall["status"],
  receiverThreadIds: string[],
  agentsStates: CollabToolCall["agentsStates"],
  completedAtMs = 10_500,
): ServerNotification {
  return {
    method: "item/completed",
    params: {
      threadId: "one",
      turnId: "parent-turn",
      item: {
        type: "collabAgentToolCall",
        id,
        tool: "wait",
        status,
        senderThreadId: "one",
        receiverThreadIds,
        prompt: null,
        model: null,
        reasoningEffort: null,
        agentsStates,
      },
      completedAtMs,
    },
  } satisfies ServerNotification;
}

function nextImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function goalNotification(
  status: ThreadGoal["status"],
  updatedAt = 2,
): Extract<ServerNotification, { method: "thread/goal/updated" }> {
  return {
    method: "thread/goal/updated",
    params: {
      threadId: "one",
      turnId: null,
      goal: {
        threadId: "one",
        objective: "Довести задачу до конца",
        status,
        tokenBudget: null,
        tokensUsed: 42,
        timeUsedSeconds: 7,
        createdAt: 1,
        updatedAt,
      },
    },
  };
}
