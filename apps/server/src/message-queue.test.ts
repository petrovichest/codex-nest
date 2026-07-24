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

  it("rejects an immediate send with the reason supplied by the delivery hook", async () => {
    const { queue, setPaused } = await setup("active");
    setPaused(true);
    const message = await queue.enqueue("thread", "После обслуживания");
    await expect(queue.sendNow("thread", message.id)).rejects.toThrow(
      "Codex maintenance is in progress",
    );
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
    pauseReason: vi.fn(() => (paused ? "Codex maintenance is in progress" : null)),
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
