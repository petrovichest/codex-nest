import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ThreadGoal } from "@codexnest/protocol";

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
    if (method === "thread/turns/list" && this.active && params.itemsView === "full") {
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
  it("counts files and changed lines in an aggregated turn diff", () => {
    expect(
      diffStats(
        "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n-old\n+new\ndiff --git a/b.ts b/b.ts\n+++ b/b.ts\n+added",
      ),
    ).toEqual({ filesChanged: 2, additions: 2, deletions: 1 });
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

    expect(projection.summary("one")).toMatchObject({ state: "completed", unread: true });

    await projection.markRead("one", 5_000);
    expect(projection.summary("one")?.unread).toBe(true);

    await projection.markRead("one", 10_000);
    expect(projection.summary("one")?.unread).toBe(false);

    projection.upsertThread(thread("one", "/work", 11));
    expect(projection.summary("one")).toMatchObject({ state: "completed", unread: true });
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

  it("persists question responses and live plan checklists and marks a finished plan for attention", async () => {
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
          { step: "Исследовать", status: "completed" },
          { step: "Составить план", status: "inProgress" },
        ],
      },
    } satisfies ServerNotification);
    await vi.waitFor(() =>
      expect(store.snapshot().threadMeta.one?.timelineArtifacts?.["plan-turn"]).toHaveLength(1),
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
      { type: "planChecklist", status: "completed" },
      {
        type: "userInputResponse",
        entries: [{ question: "Какое значение?", answers: ["secret-value"] }],
      },
    ]);

    const detail = await projection.readThread("one");
    expect(detail.turns[0]?.items.map((item) => item.id)).toEqual([
      "question-tool",
      "plan-turn-plan-checklist",
      "question-tool-response",
      "final-plan",
    ]);
    const reloadedStore = new StateStore(statePath);
    await reloadedStore.load();
    expect(
      reloadedStore.snapshot().threadMeta.one?.timelineArtifacts?.["plan-turn"]?.[1],
    ).toMatchObject({ entries: [{ answers: ["secret-value"] }] });

    await projection.setCurrentTurn("one", "implementation-turn");
    expect(projection.summary("one")?.state).toBe("running");
    expect(store.snapshot().threadMeta.one?.awaitingPlanResponse).toBe(false);
  });

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
        itemsView: "full",
      },
      30_000,
    );

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
