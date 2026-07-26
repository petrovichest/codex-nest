import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { QueuedMessage } from "@codexnest/protocol";

import { MessageQueue } from "./message-queue";
import { StateStore } from "./state/store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("MessageQueue", () => {
  it("persists FIFO messages and starts one after the active turn completes", async () => {
    const { queue, delivery, setCurrentTurn } = await setup("active");
    const first = await queue.enqueue("thread", "Первое");
    const second = await queue.enqueue("thread", "Второе");

    expect(queue.list("thread").map((message) => message.text)).toEqual(["Первое", "Второе"]);
    expect(delivery.start).not.toHaveBeenCalled();

    setCurrentTurn(null);
    await queue.drain("thread");

    expect(delivery.start).toHaveBeenCalledWith("thread", first);
    expect(queue.list("thread")).toEqual([second]);
  });

  it("steers a selected queued message immediately and serializes duplicate requests", async () => {
    const { queue, delivery } = await setup("active");
    const message = await queue.enqueue("thread", "Сейчас");

    const [sent, duplicate] = await Promise.allSettled([
      queue.sendNow("thread", message.id),
      queue.sendNow("thread", message.id),
    ]);

    expect(sent).toMatchObject({ status: "fulfilled", value: "steered" });
    expect(duplicate.status).toBe("rejected");
    expect(delivery.steer).toHaveBeenCalledOnce();
    expect(queue.list("thread")).toEqual([]);
  });

  it("returns a failed delivery to queued state", async () => {
    const { queue, delivery } = await setup("active");
    delivery.steer.mockRejectedValueOnce(new Error("offline"));
    const message = await queue.enqueue("thread", "Не потерять");

    await expect(queue.sendNow("thread", message.id)).rejects.toThrow("offline");
    expect(queue.list("thread")).toEqual([{ ...message, status: "queued" }]);
  });

  it("persists image-only messages without changing queue delivery", async () => {
    const { queue, delivery } = await setup("active");
    const image = "data:image/png;base64,aW1hZ2U=";
    const message = await queue.enqueue("thread", "", [image]);

    expect(queue.list("thread")).toEqual([expect.objectContaining({ text: "", images: [image] })]);
    await queue.sendNow("thread", message.id);
    expect(delivery.steer).toHaveBeenCalledWith("thread", "active", message);
  });

  it("deduplicates retries with the same client message id", async () => {
    const { queue } = await setup("active");

    const first = await queue.enqueue("thread", "Один раз", [], "client-message");
    const retry = await queue.enqueue("thread", "Один раз", [], "client-message");

    expect(retry).toEqual(first);
    expect(queue.list("thread")).toEqual([first]);
  });

  it("deduplicates a retry after the original message was delivered", async () => {
    const { queue, delivery, store } = await setup(null);

    await queue.enqueue("thread", "Один раз", [], "client-message");
    await vi.waitFor(() =>
      expect(store.snapshot().messageReceipts?.["client-message"]).toBeDefined(),
    );
    const retry = await queue.enqueue("thread", "Один раз", [], "client-message");

    expect(retry).toMatchObject({ id: "client-message", status: "dispatching" });
    expect(delivery.start).toHaveBeenCalledOnce();
    expect(queue.list("thread")).toEqual([]);
    await expect(queue.enqueue("thread", "Другой текст", [], "client-message")).rejects.toThrow(
      "Message id has already been used",
    );
  });

  it("atomically converts a completed voice job into a goal message", async () => {
    const { queue, store } = await setup("active");
    await store.update((state) => {
      state.threadMeta.thread = {
        pinned: false,
        lastReadUpdatedAt: 0,
        draft: {
          input: "Черновик",
          images: [],
          goalMode: true,
          annotations: [],
          updatedAt: 1,
        },
      };
      state.voiceTranscriptions = {
        thread: {
          id: "voice",
          threadId: "thread",
          mode: "send",
          status: "applying",
          createdAt: 1,
          startedAt: 2,
          audioDurationMs: 1_000,
          estimatedTotalSeconds: null,
          error: null,
          contentType: "audio/webm",
          audioFile: "voice.webm",
          audioBytes: 5,
          selectionStart: 0,
          selectionEnd: 0,
          transcript: "Текст",
        },
      };
    });

    const message = await queue.enqueue("thread", "Голос", [], "voice", {
      goal: true,
      completeVoiceTranscriptionId: "voice",
    });

    expect(message.goal).toBe(true);
    expect(store.snapshot().threadMeta.thread?.draft).toBeUndefined();
    expect(store.snapshot().voiceTranscriptions?.thread).toBeUndefined();
  });

  it("updates queued text without changing its metadata or images", async () => {
    const { queue, delivery } = await setup("active");
    const image = "data:image/png;base64,aW1hZ2U=";
    const first = await queue.enqueue("thread", "Старый текст", [image]);
    const second = await queue.enqueue("thread", "Следом");

    const updated = await queue.update("thread", first.id, "  Новый текст  ");

    expect(updated).toEqual({ ...first, text: "Новый текст" });
    expect(queue.list("thread")).toEqual([updated, second]);
    expect(delivery.publish).toHaveBeenLastCalledWith("thread", [updated, second]);
  });

  it("cancels a queued message without affecting the remaining order", async () => {
    const { queue, delivery } = await setup("active");
    const first = await queue.enqueue("thread", "Первое");
    const second = await queue.enqueue("thread", "Второе");

    await queue.cancel("thread", first.id);

    expect(queue.list("thread")).toEqual([second]);
    expect(delivery.publish).toHaveBeenLastCalledWith("thread", [second]);
  });

  it("rejects invalid, missing, and dispatching queue mutations", async () => {
    const { queue, store } = await setup("active");
    const message = await queue.enqueue("thread", "Сообщение");

    await expect(queue.update("thread", message.id, " ")).rejects.toThrow(
      "Queued message text must not be empty",
    );
    await expect(queue.cancel("thread", "missing")).rejects.toThrow("Queued message not found");

    await store.update((state) => {
      state.messageQueues!.thread = [{ ...message, status: "dispatching" }];
    });
    await expect(queue.update("thread", message.id, "Правка")).rejects.toThrow(
      "Queued message is already being sent",
    );
    await expect(queue.cancel("thread", message.id)).rejects.toThrow(
      "Queued message is already being sent",
    );
  });

  it("reconciles dispatching messages after a restart", async () => {
    const { queue, store, delivery } = await setup("active");
    const delivered = queued("delivered", "Доставлено", "dispatching");
    const pending = queued("pending", "Повторить", "dispatching");
    await store.update((state) => {
      state.messageQueues = { thread: [delivered, pending] };
    });
    delivery.wasDelivered.mockImplementation(async (_threadId, messageId) => {
      return messageId === delivered.id;
    });

    await queue.recover();

    expect(queue.list("thread")).toEqual([{ ...pending, status: "queued" }]);
  });

  it("keeps messages queued while delivery is paused and resumes afterwards", async () => {
    const { queue, delivery, setPaused } = await setup(null);
    setPaused(true);

    const message = await queue.enqueue("thread", "После обслуживания");
    await queue.drain("thread");

    expect(delivery.start).not.toHaveBeenCalled();
    expect(queue.list("thread")).toEqual([message]);

    setPaused(false);
    await queue.resume();
    expect(delivery.start).toHaveBeenCalledWith("thread", message);
    expect(queue.list("thread")).toEqual([]);
  });
});

async function setup(initialTurn: string | null) {
  const directory = await mkdtemp(join(tmpdir(), "codexnest-message-queue-test-"));
  directories.push(directory);
  const store = new StateStore(join(directory, "state.json"));
  await store.load();
  let currentTurn = initialTurn;
  let paused = false;
  const delivery = {
    paused: vi.fn(() => paused),
    currentTurnId: vi.fn(() => currentTurn),
    start: vi.fn(async () => {
      currentTurn = "started";
      return "started";
    }),
    steer: vi.fn(async () => {
      currentTurn = "steered";
      return "steered";
    }),
    wasDelivered: vi.fn(async () => false),
    publish: vi.fn(),
  };
  return {
    queue: new MessageQueue(store, delivery),
    store,
    delivery,
    setCurrentTurn(value: string | null) {
      currentTurn = value;
    },
    setPaused(value: boolean) {
      paused = value;
    },
  };
}

function queued(id: string, text: string, status: QueuedMessage["status"]): QueuedMessage {
  return { id, threadId: "thread", text, createdAt: 1, status };
}
