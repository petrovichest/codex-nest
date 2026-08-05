import { describe, expect, it } from "vitest";

import type {
  ActivityItem,
  AppSnapshot,
  CommandReceipt,
  StartTurnRequest,
  ThreadDetail,
  ThreadSummary,
} from "./index.js";
import {
  bearerHeader,
  isAppSnapshot,
  isClientFrame,
  isCommandMetadata,
  isCommandReceipt,
  isCommandReceiptMetadata,
  isServerEvent,
  isServerFrame,
} from "./index.js";

const thread: ThreadSummary = {
  id: "thread-1",
  projectId: "project-1",
  title: "Protocol thread",
  preview: "Testing v2",
  cwd: "/workspace",
  state: "idle",
  unread: false,
  unseen: false,
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  currentTurnId: null,
  queuedMessageCount: 0,
  settings: { collaborationMode: "plan" },
  relation: { kind: "session", sessionId: "session-1" },
};

const detail: ThreadDetail = {
  summary: thread,
  turns: [],
  queuedMessages: [],
  olderTurnsCursor: null,
  draft: null,
  syncPoint: null,
};

const snapshot: AppSnapshot = {
  protocolVersion: 2,
  epoch: "epoch-1",
  revision: 4,
  projectionStatus: "ready",
  uiLanguage: "ru",
  connection: { state: "ready", message: null, syncedAt: "2026-08-05T00:00:00.000Z" },
  projects: [
    {
      id: "project-1",
      displayName: "Project",
      path: "/workspace",
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
    },
  ],
  threads: [thread],
  attention: [],
  models: [],
  taskDefaults: {},
  pushConfigured: false,
  voiceTranscriptions: [],
};

describe("client frame guards", () => {
  it("accepts exact v2 authentication and ping frames", () => {
    expect(
      isClientFrame({
        type: "authenticate",
        protocolVersion: 2,
        token: "secret",
        cursor: { epoch: "epoch-1", revision: 3 },
        threadId: "thread-1",
      }),
    ).toBe(true);
    expect(
      isClientFrame({
        type: "authenticate",
        protocolVersion: 2,
        token: "secret",
        cursor: null,
        threadId: null,
      }),
    ).toBe(true);
    expect(isClientFrame({ type: "ping" })).toBe(true);
  });

  it.each([
    {
      type: "authenticate",
      protocolVersion: 2,
      token: "",
      cursor: null,
      threadId: null,
    },
    {
      type: "authenticate",
      protocolVersion: 1,
      token: "secret",
      cursor: null,
      threadId: null,
    },
    {
      type: "authenticate",
      protocolVersion: 2,
      token: "secret",
      cursor: { epoch: "", revision: 0 },
      threadId: null,
    },
    {
      type: "authenticate",
      protocolVersion: 2,
      token: "secret",
      cursor: { epoch: "epoch-1", revision: -1 },
      threadId: null,
    },
    {
      type: "authenticate",
      protocolVersion: 2,
      token: "secret",
      cursor: null,
      threadId: "",
    },
    { type: "ping", extra: true },
    { type: "other" },
  ])("rejects malformed or extended client frame %#", (frame) => {
    expect(isClientFrame(frame)).toBe(false);
  });
});

describe("server frame guards", () => {
  it("accepts snapshot and immediate resync/thread-open frames", () => {
    expect(isAppSnapshot(snapshot)).toBe(true);
    expect(isServerFrame({ type: "snapshot", protocolVersion: 2, snapshot })).toBe(true);
    expect(isServerFrame({ type: "resync", protocolVersion: 2, snapshot })).toBe(true);
    expect(
      isServerFrame({
        type: "thread.open",
        protocolVersion: 2,
        threadId: "thread-1",
        detail,
      }),
    ).toBe(true);
    expect(
      isServerEvent({
        type: "projection.replaced",
        snapshot,
      }),
    ).toBe(true);
    expect(
      isServerFrame({
        type: "thread.open",
        protocolVersion: 2,
        threadId: "missing-thread",
        detail: null,
      }),
    ).toBe(true);
  });

  it("accepts contiguous replay, live patch, pong, and client update errors", () => {
    expect(
      isServerFrame({
        type: "replay",
        protocolVersion: 2,
        epoch: "epoch-1",
        fromRevision: 2,
        toRevision: 4,
        patches: [
          {
            revision: 3,
            event: { type: "projects.reordered", projects: [] },
          },
          {
            revision: 4,
            event: { type: "attention.removed", attentionId: "attention-1" },
          },
        ],
      }),
    ).toBe(true);
    expect(
      isServerFrame({
        type: "patch",
        protocolVersion: 2,
        epoch: "epoch-1",
        revision: 5,
        event: { type: "thread.upserted", thread },
      }),
    ).toBe(true);
    expect(isServerFrame({ type: "pong" })).toBe(true);
    expect(
      isServerFrame({
        type: "error",
        error: {
          code: "client_update_required",
          message: "Update the client",
        },
      }),
    ).toBe(true);
  });

  it.each([
    {
      type: "snapshot",
      protocolVersion: 2,
      snapshot: { ...snapshot, sequence: 4 },
    },
    {
      type: "snapshot",
      protocolVersion: 2,
      snapshot,
      activeThread: null,
    },
    {
      type: "replay",
      protocolVersion: 2,
      epoch: "epoch-1",
      fromRevision: 2,
      toRevision: 4,
      patches: [
        { revision: 4, event: { type: "projects.reordered", projects: [] } },
        { revision: 3, event: { type: "projects.reordered", projects: [] } },
      ],
    },
    {
      type: "replay",
      protocolVersion: 2,
      epoch: "epoch-1",
      fromRevision: 4,
      toRevision: 3,
      patches: [],
    },
    {
      type: "patch",
      protocolVersion: 2,
      epoch: "epoch-1",
      revision: 5.5,
      event: { type: "projects.reordered", projects: [] },
    },
    {
      type: "patch",
      protocolVersion: 2,
      epoch: "epoch-1",
      revision: 5,
      event: { type: "projects.reordered", projects: [], extra: true },
    },
    {
      type: "thread.open",
      protocolVersion: 2,
      threadId: "another-thread",
      detail,
    },
    { type: "pong", extra: true },
    { type: "error", error: { code: "unknown", message: "no" } },
  ])("rejects malformed or extended server frame %#", (frame) => {
    expect(isServerFrame(frame)).toBe(false);
  });

  it("does not admit legacy sequence, event, activity delta, or resync projection forms", () => {
    expect(
      isServerFrame({
        type: "event",
        sequence: 5,
        event: { type: "projects.reordered", projects: [] },
      }),
    ).toBe(false);
    expect(
      isServerEvent({
        type: "activity.delta",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        activityType: "reasoning",
        delta: "legacy",
      }),
    ).toBe(false);
    expect(isServerEvent({ type: "resync.required" })).toBe(false);
  });

  it("rejects malformed nested snapshot and thread data", () => {
    expect(isAppSnapshot({ ...snapshot, threads: [{}] })).toBe(false);
    expect(
      isServerFrame({
        type: "thread.open",
        protocolVersion: 2,
        threadId: "thread-1",
        detail: { ...detail, queuedMessages: [{ id: "incomplete" }] },
      }),
    ).toBe(false);
  });
});

describe("command receipts", () => {
  const metadata = {
    commandId: "command-1",
    kind: "turn.start",
    threadId: "thread-1",
    turnId: null,
    expectedThreadId: "thread-1",
    expectedRevision: 4,
    payload: { input: "Continue" },
  };

  it("accepts command metadata and all receipt statuses", () => {
    expect(
      isCommandMetadata({
        commandId: "command-1",
        expectedThreadId: "thread-1",
        expectedTurnId: null,
        expectedRevision: 4,
      }),
    ).toBe(true);
    expect(isCommandReceiptMetadata(metadata)).toBe(true);
    for (const status of ["pending", "succeeded", "noop", "conflict", "failed"] as const) {
      const receipt = {
        ...metadata,
        status,
        result: status === "pending" ? null : { turnId: "turn-1" },
        createdAt: 10,
        updatedAt: status === "pending" ? 10 : 11,
      } satisfies CommandReceipt;
      expect(isCommandReceipt(receipt), status).toBe(true);
    }
  });

  it.each([
    { ...metadata, status: "pending", result: { accepted: true }, createdAt: 10, updatedAt: 10 },
    { ...metadata, status: "unknown", result: null, createdAt: 10, updatedAt: 10 },
    { ...metadata, status: "failed", result: null, createdAt: 10, updatedAt: 9 },
    {
      ...metadata,
      status: "failed",
      result: undefined,
      createdAt: 10,
      updatedAt: 11,
    },
    {
      ...metadata,
      extra: true,
      status: "noop",
      result: null,
      createdAt: 10,
      updatedAt: 11,
    },
  ])("rejects malformed command receipt %#", (receipt) => {
    expect(isCommandReceipt(receipt)).toBe(false);
  });

  it("shares request command metadata across turn commands", () => {
    const request = {
      input: "Continue",
      commandId: "command-1",
      expectedThreadId: "thread-1",
      expectedTurnId: null,
      expectedRevision: 4,
    } satisfies StartTurnRequest;
    expect(request.commandId).toBe("command-1");
    expect(isCommandMetadata(request)).toBe(false);
    expect(
      isCommandMetadata({
        commandId: request.commandId,
        expectedThreadId: request.expectedThreadId,
        expectedTurnId: request.expectedTurnId,
        expectedRevision: request.expectedRevision,
      }),
    ).toBe(true);
  });
});

describe("other protocol compatibility", () => {
  it("formats bearer credentials without putting them in a URL", () => {
    expect(bearerHeader("abc")).toBe("Bearer abc");
  });

  it("keeps v1 orchestration notices valid while carrying optional v2 results", () => {
    const v1 = {
      type: "orchestrationNotice",
      id: "v1",
      status: "completed",
      agents: [
        {
          threadId: "child-v1",
          title: "Legacy child",
          nickname: null,
          outcome: "completed",
        },
      ],
      timestamp: 1,
      afterItemId: null,
    } satisfies ActivityItem;
    const v2 = {
      type: "orchestrationNotice",
      id: "v2",
      status: "completed",
      agents: [
        {
          threadId: "child-v2",
          taskId: "task-v2",
          title: "Rich child",
          nickname: "reviewer",
          outcome: "completed",
          result: {
            outcome: "partial",
            summary: "Implemented the focused change.",
            checks: [{ name: "client tests", outcome: "passed", details: "12 passed" }],
          },
          budgetReason: "tokenBudget",
          changedPaths: ["apps/client/src/components/ThreadPage.tsx"],
          changedPathCount: 24,
          workspaceIntegrationStatus: "integrated",
        },
      ],
      timestamp: 2,
      afterItemId: "continuation",
    } satisfies ActivityItem;

    expect(v1.agents[0]).not.toHaveProperty("result");
    expect(v2.agents[0]!.result).toMatchObject({ outcome: "partial" });
  });
});
