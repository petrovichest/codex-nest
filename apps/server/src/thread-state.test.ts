import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { StateStore } from "./state/store";
import { removeThreadState } from "./thread-state";

const directories: string[] = [];

afterEach(async () =>
  Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  ),
);

describe("removeThreadState", () => {
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
