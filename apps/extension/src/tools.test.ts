import { afterEach, describe, expect, it, vi } from "vitest";

import type { DebuggerController } from "./cdp";
import type { BindingSummary } from "./protocol";
import { BrowserToolDispatcher } from "./tools";

afterEach(() => vi.unstubAllGlobals());

class FakeEvent<Arguments extends unknown[]> {
  private listeners: Array<(...arguments_: Arguments) => void> = [];

  addListener(listener: (...arguments_: Arguments) => void): void {
    this.listeners.push(listener);
  }

  removeListener(listener: (...arguments_: Arguments) => void): void {
    this.listeners = this.listeners.filter((candidate) => candidate !== listener);
  }

  emit(...arguments_: Arguments): void {
    for (const listener of this.listeners) listener(...arguments_);
  }
}

describe("BrowserToolDispatcher", () => {
  it("releases debugger tabs only after their last browser session detaches", async () => {
    const debuggerController = {
      ensureAttached: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      forget: vi.fn(),
    } as unknown as DebuggerController;
    const dispatcher = new BrowserToolDispatcher(
      debuggerController,
      async () => ({}),
      async () => undefined,
      () => undefined,
      () => undefined,
    );

    await dispatcher.attachTab("thread-one", 7);
    await dispatcher.attachTab("thread-two", 7);
    await dispatcher.releaseThread("thread-one");
    expect(debuggerController.detach).not.toHaveBeenCalled();

    await dispatcher.releaseThread("thread-two");
    expect(debuggerController.detach).toHaveBeenCalledWith(7);
    await expect(dispatcher.attachTab("thread-two", 8)).rejects.toMatchObject({
      code: "session_detached",
    });

    dispatcher.activateThread("thread-two");
    await expect(dispatcher.attachTab("thread-two", 8)).resolves.toBeUndefined();
  });

  it("fails an upload when the content-script port closes before acknowledging it", async () => {
    const onMessage = new FakeEvent<[unknown]>();
    const onDisconnect = new FakeEvent<[]>();
    const port = {
      name: "codexnest.upload",
      onMessage,
      onDisconnect,
      postMessage(message: unknown) {
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "end"
        ) {
          queueMicrotask(() => onDisconnect.emit());
        }
      },
      disconnect() {
        onDisconnect.emit();
      },
    };
    vi.stubGlobal("chrome", {
      scripting: { executeScript: vi.fn(async () => []) },
      tabs: {
        get: vi.fn(async () => ({
          id: 7,
          windowId: 1,
          groupId: 2,
          index: 0,
          active: true,
        })),
        connect: vi.fn(() => port),
      },
    });
    const binding: BindingSummary = {
      threadId: "thread-1",
      projectId: "project-1",
      title: "Browser",
      groupId: 2,
      tabIds: [7],
      createdAt: 1,
      updatedAt: 1,
    };
    const debuggerController = {
      ensureAttached: vi.fn(async () => undefined),
      screenshots: {
        get: vi.fn(() => ({
          imageId: "image-1",
          data: "aGVsbG8=",
          mimeType: "image/png",
          byteLength: 5,
          createdAt: 1,
        })),
      },
    } as unknown as DebuggerController;
    const dispatcher = new BrowserToolDispatcher(
      debuggerController,
      async () => ({ [binding.threadId]: binding }),
      async () => undefined,
      () => undefined,
      () => undefined,
    );

    await expect(
      dispatcher.dispatch({
        threadId: binding.threadId,
        tool: "upload_file",
        arguments: {
          tabId: 7,
          ref: "e_upload",
          file: { kind: "captured_image", imageId: "image-1" },
        },
      }),
    ).rejects.toThrow("File injection connection closed before completion");
  });
});
