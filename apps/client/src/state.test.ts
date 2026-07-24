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
  unseen: false,
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
  uiLanguage: "ru",
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
      details: {
        old: { summary: baseThread, turns: [], queuedMessages: [], olderTurnsCursor: null },
      },
    };
    const next = clientReducer(dirty, { type: "snapshot", snapshot });
    expect(next.snapshot).toBe(snapshot);
    expect(next.network).toBe("connected");
    expect(next.details.old).toBeDefined();
  });

  it("tracks the reasoning effort used for new sessions", () => {
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "event",
      sequence: 5,
      event: { type: "defaultReasoningEffort.changed", reasoningEffort: "high" },
    });
    expect(state.snapshot?.defaultReasoningEffort).toBe("high");

    state = clientReducer(state, {
      type: "event",
      sequence: 6,
      event: { type: "defaultReasoningEffort.changed", reasoningEffort: null },
    });
    expect(state.snapshot?.defaultReasoningEffort).toBeUndefined();
  });

  it("applies the server-synchronized interface language", () => {
    const state = clientReducer(clientReducer(initialState, { type: "snapshot", snapshot }), {
      type: "event",
      sequence: 5,
      event: { type: "uiLanguage.changed", language: "en" },
    });

    expect(state.snapshot?.uiLanguage).toBe("en");
    expect(state.snapshot?.sequence).toBe(5);
  });

  it("invalidates loaded thread details when the server requires a resync", () => {
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    const epoch = state.snapshotEpoch;

    state = clientReducer(state, {
      type: "event",
      sequence: 5,
      event: { type: "resync.required" },
    });

    expect(state.snapshot?.sequence).toBe(5);
    expect(state.snapshotEpoch).toBe(epoch + 1);
  });

  it("applies task defaults and native goal events without polling", () => {
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "event",
      sequence: 5,
      event: {
        type: "taskDefaults.changed",
        taskDefaults: { serviceTier: "fast", personality: "friendly" },
      },
    });
    const goal = {
      threadId: "one",
      objective: "Завершить задачу",
      status: "active" as const,
      tokenBudget: null,
      tokensUsed: 10,
      timeUsedSeconds: 2,
      createdAt: 1,
      updatedAt: 2,
    };
    state = clientReducer(state, {
      type: "event",
      sequence: 6,
      event: { type: "goal.changed", threadId: "one", goal },
    });

    expect(state.snapshot?.taskDefaults).toEqual({
      serviceTier: "fast",
      personality: "friendly",
    });
    expect(state.goals.one).toEqual(goal);
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
            startedAt: null,
            completedAt: null,
            durationMs: null,
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
        olderTurnsCursor: null,
      },
      page: "latest",
    });
    state = clientReducer(state, {
      type: "event",
      sequence: 5,
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "turn",
        item: {
          type: "agentMessage",
          id: "item",
          status: "inProgress",
          text: "Прив",
          images: [],
          timestamp: 1,
          phase: "commentary",
        },
      },
    });
    state = clientReducer(state, {
      type: "event",
      sequence: 6,
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "turn",
        item: {
          type: "agentMessage",
          id: "item",
          status: "completed",
          text: "Привет",
          images: [],
          timestamp: 2,
          phase: "final_answer",
        },
      },
    });
    expect(state.details.one?.turns[0]?.items).toEqual([
      {
        type: "agentMessage",
        id: "item",
        status: "completed",
        text: "Привет",
        images: [],
        timestamp: 2,
        phase: "final_answer",
      },
    ]);
  });

  it("applies server-owned settings to the list and loaded detail", () => {
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "detail",
      detail: { summary: baseThread, turns: [], queuedMessages: [], olderTurnsCursor: null },
      page: "latest",
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

  it("applies the server-owned project order", () => {
    const one = {
      id: "one",
      displayName: "One",
      path: "/one",
      createdAt: "x",
      updatedAt: "x",
    };
    const two = { ...one, id: "two", displayName: "Two", path: "/two" };
    let state = clientReducer(initialState, {
      type: "snapshot",
      snapshot: { ...snapshot, projects: [one, two] },
    });

    state = clientReducer(state, {
      type: "event",
      sequence: 5,
      event: { type: "projects.reordered", projects: [two, one] },
    });

    expect(state.snapshot?.projects.map((project) => project.id)).toEqual(["two", "one"]);
  });

  it("applies live progress and the server-owned message queue", () => {
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "detail",
      detail: { summary: baseThread, turns: [], queuedMessages: [], olderTurnsCursor: null },
      page: "latest",
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

  it("prepends older pages and keeps their cursor across latest-page refreshes", () => {
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "detail",
      page: "latest",
      detail: {
        summary: baseThread,
        turns: [turn("newer")],
        queuedMessages: [],
        olderTurnsCursor: "page-2",
      },
    });
    state = clientReducer(state, {
      type: "detail",
      page: "older",
      detail: {
        summary: baseThread,
        turns: [turn("oldest"), turn("older")],
        queuedMessages: [],
        olderTurnsCursor: "page-3",
      },
    });
    state = clientReducer(state, {
      type: "detail",
      page: "latest",
      detail: {
        summary: baseThread,
        turns: [turn("newer"), turn("newest")],
        queuedMessages: [],
        olderTurnsCursor: "shifted-page-2",
      },
    });

    expect(state.details.one?.turns.map((item) => item.id)).toEqual([
      "oldest",
      "older",
      "newer",
      "newest",
    ]);
    expect(state.details.one?.olderTurnsCursor).toBe("page-3");
  });

  it("reconciles an optimistic message whether the event arrives before or after acceptance", () => {
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "optimistic.add",
      message: {
        id: "client-message",
        threadId: "one",
        text: "Сразу видно",
        images: [],
        createdAt: 10,
        destination: "turn",
        turnId: null,
      },
    });
    state = clientReducer(state, {
      type: "event",
      sequence: 5,
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "server-turn",
        item: {
          type: "userMessage",
          id: "client-message",
          status: "completed",
          text: "Сразу видно",
          images: [],
          timestamp: 10,
          phase: null,
        },
      },
    });
    state = clientReducer(state, {
      type: "optimistic.accept",
      threadId: "one",
      messageId: "client-message",
      turnId: "server-turn",
    });

    expect(state.optimisticMessages.one).toBeUndefined();
    expect(state.details.one?.turns[0]?.items.map((item) => item.id)).toEqual(["client-message"]);

    state = clientReducer(state, {
      type: "optimistic.add",
      message: {
        id: "client-message",
        threadId: "one",
        text: "Сразу видно",
        images: [],
        createdAt: 10,
        destination: "turn",
        turnId: "server-turn",
      },
    });
    expect(state.optimisticMessages.one).toBeUndefined();
  });

  it("does not let a stale detail remove confirmed messages or roll back streamed text", () => {
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "detail",
      page: "latest",
      detail: {
        summary: baseThread,
        turns: [{ ...turn("turn"), status: "inProgress", completedAt: null, items: [] }],
        queuedMessages: [
          {
            id: "client-message",
            threadId: "one",
            text: "Не пропадай",
            createdAt: 5,
            status: "dispatching",
          },
        ],
        olderTurnsCursor: null,
      },
    });
    state = clientReducer(state, {
      type: "event",
      sequence: 5,
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "turn",
        item: {
          type: "userMessage",
          id: "client-message",
          status: "completed",
          text: "Не пропадай",
          images: [],
          timestamp: 5,
          phase: null,
        },
      },
    });
    state = clientReducer(state, {
      type: "event",
      sequence: 6,
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "turn",
        item: {
          type: "agentMessage",
          id: "agent",
          status: "inProgress",
          text: "Уже пишу длинный ответ",
          images: [],
          timestamp: 6,
          phase: "commentary",
        },
      },
    });

    state = clientReducer(state, {
      type: "detail",
      page: "latest",
      detail: {
        summary: baseThread,
        turns: [
          {
            ...turn("turn"),
            status: "inProgress",
            completedAt: null,
            items: [
              {
                type: "command",
                id: "command-before-agent",
                status: "completed",
                kind: "command",
                command: "true",
                cwd: null,
                output: "",
                exitCode: 0,
              },
              {
                type: "agentMessage",
                id: "agent",
                status: "inProgress",
                text: "Уже пишу",
                images: [],
                timestamp: 6,
                phase: "commentary",
              },
            ],
          },
        ],
        queuedMessages: [
          {
            id: "client-message",
            threadId: "one",
            text: "Не пропадай",
            createdAt: 5,
            status: "dispatching",
          },
        ],
        olderTurnsCursor: null,
      },
    });

    expect(state.details.one?.turns[0]?.items).toMatchObject([
      { type: "userMessage", id: "client-message", text: "Не пропадай" },
      { type: "command", id: "command-before-agent" },
      { type: "agentMessage", id: "agent", text: "Уже пишу длинный ответ" },
    ]);
    expect(state.details.one?.queuedMessages).toEqual([]);
    expect(state.optimisticMessages.one).toBeUndefined();

    state = clientReducer(state, {
      type: "event",
      sequence: 7,
      event: {
        type: "queue.changed",
        threadId: "one",
        messages: [
          {
            id: "client-message",
            threadId: "one",
            text: "Не пропадай",
            createdAt: 5,
            status: "dispatching",
          },
        ],
      },
    });
    expect(state.details.one?.queuedMessages).toEqual([]);

    state = clientReducer(state, {
      type: "detail",
      page: "latest",
      detail: {
        summary: { ...baseThread, currentTurnId: null, state: "completed" },
        turns: [
          {
            ...turn("turn"),
            items: [
              {
                type: "agentMessage",
                id: "agent",
                status: "completed",
                text: "Уже пишу",
                images: [],
                timestamp: 7,
                phase: "final_answer",
              },
            ],
          },
        ],
        queuedMessages: [],
        olderTurnsCursor: null,
      },
    });
    expect(state.details.one?.turns[0]?.items[2]).toMatchObject({
      status: "completed",
      text: "Уже пишу длинный ответ",
      phase: "final_answer",
    });

    state = clientReducer(state, {
      type: "event",
      sequence: 8,
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "turn",
        item: {
          type: "agentMessage",
          id: "agent",
          status: "inProgress",
          text: "Уже пишу",
          images: [],
          timestamp: 6,
          phase: "commentary",
        },
      },
    });
    expect(state.details.one?.turns[0]?.items[2]).toMatchObject({
      status: "completed",
      text: "Уже пишу длинный ответ",
      phase: "final_answer",
    });

    state = clientReducer(state, {
      type: "detail",
      page: "latest",
      detail: {
        summary: baseThread,
        turns: [
          {
            ...turn("turn"),
            status: "inProgress",
            completedAt: null,
            durationMs: null,
            items: [],
          },
        ],
        queuedMessages: [],
        olderTurnsCursor: null,
      },
    });
    expect(state.details.one?.turns[0]).toMatchObject({
      status: "completed",
      completedAt: 2,
      durationMs: 1,
    });
  });

  it("reconciles one streamed message with its differently-id canonical item", () => {
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "detail",
      page: "latest",
      detail: {
        summary: baseThread,
        turns: [
          {
            ...turn("turn"),
            status: "inProgress",
            completedAt: null,
            items: [
              {
                type: "agentMessage",
                id: "stream-agent",
                status: "inProgress",
                text: "Готово полностью",
                images: [],
                timestamp: 5,
                phase: null,
              },
              {
                type: "planChecklist",
                id: "checklist",
                status: "inProgress",
                explanation: null,
                steps: [{ step: "Ответить", status: "completed" }],
                timestamp: 6,
                afterItemId: "stream-agent",
              },
            ],
          },
        ],
        queuedMessages: [],
        olderTurnsCursor: null,
      },
    });
    const canonicalDetail = {
      summary: { ...baseThread, currentTurnId: null, state: "completed" as const },
      turns: [
        {
          ...turn("turn"),
          items: [
            {
              type: "agentMessage" as const,
              id: "canonical-agent",
              status: "completed" as const,
              text: "Готово",
              images: [],
              timestamp: 7,
              phase: "final_answer" as const,
            },
          ],
        },
      ],
      queuedMessages: [],
      olderTurnsCursor: null,
    };

    state = clientReducer(state, {
      type: "event",
      sequence: 9,
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "turn",
        item: canonicalDetail.turns[0].items[0],
      },
    });
    expect(
      state.details.one?.turns[0]?.items.filter((item) => item.type === "agentMessage"),
    ).toHaveLength(2);

    state = clientReducer(state, { type: "detail", page: "latest", detail: canonicalDetail });
    state = clientReducer(state, { type: "detail", page: "latest", detail: canonicalDetail });

    expect(state.details.one?.turns[0]?.items).toMatchObject([
      {
        type: "agentMessage",
        id: "canonical-agent",
        status: "completed",
        text: "Готово полностью",
        phase: "final_answer",
      },
      { type: "planChecklist", id: "checklist", afterItemId: "canonical-agent" },
    ]);
  });

  it("keeps chronological plan checklists after their respective anchors", () => {
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "detail",
      page: "latest",
      detail: {
        summary: baseThread,
        turns: [
          {
            ...turn("turn"),
            status: "inProgress",
            items: [
              {
                type: "tool",
                id: "request",
                status: "completed",
                title: "Вопрос",
                detail: "",
              },
            ],
          },
        ],
        queuedMessages: [],
        olderTurnsCursor: null,
      },
    });
    state = clientReducer(state, {
      type: "event",
      sequence: 6,
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "turn",
        item: {
          type: "userInputResponse",
          id: "response",
          status: "completed",
          entries: [{ header: "Выбор", question: "Как?", answers: ["Так"] }],
          timestamp: 3,
          afterItemId: "request",
        },
      },
    });
    const checklist = {
      type: "planChecklist" as const,
      id: "checklist",
      status: "inProgress" as const,
      explanation: "Работаю",
      steps: [{ step: "Шаг", status: "inProgress" as const }],
      timestamp: 4,
      afterItemId: "response",
    };
    state = clientReducer(state, {
      type: "event",
      sequence: 7,
      event: { type: "activity.upserted", threadId: "one", turnId: "turn", item: checklist },
    });
    state = clientReducer(state, {
      type: "event",
      sequence: 8,
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "turn",
        item: {
          type: "agentMessage",
          id: "progress-message",
          status: "completed",
          text: "Перехожу дальше",
          images: [],
          timestamp: 5,
          phase: "commentary",
        },
      },
    });
    state = clientReducer(state, {
      type: "event",
      sequence: 9,
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "turn",
        item: {
          ...checklist,
          id: "completed-checklist",
          timestamp: 6,
          afterItemId: "progress-message",
          steps: [{ step: "Шаг", status: "completed" }],
        },
      },
    });
    state = clientReducer(state, {
      type: "event",
      sequence: 10,
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "turn",
        item: {
          type: "plan",
          id: "final",
          status: "completed",
          text: "План",
          images: [],
          timestamp: 7,
          phase: null,
        },
      },
    });

    expect(state.details.one?.turns[0]?.items.map((item) => item.id)).toEqual([
      "request",
      "response",
      "checklist",
      "progress-message",
      "completed-checklist",
      "final",
    ]);
    expect(
      state.details.one?.turns[0]?.items.find((item) => item.id === "completed-checklist"),
    ).toMatchObject({ steps: [{ status: "completed" }] });
  });

  it("sorts sessions only by most recent activity", () => {
    const threads = [
      {
        ...baseThread,
        id: "blank",
        title: "Без названия",
        state: "idle" as const,
        currentTurnId: null,
        updatedAt: 10,
      },
      { ...baseThread, id: "normal", state: "idle" as const, currentTurnId: null, updatedAt: 100 },
      {
        ...baseThread,
        id: "pinned",
        state: "idle" as const,
        currentTurnId: null,
        pinned: true,
        updatedAt: 20,
      },
      {
        ...baseThread,
        id: "unread",
        state: "completed" as const,
        currentTurnId: null,
        unread: true,
        updatedAt: 30,
      },
      { ...baseThread, id: "running", updatedAt: 40 },
      { ...baseThread, id: "attention", state: "needsAttention" as const, updatedAt: 50 },
    ];
    expect(sortThreads(threads).map((thread) => thread.id)).toEqual([
      "normal",
      "attention",
      "running",
      "unread",
      "pinned",
      "blank",
    ]);
  });
});

function turn(id: string) {
  return {
    id,
    status: "completed" as const,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
    progress: {
      startedAt: 1,
      explanation: null,
      steps: [],
      filesChanged: 0,
      additions: 0,
      deletions: 0,
    },
    items: [],
  };
}
