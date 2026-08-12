import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppSnapshot, AttentionRequest, ThreadSummary } from "@codexnest/protocol";

import {
  BrowserNotificationTracker,
  getBrowserNotificationPermission,
  requestBrowserNotificationPermission,
} from "./browser-notifications";

const notifications: MockNotification[] = [];

class MockNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = vi.fn<() => Promise<NotificationPermission>>();
  onclick: (() => void) | null = null;
  close = vi.fn();

  constructor(
    readonly title: string,
    readonly options?: NotificationOptions,
  ) {
    notifications.push(this);
  }
}

beforeEach(() => {
  notifications.length = 0;
  MockNotification.permission = "granted";
  MockNotification.requestPermission.mockReset();
  vi.stubGlobal("Notification", MockNotification);
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BrowserNotificationTracker", () => {
  it("uses the initial snapshot as a baseline and notifies terminal state changes", () => {
    const tracker = new BrowserNotificationTracker();
    const running = thread("running", 10);
    tracker.acceptSnapshot(snapshot([running]));

    expect(notifications).toHaveLength(0);

    tracker.acceptEvent({
      type: "thread.upserted",
      thread: { ...running, state: "completed", unread: true, updatedAt: 20 },
    });
    tracker.acceptEvent({
      type: "thread.upserted",
      thread: { ...running, state: "completed", unread: true, updatedAt: 21 },
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.title).toBe("Задача завершена");
    expect(notifications[0]?.options).toMatchObject({
      body: "Тестовая задача",
      tag: "completed:thread",
    });
  });

  it("notifies each attention request once and links to its thread", () => {
    const tracker = new BrowserNotificationTracker();
    tracker.acceptSnapshot(snapshot([thread("running", 10)]));
    const attention = attentionRequest(20);

    tracker.acceptEvent({ type: "attention.upserted", attention });
    tracker.acceptEvent({ type: "attention.upserted", attention });
    tracker.acceptEvent({
      type: "thread.upserted",
      thread: { ...thread("needsAttention", 21) },
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.title).toBe("Codex ждёт решения");
    expect(notifications[0]?.options?.body).toBe("Тестовая задача");
  });

  it("uses the server-synchronized language for notification chrome", () => {
    const tracker = new BrowserNotificationTracker();
    const running = thread("running", 10);
    tracker.acceptSnapshot(snapshot([running]));
    tracker.acceptEvent({ type: "uiLanguage.changed", language: "en" });

    tracker.acceptEvent({
      type: "thread.upserted",
      thread: { ...running, state: "failed", updatedAt: 20 },
    });

    expect(notifications[0]?.title).toBe("Task failed");
    expect(notifications[0]?.options?.body).toBe("Тестовая задача");
  });

  it("notifies when a thread starts needing attention without an explicit request", () => {
    const tracker = new BrowserNotificationTracker();
    const running = thread("running", 10);
    tracker.acceptSnapshot(snapshot([running]));

    tracker.acceptEvent({
      type: "thread.upserted",
      thread: { ...running, state: "needsAttention", updatedAt: 20 },
    });
    tracker.acceptEvent({
      type: "thread.upserted",
      thread: { ...running, state: "needsAttention", updatedAt: 21 },
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.title).toBe("Codex ждёт решения");
    expect(notifications[0]?.options).toMatchObject({
      body: "Тестовая задача",
      tag: "needs-attention:thread",
    });
  });

  it("never notifies child sessions from live events or reconnect snapshots", () => {
    const tracker = new BrowserNotificationTracker();
    const child = childThread("running", 10);
    tracker.acceptSnapshot(snapshot([child]));

    tracker.acceptEvent({
      type: "thread.upserted",
      thread: { ...child, state: "completed", unread: true, updatedAt: 20 },
    });
    tracker.acceptEvent({
      type: "attention.upserted",
      attention: attentionRequest(21, child.id),
    });
    tracker.acceptEvent({
      type: "thread.upserted",
      thread: { ...child, state: "needsAttention", updatedAt: 22 },
    });
    tracker.acceptEvent({
      type: "attention.upserted",
      attention: attentionRequest(23, "unknown"),
    });
    tracker.acceptEvent({
      type: "attention.upserted",
      attention: attentionRequest(24, null),
    });
    tracker.acceptSnapshot(
      snapshot(
        [{ ...child, state: "failed", unread: true, updatedAt: 30 }],
        [attentionRequest(31, child.id)],
      ),
    );

    expect(notifications).toHaveLength(0);
  });

  it("does not display system notifications while the page is visible", () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const tracker = new BrowserNotificationTracker();
    const running = thread("running", 10);
    tracker.acceptSnapshot(snapshot([running]));

    tracker.acceptEvent({
      type: "thread.upserted",
      thread: { ...running, state: "failed", updatedAt: 20 },
    });

    expect(notifications).toHaveLength(0);
  });

  it("catches up missed unread outcomes after a reconnect", () => {
    const tracker = new BrowserNotificationTracker();
    tracker.acceptSnapshot(snapshot([thread("running", 10)]));

    tracker.acceptSnapshot(
      snapshot([{ ...thread("completed", 20), unread: true }], [attentionRequest(21)]),
    );

    expect(notifications.map((notification) => notification.title)).toEqual([
      "Задача завершена",
      "Codex ждёт решения",
    ]);
  });

  it("catches up a missed needs-attention state after a reconnect", () => {
    const tracker = new BrowserNotificationTracker();
    tracker.acceptSnapshot(snapshot([thread("running", 10)]));

    tracker.acceptSnapshot(snapshot([thread("needsAttention", 20)]));

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.title).toBe("Codex ждёт решения");
  });
});

describe("browser notification permission", () => {
  it("requests permission in a supported browser", async () => {
    MockNotification.permission = "default";
    MockNotification.requestPermission.mockResolvedValue("granted");

    expect(getBrowserNotificationPermission()).toBe("default");
    await expect(requestBrowserNotificationPermission()).resolves.toBe("granted");
    expect(MockNotification.requestPermission).toHaveBeenCalledOnce();
  });

  it("allows HTTP when the browser exposes the notification API", async () => {
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
    MockNotification.permission = "default";
    MockNotification.requestPermission.mockResolvedValue("granted");

    expect(getBrowserNotificationPermission()).toBe("default");
    await expect(requestBrowserNotificationPermission()).resolves.toBe("granted");
  });

  it("reports unsupported when the browser does not expose the notification API", () => {
    vi.stubGlobal("Notification", undefined);

    expect(getBrowserNotificationPermission()).toBe("unsupported");
  });
});

function thread(state: ThreadSummary["state"], updatedAt: number): ThreadSummary {
  return {
    id: "thread",
    relation: { kind: "session", sessionId: "session" },
    projectId: "project",
    title: "Тестовая задача",
    preview: "",
    cwd: "/work/project",
    state,
    unread: false,
    unseen: false,
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt,
    currentTurnId: state === "running" ? "turn" : null,
    queuedMessageCount: 0,
    browserStatus: "disabled",
    settings: { collaborationMode: "default" },
  };
}

function childThread(state: ThreadSummary["state"], updatedAt: number): ThreadSummary {
  return {
    ...thread(state, updatedAt),
    id: "child",
    relation: {
      kind: "subagent",
      sessionId: "child-session",
      parentThreadId: "thread",
      nickname: null,
      role: null,
    },
  };
}

function attentionRequest(createdAt: number, threadId: string | null = "thread"): AttentionRequest {
  return {
    id: `attention-${createdAt}`,
    threadId,
    turnId: "turn",
    itemId: "item",
    createdAt,
    kind: "unsupported",
    method: "test",
    message: "test",
  };
}

function snapshot(
  threads: ThreadSummary[],
  attention: AttentionRequest[] = [],
  uiLanguage: AppSnapshot["uiLanguage"] = "ru",
): AppSnapshot {
  return {
    sequence: 1,
    uiLanguage,
    connection: { state: "ready", message: null, syncedAt: null },
    projects: [],
    threads,
    attention,
    models: [],
  };
}
