import { randomUUID } from "node:crypto";

import type { QueuedMessage } from "@codexnest/protocol";

import type { StateStore } from "./state/store";

export interface MessageQueueDelivery {
  paused(): boolean;
  currentTurnId(threadId: string): string | null;
  start(threadId: string, message: QueuedMessage): Promise<string>;
  steer(threadId: string, turnId: string, message: QueuedMessage): Promise<string>;
  wasDelivered(threadId: string, messageId: string): Promise<boolean>;
  publish(threadId: string, messages: QueuedMessage[]): void;
}

export class MessageQueueNotFoundError extends Error {}
export class MessageQueuePausedError extends Error {}

export class MessageQueue {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: StateStore,
    private readonly delivery: MessageQueueDelivery,
  ) {}

  list(threadId: string): QueuedMessage[] {
    return this.store.snapshot().messageQueues?.[threadId] ?? [];
  }

  count(threadId: string): number {
    return this.list(threadId).length;
  }

  async enqueue(
    threadId: string,
    text: string,
    images: string[] = [],
    messageId: string = randomUUID(),
  ): Promise<QueuedMessage> {
    const message: QueuedMessage = {
      id: messageId,
      threadId,
      text: text.trim(),
      ...(images.length ? { images } : {}),
      createdAt: Date.now(),
      status: "queued",
    };
    let stored = message;
    await this.store.update((state) => {
      state.messageQueues ??= {};
      const queue = (state.messageQueues[threadId] ??= []);
      const existing = queue.find((candidate) => candidate.id === messageId);
      if (existing) {
        stored = existing;
        return;
      }
      queue.push(message);
    });
    this.publish(threadId);
    void this.drain(threadId).catch(() => undefined);
    return stored;
  }

  sendNow(threadId: string, messageId: string): Promise<string> {
    return this.withLock(threadId, async () => {
      if (this.delivery.paused())
        throw new MessageQueuePausedError("Codex maintenance is in progress");
      const message = this.list(threadId).find((candidate) => candidate.id === messageId);
      if (!message) throw new MessageQueueNotFoundError("Queued message not found");
      return this.dispatch(threadId, message, true);
    });
  }

  drain(threadId: string): Promise<void> {
    return this.withLock(threadId, async () => {
      if (this.delivery.paused()) return;
      if (this.delivery.currentTurnId(threadId)) return;
      const message = this.list(threadId)[0];
      if (!message || message.status !== "queued") return;
      await this.dispatch(threadId, message, false);
    });
  }

  async recover(): Promise<void> {
    const queues = this.store.snapshot().messageQueues ?? {};
    for (const [threadId, messages] of Object.entries(queues)) {
      await this.withLock(threadId, async () => {
        for (const message of messages.filter((candidate) => candidate.status === "dispatching")) {
          const delivered = await this.delivery.wasDelivered(threadId, message.id);
          await this.store.update((state) => {
            const queue = state.messageQueues?.[threadId] ?? [];
            state.messageQueues![threadId] = delivered
              ? queue.filter((candidate) => candidate.id !== message.id)
              : queue.map((candidate) =>
                  candidate.id === message.id ? { ...candidate, status: "queued" } : candidate,
                );
            if (!state.messageQueues![threadId].length) delete state.messageQueues![threadId];
          });
        }
        this.publish(threadId);
      });
      await this.drain(threadId).catch(() => undefined);
    }
  }

  async resume(): Promise<void> {
    const threadIds = Object.keys(this.store.snapshot().messageQueues ?? {});
    await Promise.all(threadIds.map((threadId) => this.drain(threadId).catch(() => undefined)));
  }

  async removeThread(threadId: string): Promise<void> {
    if (!this.store.snapshot().messageQueues?.[threadId]) return;
    await this.store.update((state) => {
      if (state.messageQueues) delete state.messageQueues[threadId];
    });
    this.publish(threadId);
  }

  private async dispatch(
    threadId: string,
    message: QueuedMessage,
    allowSteer: boolean,
  ): Promise<string> {
    const activeTurnId = this.delivery.currentTurnId(threadId);
    if (activeTurnId && !allowSteer) return activeTurnId;
    await this.setStatus(threadId, message.id, "dispatching");
    try {
      const turnId = activeTurnId
        ? await this.delivery.steer(threadId, activeTurnId, message)
        : await this.delivery.start(threadId, message);
      await this.remove(threadId, message.id);
      return turnId;
    } catch (error) {
      await this.setStatus(threadId, message.id, "queued").catch(() => undefined);
      throw error;
    }
  }

  private async setStatus(
    threadId: string,
    messageId: string,
    status: QueuedMessage["status"],
  ): Promise<void> {
    await this.store.update((state) => {
      const queue = state.messageQueues?.[threadId];
      if (!queue?.some((message) => message.id === messageId)) {
        throw new MessageQueueNotFoundError("Queued message not found");
      }
      state.messageQueues![threadId] = queue.map((message) =>
        message.id === messageId ? { ...message, status } : message,
      );
    });
    this.publish(threadId);
  }

  private async remove(threadId: string, messageId: string): Promise<void> {
    await this.store.update((state) => {
      const queue = state.messageQueues?.[threadId] ?? [];
      state.messageQueues![threadId] = queue.filter((message) => message.id !== messageId);
      if (!state.messageQueues![threadId].length) delete state.messageQueues![threadId];
    });
    this.publish(threadId);
  }

  private publish(threadId: string): void {
    this.delivery.publish(threadId, this.list(threadId));
  }

  private withLock<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(threadId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.locks.set(threadId, next);
    const cleanup = () => {
      if (this.locks.get(threadId) === next) this.locks.delete(threadId);
    };
    void next.then(cleanup, cleanup);
    return next;
  }
}
