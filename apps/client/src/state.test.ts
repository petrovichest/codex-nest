import { describe, expect, it } from "vitest";

import type { AppSnapshot, ThreadSummary } from "@codexnest/protocol";

import { clientReducer, initialState, sortThreads } from "./state";

const baseThread: ThreadSummary = {
  id: "one",
  projectId: null,
  title: "One",
  preview: "",
  cwd: "/work",
  state: "running",
  unread: false,
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  currentTurnId: "turn",
  queuedMessageCount: 0,
  settings: { collaborationMode: "default" },
};

const snapshot: AppSnapshot = {
  sequence: 4,
  connection: { state: "ready", message: null, syncedAt: null },
  projects: [],
  threads: [baseThread],
  attention: [],
  models: [],
  pushConfigured: false,
};

describe("clientReducer", () => {
  it("resets all projection data on a reconnect snapshot", () => {
    const dirty = {
      ...initialState,
      details: { old: { summary: baseThread, turns: [], queuedMessages: [] } },
    };
    const next = clientReducer(dirty, { type: "snapshot", snapshot });
    expect(next.snapshot).toBe(snapshot);
    expect(next.network).toBe("connected");
    expect(next.details.old).toBeDefined();
  });

  it("replaces an item completion after ordered streaming deltas", () => {
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "detail",
      detail: {
        summary: baseThread,
        turns: [
          {
            id: "turn",
            status: "inProgress",
            progress: {
              startedAt: null,
              explanation: null,
              steps: [],
              filesChanged: 0,
              additions: 0,
              deletions: 0,
            },
            items: [],
          },
        ],
        queuedMessages: [],
      },
    });
    state = clientReducer(state, {
      type: "event",
      sequence: 5,
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "turn",
        item: { type: "agentMessage", id: "item", status: "inProgress", text: "Прив" },
      },
    });
    state = clientReducer(state, {
      type: "event",
      sequence: 6,
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "turn",
        item: { type: "agentMessage", id: "item", status: "completed", text: "Привет" },
      },
    });
    expect(state.details.one?.turns[0]?.items).toEqual([
      { type: "agentMessage", id: "item", status: "completed", text: "Привет" },
    ]);
  });

  it("applies server-owned settings to the list and loaded detail", () => {
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "detail",
      detail: { summary: baseThread, turns: [], queuedMessages: [] },
    });
    const updated = {
      ...baseThread,
      settings: { collaborationMode: "plan" as const, model: "gpt" },
    };
    state = clientReducer(state, {
      type: "event",
      sequence: 5,
      event: { type: "thread.upserted", thread: updated },
    });
    expect(state.snapshot?.threads[0]?.settings).toEqual(updated.settings);
    expect(state.details.one?.summary.settings).toEqual(updated.settings);
  });

  it("applies live progress and the server-owned message queue", () => {
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "detail",
      detail: { summary: baseThread, turns: [], queuedMessages: [] },
    });
    state = clientReducer(state, {
      type: "event",
      sequence: 5,
      event: {
        type: "turn.progressed",
        threadId: "one",
        turnId: "turn",
        progress: {
          startedAt: 1,
          explanation: "Выполняю",
          steps: [{ step: "Проверка", status: "inProgress" }],
          filesChanged: 2,
          additions: 3,
          deletions: 1,
        },
      },
    });
    state = clientReducer(state, {
      type: "event",
      sequence: 6,
      event: {
        type: "queue.changed",
        threadId: "one",
        messages: [
          {
            id: "queued",
            threadId: "one",
            text: "Следом",
            createdAt: 2,
            status: "queued",
          },
        ],
      },
    });

    expect(state.details.one?.turns[0]?.progress.steps[0]?.step).toBe("Проверка");
    expect(state.details.one?.queuedMessages[0]?.text).toBe("Следом");
  });

  it("sorts attention, running, terminal unread, pinned, then recency", () => {
    const threads = [
      { ...baseThread, id: "normal", state: "idle" as const, currentTurnId: null, updatedAt: 100 },
      { ...baseThread, id: "pinned", state: "idle" as const, currentTurnId: null, pinned: true },
      {
        ...baseThread,
        id: "unread",
        state: "completed" as const,
        currentTurnId: null,
        unread: true,
      },
      { ...baseThread, id: "running" },
      { ...baseThread, id: "attention", state: "needsAttention" as const },
    ];
    expect(sortThreads(threads).map((thread) => thread.id)).toEqual([
      "attention",
      "running",
      "unread",
      "pinned",
      "normal",
    ]);
  });
});
