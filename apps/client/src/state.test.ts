import { describe, expect, it } from "vitest";

import type { AppSnapshot, ThreadDetail, ThreadSummary } from "@codexnest/protocol";

import { clientReducer, initialState, sortThreads } from "./state";
import { forkOperationsFromSnapshot, type ForkOperationSummary } from "./forks";

const baseThread: ThreadSummary = {
  id: "one",
  relation: { kind: "session", sessionId: "session" },
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
  browserStatus: "disabled",
  settings: { collaborationMode: "default" },
};

const snapshot: AppSnapshot = {
  instanceId: "legacy",
  sequence: 4,
  uiLanguage: "ru",
  connection: { state: "ready", message: null, syncedAt: null },
  projects: [],
  threads: [baseThread],
  forkOperations: [],
  attention: [],
  models: [],
};

describe("clientReducer", () => {
  it("clears unversioned projection data on the first backend snapshot", () => {
    const dirty = {
      ...initialState,
      details: {
        old: { summary: baseThread, turns: [], queuedMessages: [], olderTurnsCursor: null },
      },
    };
    const next = clientReducer(dirty, { type: "snapshot", snapshot });
    expect(next.snapshot).toEqual(snapshot);
    expect(next.network).toBe("connected");
    expect(next.details.old).toBeUndefined();
  });

  it("replaces cached sessions with the first authoritative backend instance", () => {
    const cached = { ...snapshot, instanceId: "cached", sequence: 40, threads: [baseThread] };
    let state = clientReducer(initialState, { type: "hydrate", snapshot: cached, goals: {} });
    state = clientReducer(state, {
      type: "snapshot",
      snapshot: { ...snapshot, sequence: 1, threads: [] },
    });
    expect(state.snapshot?.threads).toEqual([]);
    expect(state.snapshot?.sequence).toBe(1);

    state = clientReducer(state, {
      type: "snapshot",
      snapshot: {
        ...snapshot,
        sequence: 2,
        connection: { ...snapshot.connection, syncedAt: "2026-08-03T00:00:00.000Z" },
        threads: [],
      },
    });
    expect(state.snapshot?.threads).toEqual([]);
  });

  it("hydrates and applies newer complete user-input drafts including the current question", () => {
    const request = userInputAttention({
      answers: { second: ["С сервера"] },
      currentQuestionId: "second",
      revision: 2,
      updatedAt: 20,
    });
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "snapshot",
      snapshot: { ...snapshot, attention: [request] },
    });
    expect(state.userInputDrafts.questions).toMatchObject({
      answers: { second: ["С сервера"] },
      currentQuestionId: "second",
      serverRevision: 2,
    });

    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: {
        type: "attention.upserted",
        attention: {
          ...request,
          draft: {
            answers: { first: ["Новый ответ"] },
            currentQuestionId: "first",
            revision: 3,
            updatedAt: 30,
          },
        },
      },
    });
    expect(state.userInputDrafts.questions).toMatchObject({
      answers: { first: ["Новый ответ"] },
      currentQuestionId: "first",
      serverRevision: 3,
    });
  });

  it("clears a clean revisioned user-input draft when an authoritative snapshot or event has null", () => {
    const request = userInputAttention({
      answers: { first: ["Сохранённый"] },
      currentQuestionId: "first",
      revision: 2,
      updatedAt: 20,
    });
    let state = clientReducer(initialState, {
      type: "snapshot",
      snapshot: { ...snapshot, attention: [request] },
    });
    expect(state.userInputDrafts.questions?.serverRevision).toBe(2);

    state = clientReducer(state, {
      type: "snapshot",
      snapshot: { ...snapshot, sequence: 5, attention: [{ ...request, draft: null }] },
    });
    expect(state.userInputDrafts.questions).toBeUndefined();

    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 6 },
      event: { type: "attention.upserted", attention: request },
    });
    expect(state.userInputDrafts.questions?.serverRevision).toBe(2);
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 7 },
      event: {
        type: "attention.upserted",
        attention: { ...request, draft: null },
      },
    });
    expect(state.userInputDrafts.questions).toBeUndefined();
  });

  it("retains a dirty local user-input draft against an authoritative null draft", () => {
    const request = userInputAttention({
      answers: { first: ["Сохранённый"] },
      currentQuestionId: "first",
      revision: 2,
      updatedAt: 20,
    });
    let state = clientReducer(initialState, {
      type: "snapshot",
      snapshot: { ...snapshot, attention: [request] },
    });
    state = clientReducer(state, {
      type: "userInputDraft.edit",
      attentionId: "questions",
      version: 1,
      draft: { answers: { second: ["Локальный"] }, currentQuestionId: "second" },
    });

    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: {
        type: "attention.upserted",
        attention: { ...request, draft: null },
      },
    });
    expect(state.userInputDrafts.questions).toMatchObject({
      answers: { second: ["Локальный"] },
      currentQuestionId: "second",
      localVersion: 1,
      savedVersion: 0,
    });

    state = clientReducer(state, {
      type: "snapshot",
      snapshot: { ...snapshot, sequence: 6, attention: [{ ...request, draft: null }] },
    });
    expect(state.userInputDrafts.questions).toMatchObject({
      answers: { second: ["Локальный"] },
      currentQuestionId: "second",
      localVersion: 1,
      savedVersion: 0,
    });
  });

  it("protects dirty user-input drafts from remote echoes, then accepts remote state when clean", () => {
    const request = userInputAttention({
      answers: { first: ["Старый"] },
      currentQuestionId: "first",
      revision: 1,
      updatedAt: 10,
    });
    let state = clientReducer(initialState, {
      type: "snapshot",
      snapshot: { ...snapshot, attention: [request] },
    });
    state = clientReducer(state, {
      type: "userInputDraft.edit",
      attentionId: "questions",
      version: 1,
      draft: { answers: { second: ["Локальный"] }, currentQuestionId: "second" },
    });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: {
        type: "attention.upserted",
        attention: {
          ...request,
          draft: {
            answers: { first: ["Удалённый"] },
            currentQuestionId: "first",
            revision: 2,
            updatedAt: 20,
          },
        },
      },
    });
    expect(state.userInputDrafts.questions).toMatchObject({
      answers: { second: ["Локальный"] },
      currentQuestionId: "second",
      serverRevision: 2,
      localVersion: 1,
      savedVersion: 0,
    });

    state = clientReducer(state, {
      type: "userInputDraft.saved",
      attentionId: "questions",
      version: 1,
      draft: {
        answers: { second: ["Локальный"] },
        currentQuestionId: "second",
        revision: 3,
        updatedAt: 30,
      },
    });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 6 },
      event: {
        type: "attention.upserted",
        attention: {
          ...request,
          draft: {
            answers: {},
            currentQuestionId: "first",
            revision: 4,
            updatedAt: 40,
          },
        },
      },
    });
    expect(state.userInputDrafts.questions).toMatchObject({
      answers: {},
      currentQuestionId: "first",
      serverRevision: 4,
    });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 7 },
      event: { type: "attention.removed", attentionId: "questions" },
    });
    expect(state.userInputDrafts.questions).toBeUndefined();
  });

  it("appends compact activity deltas without replacing the whole item", () => {
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
            itemsLoaded: false,
            items: [
              {
                type: "agentMessage",
                id: "answer",
                status: "inProgress",
                text: "Начало",
                images: [],
                timestamp: 1,
                phase: "commentary",
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
      version: { instanceId: "legacy", sequence: 5 },
      event: {
        type: "activity.delta",
        threadId: "one",
        turnId: "turn",
        itemId: "answer",
        activityType: "agentMessage",
        delta: " ответа",
      },
    });
    expect(state.details.one?.turns[0]?.items[0]).toMatchObject({ text: "Начало ответа" });
  });

  it("merges lazily loaded turn items in canonical order", () => {
    const user = {
      type: "userMessage" as const,
      id: "user",
      status: "completed" as const,
      text: "Запрос",
      images: [],
      timestamp: 1,
      phase: null,
    };
    const answer = {
      type: "agentMessage" as const,
      id: "answer",
      status: "completed" as const,
      text: "Ответ",
      images: [],
      timestamp: 2,
      phase: "final_answer" as const,
    };
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "detail",
      page: "latest",
      detail: {
        summary: baseThread,
        turns: [{ ...turn("turn"), itemsLoaded: false, items: [user, answer] }],
        queuedMessages: [],
        olderTurnsCursor: null,
      },
    });
    state = clientReducer(state, {
      type: "turn.items",
      threadId: "one",
      turnId: "turn",
      items: [
        { ...user, timestamp: null },
        {
          type: "command",
          id: "command",
          status: "completed",
          kind: "command",
          command: "pwd",
          cwd: "/work",
          output: "/work",
          exitCode: 0,
        },
        { ...answer, timestamp: null },
      ],
    });
    expect(state.details.one?.turns[0]?.items.map((item) => item.id)).toEqual([
      "user",
      "command",
      "answer",
    ]);
    expect(state.details.one?.turns[0]?.itemsLoaded).toBe(true);

    state = clientReducer(state, {
      type: "detail",
      detail: {
        version: { instanceId: "legacy", sequence: 5 },
        summary: baseThread,
        turns: [{ ...turn("turn"), itemsLoaded: false, items: [user, answer] }],
        queuedMessages: [],
        olderTurnsCursor: null,
      },
    });
    expect(state.details.one?.turns[0]?.items.map((item) => item.id)).toEqual([
      "user",
      "command",
      "answer",
    ]);
    expect(state.details.one?.turns[0]?.itemsLoaded).toBe(true);
  });

  it("tracks the reasoning effort used for new sessions", () => {
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: { type: "defaultReasoningEffort.changed", reasoningEffort: "high" },
    });
    expect(state.snapshot?.defaultReasoningEffort).toBe("high");

    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 6 },
      event: { type: "defaultReasoningEffort.changed", reasoningEffort: null },
    });
    expect(state.snapshot?.defaultReasoningEffort).toBeUndefined();
  });

  it("applies the server-synchronized interface language", () => {
    const state = clientReducer(clientReducer(initialState, { type: "snapshot", snapshot }), {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
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
      version: { instanceId: "legacy", sequence: 5 },
      event: { type: "resync.required" },
    });

    expect(state.snapshot?.sequence).toBe(5);
    expect(state.snapshotEpoch).toBe(epoch + 1);
  });

  it("increments the skills revision for skills.changed events", () => {
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    const epoch = state.skillsEpoch;

    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: { type: "skills.changed" },
    });

    expect(state.snapshot?.sequence).toBe(5);
    expect(state.skillsEpoch).toBe(epoch + 1);
  });

  it("upserts and removes fork operations from streamed events", () => {
    const operation: ForkOperationSummary = {
      id: "fork",
      sourceThreadId: "one",
      lastTurnId: "turn",
      agentMessageId: "answer",
      mode: "compressed",
      status: "preparing",
      title: "",
      createdAt: 1,
      updatedAt: 1,
      targetThreadId: null,
      queuedMessageCount: 0,
      estimate: null,
      error: null,
    };
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: { type: "forkOperation.upserted", operation } as never,
    });
    expect(forkOperationsFromSnapshot(state.snapshot)).toEqual([operation]);

    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 6 },
      event: { type: "forkOperation.removed", operationId: operation.id } as never,
    });
    expect(forkOperationsFromSnapshot(state.snapshot)).toEqual([]);
  });

  it("applies task defaults and native goal events without polling", () => {
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
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
      version: { instanceId: "legacy", sequence: 6 },
      event: { type: "goal.changed", threadId: "one", goal },
    });

    expect(state.snapshot?.taskDefaults).toEqual({
      serviceTier: "fast",
      personality: "friendly",
    });
    expect(state.goals.one).toEqual(goal);
  });

  it("tracks durable voice jobs from responses and server events", () => {
    const job = {
      id: "voice",
      threadId: "one",
      mode: "draft" as const,
      status: "queued" as const,
      createdAt: 10,
      startedAt: null,
      audioDurationMs: 2_000,
      estimatedTotalSeconds: null,
      error: null,
    };
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, { type: "voice.accepted", job });
    expect(state.snapshot?.voiceTranscriptions).toEqual([job]);

    const transcribing = { ...job, status: "transcribing" as const, startedAt: 11 };
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: { type: "voiceTranscription.upserted", job: transcribing },
    });
    expect(state.snapshot?.voiceTranscriptions).toEqual([transcribing]);

    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 6 },
      event: {
        type: "voiceTranscription.removed",
        threadId: "one",
        jobId: "voice",
        outcome: "draft",
      },
    });
    expect(state.snapshot?.voiceTranscriptions).toEqual([]);
    expect(state.voiceRemovals.one).toEqual({ jobId: "voice", outcome: "draft" });

    state = clientReducer(state, { type: "voice.accepted", job });
    expect(state.snapshot?.voiceTranscriptions).toEqual([]);
  });

  it("does not let a late upload acknowledgement roll transcription back to queued", () => {
    const queued = {
      id: "voice",
      threadId: "one",
      mode: "draft" as const,
      status: "queued" as const,
      createdAt: 10,
      startedAt: null,
      audioDurationMs: 2_000,
      estimatedTotalSeconds: null,
      error: null,
    };
    const transcribing = { ...queued, status: "transcribing" as const, startedAt: 11 };
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: { type: "voiceTranscription.upserted", job: transcribing },
    });

    state = clientReducer(state, { type: "voice.accepted", job: queued });

    expect(state.snapshot?.voiceTranscriptions).toEqual([transcribing]);
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
      version: { instanceId: "legacy", sequence: 5 },
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
      version: { instanceId: "legacy", sequence: 6 },
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

  it("reconciles a late live completion after canonical terminal detail", () => {
    const live = {
      type: "agentMessage" as const,
      id: "msg-live",
      status: "inProgress" as const,
      text: "Готово",
      images: [],
      timestamp: 1,
      phase: "final_answer" as const,
    };
    const canonical = {
      ...live,
      id: "item-20",
      status: "completed" as const,
      timestamp: 2,
    };
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "detail",
      detail: {
        summary: baseThread,
        turns: [{ ...turn("turn"), status: "inProgress", completedAt: null, items: [live] }],
        queuedMessages: [],
        olderTurnsCursor: null,
      },
    });
    state = clientReducer(state, {
      type: "detail",
      detail: {
        summary: baseThread,
        turns: [{ ...turn("turn"), items: [canonical] }],
        queuedMessages: [],
        olderTurnsCursor: null,
      },
    });

    expect(state.details.one?.turns[0]?.items.map((item) => item.id)).toEqual(["item-20"]);

    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "turn",
        item: { ...live, status: "completed", timestamp: 2 },
      },
    });

    expect(state.details.one?.turns[0]?.items).toEqual([canonical]);
  });

  it("keeps independent identical completions while a turn is active", () => {
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "detail",
      detail: {
        summary: baseThread,
        turns: [{ ...turn("turn"), status: "inProgress", completedAt: null }],
        queuedMessages: [],
        olderTurnsCursor: null,
      },
    });

    for (const [sequence, id] of [
      [5, "first"],
      [6, "second"],
    ] as const) {
      state = clientReducer(state, {
        type: "event",
        version: { instanceId: "legacy", sequence },
        event: {
          type: "activity.upserted",
          threadId: "one",
          turnId: "turn",
          item: {
            type: "agentMessage",
            id,
            status: "completed",
            text: "Повтор",
            images: [],
            timestamp: sequence,
            phase: "commentary",
          },
        },
      });
    }

    expect(state.details.one?.turns[0]?.items.map((item) => item.id)).toEqual(["first", "second"]);
  });

  it("inserts delayed activities by timestamp without disturbing untimed activities", () => {
    const message = (id: string, timestamp: number | null) => ({
      type: "agentMessage" as const,
      id,
      status: "completed" as const,
      text: id,
      images: [],
      timestamp,
      phase: "commentary" as const,
    });
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "detail",
      detail: {
        summary: baseThread,
        turns: [
          {
            ...turn("turn"),
            status: "inProgress",
            completedAt: null,
            items: [
              message("+50", 31),
              {
                type: "command",
                id: "command",
                status: "completed",
                kind: "command",
                command: "true",
                cwd: null,
                output: "",
                exitCode: 0,
              },
              message("+55", 36),
            ],
          },
        ],
        queuedMessages: [],
        olderTurnsCursor: null,
      },
      page: "latest",
    });

    for (const [sequence, item] of [
      [5, message("+40", 20)],
      [6, message("same-time", 36)],
      [7, message("unknown-time", null)],
    ] as const) {
      state = clientReducer(state, {
        type: "event",
        version: { instanceId: "legacy", sequence },
        event: { type: "activity.upserted", threadId: "one", turnId: "turn", item },
      });
    }

    expect(state.details.one?.turns[0]?.items.map((item) => item.id)).toEqual([
      "+40",
      "+50",
      "command",
      "+55",
      "same-time",
      "unknown-time",
    ]);
  });

  it("keeps the first user message ahead of a response that streamed before it", () => {
    const userMessage = (id: string, timestamp: number) => ({
      type: "userMessage" as const,
      id,
      status: "completed" as const,
      text: id,
      images: [],
      timestamp,
      phase: null,
    });
    const streamedResponse = {
      type: "agentMessage" as const,
      id: "answer",
      status: "inProgress" as const,
      text: "Ответ",
      images: [],
      timestamp: 100,
      phase: null,
    };
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "detail",
      detail: {
        summary: baseThread,
        turns: [
          {
            ...turn("turn"),
            status: "inProgress",
            completedAt: null,
            items: [streamedResponse],
          },
        ],
        queuedMessages: [],
        olderTurnsCursor: null,
      },
      page: "latest",
    });

    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "turn",
        item: userMessage("question", 101),
      },
    });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 6 },
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "turn",
        item: {
          ...streamedResponse,
          status: "completed",
          timestamp: 140,
          phase: "final_answer",
        },
      },
    });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 7 },
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "turn",
        item: userMessage("steer", 120),
      },
    });

    expect(state.details.one?.turns[0]?.items.map((item) => item.id)).toEqual([
      "question",
      "steer",
      "answer",
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
      version: { instanceId: "legacy", sequence: 5 },
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
      version: { instanceId: "legacy", sequence: 5 },
      event: { type: "projects.reordered", projects: [two, one] },
    });

    expect(state.snapshot?.projects.map((project) => project.id)).toEqual(["two", "one"]);
  });

  it("removes a project and all of its session state atomically", () => {
    const project = {
      id: "project",
      displayName: "Project",
      path: "/work",
      createdAt: "x",
      updatedAt: "x",
    };
    const projectThread = { ...baseThread, projectId: project.id };
    const unrelated = { ...baseThread, id: "other", projectId: null };
    let state = clientReducer(initialState, {
      type: "snapshot",
      snapshot: { ...snapshot, projects: [project], threads: [projectThread, unrelated] },
    });
    state = clientReducer(state, {
      type: "detail",
      detail: { summary: projectThread, turns: [], queuedMessages: [], olderTurnsCursor: null },
      page: "latest",
    });

    state = clientReducer(state, {
      type: "project.remove",
      projectId: project.id,
      threadIds: [projectThread.id],
    });

    expect(state.snapshot?.projects).toEqual([]);
    expect(state.snapshot?.threads).toEqual([unrelated]);
    expect(state.details[projectThread.id]).toBeUndefined();
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
      version: { instanceId: "legacy", sequence: 5 },
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
      version: { instanceId: "legacy", sequence: 6 },
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

  it("replaces inherited history when a subagent detail refreshes", () => {
    const subagent: ThreadSummary = {
      ...baseThread,
      relation: {
        kind: "subagent",
        sessionId: "child-session",
        parentThreadId: "parent",
        nickname: "reviewer",
        role: "worker",
      },
    };
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "detail",
      page: "latest",
      detail: {
        summary: subagent,
        turns: [turn("inherited-parent"), turn("child")],
        queuedMessages: [],
        olderTurnsCursor: "parent-page",
      },
    });
    state = clientReducer(state, {
      type: "detail",
      page: "older",
      detail: {
        summary: subagent,
        turns: [turn("older-parent")],
        queuedMessages: [],
        olderTurnsCursor: "more-parent",
      },
    });
    state = clientReducer(state, {
      type: "detail",
      page: "latest",
      detail: {
        summary: subagent,
        turns: [turn("child")],
        queuedMessages: [],
        olderTurnsCursor: "ignored-parent-page",
      },
    });

    expect(state.details.one?.turns.map((item) => item.id)).toEqual(["child"]);
    expect(state.details.one?.olderTurnsCursor).toBeNull();
    expect(state.expandedHistory.one).toBe(false);
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
      version: { instanceId: "legacy", sequence: 5 },
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

  it("moves a confirmed user message to its canonical turn without rendering a duplicate", () => {
    const message = {
      type: "userMessage" as const,
      id: "client-message",
      status: "completed" as const,
      text: "Только один раз",
      images: [],
      timestamp: 10,
      phase: null,
    };
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "detail",
      page: "latest",
      detail: {
        summary: baseThread,
        turns: [
          { ...turn("canonical-turn"), items: [] },
          {
            ...turn("synthetic-turn"),
            items: [
              message,
              {
                type: "agentMessage",
                id: "keep-me",
                status: "completed",
                text: "Соседний элемент",
                images: [],
                timestamp: 11,
                phase: "final_answer",
              },
            ],
          },
        ],
        queuedMessages: [],
        olderTurnsCursor: null,
      },
    });
    state = {
      ...state,
      optimisticMessages: {
        one: [
          {
            id: message.id,
            threadId: "one",
            text: message.text,
            images: [],
            createdAt: message.timestamp,
            destination: "turn",
            turnId: "synthetic-turn",
          },
        ],
      },
      details: {
        ...state.details,
        one: {
          ...state.details.one!,
          queuedMessages: [
            {
              id: message.id,
              threadId: "one",
              text: message.text,
              createdAt: message.timestamp,
              status: "dispatching",
            },
          ],
        },
      },
    };

    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "canonical-turn",
        item: message,
      },
    });

    expect(
      state.details.one?.turns.flatMap((candidate) =>
        candidate.items.filter((item) => item.type === "userMessage" && item.id === message.id),
      ),
    ).toHaveLength(1);
    expect(state.details.one?.turns[0]?.items).toContainEqual(message);
    expect(state.details.one?.turns[1]?.items).toContainEqual(
      expect.objectContaining({ id: "keep-me" }),
    );
    expect(state.details.one?.queuedMessages).toEqual([]);
    expect(state.optimisticMessages.one).toBeUndefined();
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
      version: { instanceId: "legacy", sequence: 6 },
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
      version: { instanceId: "legacy", sequence: 7 },
      event: { type: "activity.upserted", threadId: "one", turnId: "turn", item: checklist },
    });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 8 },
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
      version: { instanceId: "legacy", sequence: 9 },
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
      version: { instanceId: "legacy", sequence: 10 },
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

  it("accepts only forward detail versions from the active backend instance", () => {
    const authoritative = { ...snapshot, instanceId: "primary", sequence: 4 };
    let state = clientReducer(initialState, { type: "snapshot", snapshot: authoritative });
    const detail = (sequence: number, title: string): ThreadDetail => ({
      version: { instanceId: "primary", sequence },
      summary: { ...baseThread, title },
      turns: [turn(`turn-${sequence}`)],
      queuedMessages: [],
      olderTurnsCursor: null,
    });

    state = clientReducer(state, { type: "detail", detail: detail(10, "Актуально") });
    state = clientReducer(state, { type: "detail", detail: detail(9, "Откат") });
    expect(state.details.one?.summary.title).toBe("Актуально");
    expect(state.details.one?.version?.sequence).toBe(10);

    state = clientReducer(state, { type: "detail", detail: detail(11, "Новее") });
    expect(state.details.one?.summary.title).toBe("Новее");
    expect(state.details.one?.version?.sequence).toBe(11);
  });

  it("does not replay an older stream event into a newer HTTP detail", () => {
    let state = clientReducer(initialState, {
      type: "snapshot",
      snapshot: { ...snapshot, instanceId: "primary", sequence: 4 },
    });
    state = clientReducer(state, {
      type: "detail",
      detail: {
        version: { instanceId: "primary", sequence: 10 },
        summary: { ...baseThread, title: "Актуально" },
        turns: [turn("current")],
        queuedMessages: [],
        olderTurnsCursor: null,
      },
    });

    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "primary", sequence: 5 },
      event: {
        type: "thread.upserted",
        thread: { ...baseThread, title: "Старое событие" },
      },
    });

    expect(state.snapshot?.sequence).toBe(5);
    expect(state.details.one?.summary.title).toBe("Актуально");
    expect(state.details.one?.version?.sequence).toBe(10);
  });

  it("keeps rendered session history offline and clears it after a backend restart", () => {
    let state = clientReducer(initialState, {
      type: "snapshot",
      snapshot: { ...snapshot, instanceId: "first" },
    });
    state = clientReducer(state, {
      type: "detail",
      detail: {
        version: { instanceId: "first", sequence: 5 },
        summary: baseThread,
        turns: [turn("turn")],
        queuedMessages: [],
        olderTurnsCursor: null,
      },
    });
    expect(state.details.one).toBeDefined();

    state = clientReducer(state, { type: "network", network: "offline" });
    expect(state.details.one?.turns.map((candidate) => candidate.id)).toEqual(["turn"]);

    state = clientReducer(state, {
      type: "snapshot",
      snapshot: { ...snapshot, instanceId: "second", sequence: 0 },
    });
    expect(state.details).toEqual({});
  });

  it("applies older history only to the page anchor without replacing latest metadata", () => {
    const currentSummary = { ...baseThread, title: "Текущее состояние" };
    let state = clientReducer(initialState, {
      type: "snapshot",
      snapshot: { ...snapshot, instanceId: "primary" },
    });
    state = clientReducer(state, {
      type: "detail",
      detail: {
        version: { instanceId: "primary", sequence: 8 },
        summary: currentSummary,
        turns: [turn("newer"), turn("newest")],
        queuedMessages: [],
        olderTurnsCursor: "older-cursor",
      },
    });
    state = clientReducer(state, {
      type: "history",
      threadId: "one",
      page: {
        instanceId: "primary",
        anchorTurnId: "newer",
        turns: [turn("oldest"), turn("older")],
        olderTurnsCursor: null,
      },
    });

    expect(state.details.one?.turns.map((candidate) => candidate.id)).toEqual([
      "oldest",
      "older",
      "newer",
      "newest",
    ]);
    expect(state.details.one?.summary).toEqual(currentSummary);
    expect(state.details.one?.version?.sequence).toBe(8);

    const unchanged = clientReducer(state, {
      type: "history",
      threadId: "one",
      page: {
        instanceId: "primary",
        anchorTurnId: "stale-anchor",
        turns: [turn("must-not-apply")],
        olderTurnsCursor: null,
      },
    });
    expect(unchanged).toBe(state);
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

function userInputAttention(draft: {
  answers: Record<string, string[]>;
  currentQuestionId: string | null;
  revision: number;
  updatedAt: number;
}) {
  return {
    id: "questions",
    threadId: "one",
    turnId: "turn",
    itemId: "item",
    createdAt: 1,
    kind: "userInput" as const,
    autoResolutionMs: null,
    draft,
    questions: [
      {
        id: "first",
        header: "Первый",
        question: "Первый?",
        isOther: true,
        isSecret: false,
        options: null,
      },
      {
        id: "second",
        header: "Второй",
        question: "Второй?",
        isOther: true,
        isSecret: false,
        options: null,
      },
    ],
  };
}

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
