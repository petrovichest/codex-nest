import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { StateStore } from "./state/store";
import {
  isMissingThreadError,
  isThreadNotLoadedError,
  isThreadResumeRequiredError,
  removeThreadState,
} from "./thread-state";
import { RpcError } from "./codex/transport";

const directories: string[] = [];

afterEach(async () =>
  Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  ),
);

describe("isThreadResumeRequiredError", () => {
  it.each(["thread not loaded", "thread not found: thread"])(
    "allows recovery after %s",
    (message) => {
      expect(isThreadResumeRequiredError(new RpcError(-32600, message), "thread")).toBe(true);
    },
  );

  it.each([
    new RpcError(-32600, "no rollout found for thread id thread"),
    new RpcError(-32600, "thread not found: another-thread"),
    new RpcError(-32600, "file not found: thread"),
    new RpcError(-32603, "thread not found: thread"),
    new Error("thread not found: thread"),
  ])("does not resume for an unrelated or ambiguous failure: %s", (error) => {
    expect(isThreadResumeRequiredError(error, "thread")).toBe(false);
  });
});

describe("removeThreadState", () => {
  it("distinguishes an unloaded thread from missing durable history", () => {
    const unloaded = new RpcError(-32600, "thread not loaded");
    const missing = new RpcError(-32600, "no rollout found for thread id thread");
    expect(isThreadNotLoadedError(unloaded)).toBe(true);
    expect(isMissingThreadError(unloaded)).toBe(false);
    expect(isThreadNotLoadedError(missing)).toBe(false);
    expect(isMissingThreadError(missing)).toBe(true);
    expect(
      isMissingThreadError(
        new RpcError(
          -32600,
          "invalid paginated history lineage for thread: missing source rollout",
        ),
      ),
    ).toBe(true);
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
    await store.update((state) => {
      delete state.threadMeta.thread!.draft;
      state.voiceTranscriptions = {
        "question:clip": {
          id: "clip",
          threadId: "thread",
          mode: "draft",
          status: "queued",
          userInput: { draftKey: "a".repeat(64), questionId: "question", order: 1 },
          createdAt: 1,
          startedAt: null,
          audioDurationMs: 1000,
          estimatedTotalSeconds: null,
          error: null,
          contentType: "audio/webm",
          audioFile: "clip.webm",
          audioBytes: 5,
          selectionStart: 0,
          selectionEnd: 0,
        },
      };
    });
    await expect(removeThreadState(store, "thread", true)).resolves.toBe(false);
    expect(store.snapshot().voiceTranscriptions?.["question:clip"]).toBeDefined();
    await expect(removeThreadState(store, "thread")).resolves.toBe(true);
    expect(store.snapshot().voiceTranscriptions).toEqual({});
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
