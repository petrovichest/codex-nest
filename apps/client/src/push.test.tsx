import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppSnapshot, ThreadSummary } from "@codexnest/protocol";

const native = vi.hoisted(() => ({ enabled: true }));
const plugin = vi.hoisted(() => ({
  acknowledgeThread: vi.fn(),
  addListener: vi.fn(),
  checkPermissions: vi.fn(),
  observeFrame: vi.fn(),
  releaseThread: vi.fn(),
  requestPermissions: vi.fn(),
  setLanguage: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));
const preferences = vi.hoisted(() => ({
  get: vi.fn(),
  remove: vi.fn(),
  set: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => native.enabled },
  registerPlugin: () => plugin,
}));
vi.mock("@capacitor/preferences", () => ({ Preferences: preferences }));

import {
  acknowledgePendingThread,
  observeNativeNotificationEvent,
  observeNativeNotificationSnapshot,
  releaseActiveThread,
  setNativeNotificationAppActive,
  usePushNotifications,
} from "./push";

describe("native push navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    native.enabled = true;
    setNativeNotificationAppActive(true);
    plugin.acknowledgeThread.mockResolvedValue(undefined);
    plugin.addListener.mockResolvedValue({ remove: vi.fn().mockResolvedValue(undefined) });
    plugin.checkPermissions.mockResolvedValue({ receive: "granted" });
    plugin.observeFrame.mockResolvedValue(undefined);
    plugin.releaseThread.mockResolvedValue(undefined);
    plugin.requestPermissions.mockResolvedValue({ receive: "granted" });
    plugin.setLanguage.mockResolvedValue(undefined);
    plugin.start.mockResolvedValue(undefined);
    plugin.stop.mockResolvedValue(undefined);
    preferences.get.mockResolvedValue({ value: null });
    preferences.remove.mockResolvedValue(undefined);
    preferences.set.mockResolvedValue(undefined);
  });

  it("persists a notification target before navigating to it", async () => {
    let listener: ((event: { threadId?: string }) => void) | undefined;
    let resolveStored: (() => void) | undefined;
    plugin.addListener.mockImplementation(async (_event, callback) => {
      listener = callback;
      return { remove: vi.fn().mockResolvedValue(undefined) };
    });
    preferences.set.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveStored = resolve;
        }),
    );
    const navigate = vi.fn();
    renderHook(() => usePushNotifications(navigate, "ru"));
    await waitFor(() => expect(listener).toBeDefined());

    act(() => listener?.({ threadId: "thread/id" }));
    expect(navigate).not.toHaveBeenCalled();
    act(() => resolveStored?.());

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/threads/thread%2Fid"));
  });

  it("keeps one native lifecycle across route renders and uses the latest navigate function", async () => {
    let listener: ((event: { threadId?: string }) => void) | undefined;
    const remove = vi.fn().mockResolvedValue(undefined);
    plugin.addListener.mockImplementation(async (_event, callback) => {
      listener = callback;
      return { remove };
    });
    const firstNavigate = vi.fn();
    const secondNavigate = vi.fn();
    const view = renderHook(
      ({ navigate }: { navigate: typeof firstNavigate }) => usePushNotifications(navigate, "ru"),
      { initialProps: { navigate: firstNavigate } },
    );
    await waitFor(() => expect(listener).toBeDefined());
    await waitFor(() => expect(plugin.start).toHaveBeenCalledOnce());

    view.rerender({ navigate: secondNavigate });
    act(() => listener?.({ threadId: "new-thread" }));

    await waitFor(() => expect(secondNavigate).toHaveBeenCalledWith("/threads/new-thread"));
    expect(firstNavigate).not.toHaveBeenCalled();
    expect(plugin.addListener).toHaveBeenCalledOnce();
    expect(preferences.get).toHaveBeenCalledOnce();
    expect(plugin.start).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
  });

  it("does not let delayed pending recovery override a newer manual session selection", async () => {
    let resolvePending: ((value: { value: string | null }) => void) | undefined;
    preferences.get.mockImplementationOnce(
      () =>
        new Promise<{ value: string | null }>((resolve) => {
          resolvePending = resolve;
        }),
    );
    preferences.get.mockResolvedValue({ value: "old-thread" });
    const navigate = vi.fn();
    const view = renderHook(() => usePushNotifications(navigate, "ru"));
    await waitFor(() => expect(resolvePending).toBeDefined());

    act(() => view.result.current());
    await act(async () => resolvePending?.({ value: "old-thread" }));

    expect(navigate).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(preferences.remove).toHaveBeenCalledWith({ key: "codexnest.pendingThreadId" }),
    );
  });

  it("does not let delayed notification persistence override a newer manual selection", async () => {
    let listener: ((event: { threadId?: string }) => void) | undefined;
    let resolveStored: (() => void) | undefined;
    plugin.addListener.mockImplementation(async (_event, callback) => {
      listener = callback;
      return { remove: vi.fn().mockResolvedValue(undefined) };
    });
    preferences.set.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveStored = resolve;
        }),
    );
    preferences.get
      .mockResolvedValueOnce({ value: null })
      .mockResolvedValue({ value: "notification-thread" });
    const navigate = vi.fn();
    const view = renderHook(() => usePushNotifications(navigate, "ru"));
    await waitFor(() => expect(listener).toBeDefined());

    act(() => listener?.({ threadId: "notification-thread" }));
    act(() => view.result.current());
    await act(async () => resolveStored?.());

    expect(navigate).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(preferences.remove).toHaveBeenCalledWith({ key: "codexnest.pendingThreadId" }),
    );
  });

  it("removes a native listener that finishes registering after unmount", async () => {
    let resolveListener: ((handle: { remove(): Promise<void> }) => void) | undefined;
    const remove = vi.fn().mockResolvedValue(undefined);
    plugin.addListener.mockImplementation(
      () =>
        new Promise<{ remove(): Promise<void> }>((resolve) => {
          resolveListener = resolve;
        }),
    );
    const view = renderHook(() => usePushNotifications(vi.fn(), "ru"));
    await waitFor(() => expect(resolveListener).toBeDefined());

    view.unmount();
    await act(async () => resolveListener?.({ remove }));

    await waitFor(() => expect(remove).toHaveBeenCalledOnce());
  });

  it("reopens a pending target and clears only its matching acknowledgement", async () => {
    preferences.get.mockResolvedValue({ value: "pending-thread" });
    const navigate = vi.fn();
    renderHook(() => usePushNotifications(navigate, "ru"));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/threads/pending-thread"));
    await acknowledgePendingThread("pending-thread");

    expect(plugin.acknowledgeThread).toHaveBeenCalledWith({
      threadId: "pending-thread",
    });
    expect(preferences.remove).toHaveBeenCalledWith({
      key: "codexnest.pendingThreadId",
    });

    await releaseActiveThread("pending-thread");
    expect(plugin.releaseThread).toHaveBeenCalledWith({ threadId: "pending-thread" });
  });

  it("seeds the native tracker with the current snapshot after the service starts", async () => {
    const snapshot = notificationSnapshot();

    renderHook(() => usePushNotifications(vi.fn(), "ru", snapshot));

    await waitFor(() => expect(plugin.start).toHaveBeenCalledOnce());
    expect(plugin.observeFrame).toHaveBeenCalledOnce();
    expect(JSON.parse(plugin.observeFrame.mock.calls[0]![0].frame)).toEqual({
      type: "snapshot",
      snapshot,
    });
  });

  it("forwards only notification-relevant frames on the native platform", () => {
    const snapshot = notificationSnapshot();
    observeNativeNotificationSnapshot(snapshot);
    observeNativeNotificationEvent(2, { type: "thread.upserted", thread: snapshot.threads[0]! });
    observeNativeNotificationEvent(3, {
      type: "queue.changed",
      threadId: "thread",
      messages: [],
    });

    expect(plugin.observeFrame).toHaveBeenCalledTimes(2);
    expect(JSON.parse(plugin.observeFrame.mock.calls[0]![0].frame)).toEqual({
      type: "snapshot",
      snapshot,
    });
    expect(JSON.parse(plugin.observeFrame.mock.calls[1]![0].frame)).toEqual({
      type: "event",
      sequence: 2,
      event: { type: "thread.upserted", thread: snapshot.threads[0] },
    });
  });

  it("does not forward notification frames while the native app is in the background", () => {
    setNativeNotificationAppActive(false);

    observeNativeNotificationSnapshot(notificationSnapshot());
    observeNativeNotificationEvent(2, {
      type: "thread.upserted",
      thread: notificationSnapshot().threads[0]!,
    });

    expect(plugin.observeFrame).not.toHaveBeenCalled();
  });

  it("does not forward notification frames in the browser", () => {
    native.enabled = false;

    observeNativeNotificationSnapshot(notificationSnapshot());
    observeNativeNotificationEvent(2, {
      type: "attention.removed",
      attentionId: "attention",
    });

    expect(plugin.observeFrame).not.toHaveBeenCalled();
  });
});

function notificationSnapshot(): AppSnapshot {
  const thread: ThreadSummary = {
    id: "thread",
    relation: { kind: "session", sessionId: "session" },
    projectId: null,
    title: "Task",
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
  return {
    sequence: 1,
    uiLanguage: "ru",
    connection: { state: "ready", message: null, syncedAt: null },
    projects: [],
    threads: [thread],
    attention: [],
    models: [],
  };
}
