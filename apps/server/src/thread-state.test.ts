import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { StateStore } from "./state/store";
import { isMissingThreadError, isThreadNotLoadedError, removeThreadState } from "./thread-state";
import { RpcError } from "./codex/transport";

const directories: string[] = [];

afterEach(async () =>
  Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  ),
);

describe("removeThreadState", () => {
  it("distinguishes an unloaded thread from missing durable history", () => {
    const unloaded = new RpcError(-32600, "thread not loaded");
    const missing = new RpcError(-32600, "no rollout found for thread id thread");
    expect(isThreadNotLoadedError(unloaded)).toBe(true);
    expect(isMissingThreadError(unloaded)).toBe(false);
    expect(isThreadNotLoadedError(missing)).toBe(false);
    expect(isMissingThreadError(missing)).toBe(true);
  });

  it("protects queued messages and drafts from automatic cleanup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-thread-state-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.threadMeta.thread = { pinned: false, lastReadUpdatedAt: 0 };
      state.messageQueues = {
        thread: [
          {
            id: "message",
            threadId: "thread",
            text: "Keep me",
            createdAt: 1,
            status: "dispatching",
          },
        ],
      };
    });
    await expect(removeThreadState(store, "thread", true)).resolves.toBe(false);
    expect(store.snapshot().messageQueues?.thread).toHaveLength(1);
    await store.update((state) => {
      delete state.messageQueues?.thread;
      state.threadMeta.thread!.draft = {
        input: "Draft",
        images: [],
        goalMode: false,
        annotations: [],
        updatedAt: 1,
      };
    });
    await expect(removeThreadState(store, "thread", true)).resolves.toBe(false);
    expect(store.snapshot().threadMeta.thread?.draft?.input).toBe("Draft");
  });

  it("removes stale managed-team references along with a deleted session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-thread-state-test-"));
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
              title: "Old task",
              prompt: "Complete it",
              status: "completed",
              createdAt: 1,
              lastActivityAt: 2,
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

    await removeThreadState(store, "child");

    expect(store.snapshot().threadMeta.child).toBeUndefined();
    expect(store.snapshot().threadMeta.parent?.teamOrchestration).toBeUndefined();
  });

  it("detaches surviving children when their parent session is deleted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-thread-state-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.threadMeta.parent = { pinned: false, lastReadUpdatedAt: 0 };
      state.threadMeta.child = {
        pinned: false,
        lastReadUpdatedAt: 0,
        managedParent: { parentThreadId: "parent", taskId: "task" },
      };
    });

    await removeThreadState(store, "parent");

    expect(store.snapshot().threadMeta.parent).toBeUndefined();
    expect(store.snapshot().threadMeta.child?.managedParent).toBeUndefined();
  });
});
