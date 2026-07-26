import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ enabled: true }));
const plugin = vi.hoisted(() => ({
  acknowledgeThread: vi.fn(),
  addListener: vi.fn(),
  checkPermissions: vi.fn(),
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

import { acknowledgePendingThread, usePushNotifications } from "./push";

describe("native push navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    native.enabled = true;
    plugin.acknowledgeThread.mockResolvedValue(undefined);
    plugin.addListener.mockResolvedValue({ remove: vi.fn().mockResolvedValue(undefined) });
    plugin.checkPermissions.mockResolvedValue({ receive: "granted" });
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
  });
});
