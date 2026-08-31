import { createHash, randomUUID } from "node:crypto";

import type { QueuedMessage, ThreadFileAttachment } from "@codexnest/protocol";

import type { StateStore } from "./state/store";
import { isMissingThreadError, removeThreadState } from "./thread-state";

export interface MessageQueueDelivery {
  paused(): boolean;
  currentTurnId(threadId: string): string | null;
  shouldSteerQueuedMessage(threadId: string, turnId: string): boolean;
  start(threadId: string, message: QueuedMessage): Promise<string>;
  steer(threadId: string, turnId: string, message: QueuedMessage): Promise<string>;
  deliveredTurnId(threadId: string, messageId: string): Promise<string | null>;
  publish(threadId: string, messages: QueuedMessage[]): void;
}

export class MessageQueueNotFoundError extends Error {}
export class MessageQueuePausedError extends Error {}
export class MessageQueueConflictError extends Error {}
export class MessageQueueValidationError extends Error {}

export class MessageQueue {
  private readonly locks = new Map<string, Promise<unknown>>();
  private suspended = false;

  constructor(
    private readonly store: StateStore,
    private readonly delivery: MessageQueueDelivery,
    private readonly options: {
      onMissingThreadCleanup?: (threadId: string) => Promise<void> | void;
    } = {},
  ) {}

  list(threadId: string): QueuedMessage[] {
    return structuredClone(this.store.view().messageQueues?.[threadId] ?? []) as QueuedMessage[];
  }

  count(threadId: string): number {
    return this.list(threadId).length;
  }

  async enqueue(
    threadId: string,
    text: string,
    images: string[] = [],
    messageId: string = randomUUID(),
    options: {
      goal?: boolean;
      files?: ThreadFileAttachment[];
      completeVoiceTranscriptionId?: string;
    } = {},
  ): Promise<QueuedMessage> {
    const message: QueuedMessage = {
      id: messageId,
      threadId,
      text: text.trim(),
      ...(images.length ? { images } : {}),
      ...(options.files?.length ? { files: options.files } : {}),
      ...(options.goal ? { goal: true } : {}),
      createdAt: Date.now(),
      status: "queued",
    };
    const contentHash = messageContentHash(
      message.text,
      message.images ?? [],
      message.files ?? [],
      !!message.goal,
    );
    let stored = message;
    await this.store.update((state) => {
      const receipt = state.messageReceipts?.[messageId];
      if (receipt) {
        if (receipt.threadId !== threadId || receipt.contentHash !== contentHash) {
          throw new MessageQueueConflictError("Message id has already been used");
        }
        stored = { ...message, status: "dispatching" };
        const queue = state.messageQueues?.[threadId];
        if (queue?.some((candidate) => candidate.id === messageId)) {
          state.messageQueues![threadId] = queue.filter((candidate) => candidate.id !== messageId);
          if (!state.messageQueues![threadId].length) delete state.messageQueues![threadId];
        }
        const meta = state.threadMeta[threadId];
        if (meta) delete meta.draft;
        if (
          options.completeVoiceTranscriptionId &&
          state.voiceTranscriptions?.[threadId]?.id === options.completeVoiceTranscriptionId
        ) {
          delete state.voiceTranscriptions[threadId];
        }
        return;
      }
      state.messageQueues ??= {};
      const queue = (state.messageQueues[threadId] ??= []);
      const existing = queue.find((candidate) => candidate.id === messageId);
      if (existing) {
        stored = existing;
        const meta = state.threadMeta[threadId];
        if (meta) delete meta.draft;
        if (
          options.completeVoiceTranscriptionId &&
          state.voiceTranscriptions?.[threadId]?.id === options.completeVoiceTranscriptionId
        ) {
          delete state.voiceTranscriptions[threadId];
        }
        return;
      }
      queue.push(message);
      const meta = state.threadMeta[threadId];
      if (meta) delete meta.draft;
      if (
        options.completeVoiceTranscriptionId &&
        state.voiceTranscriptions?.[threadId]?.id === options.completeVoiceTranscriptionId
      ) {
        delete state.voiceTranscriptions[threadId];
      }
    });
    this.publish(threadId);
    const activeTurnId = this.delivery.currentTurnId(threadId);
    if (activeTurnId && this.delivery.shouldSteerQueuedMessage(threadId, activeTurnId)) {
      void this.sendNow(threadId, stored.id).catch(() => undefined);
    } else {
      void this.drain(threadId).catch(() => undefined);
    }
    return stored;
  }

  sendNow(threadId: string, messageId: string): Promise<string> {
    return this.withLock(threadId, async () => {
      if (this.delivery.paused())
        throw new MessageQueuePausedError("Codex maintenance is in progress");
      const message = this.list(threadId).find((candidate) => candidate.id === messageId);
      if (!message) {
        const receipt = this.store.view().messageReceipts?.[messageId];
        if (receipt?.threadId === threadId && receipt.turnId) return receipt.turnId;
        throw new MessageQueueNotFoundError("Queued message not found");
      }
      return this.dispatch(threadId, message, true);
    });
  }

  update(threadId: string, messageId: string, text: string): Promise<QueuedMessage> {
    return this.withLock(threadId, async () => {
      const current = this.list(threadId).find((candidate) => candidate.id === messageId);
      if (!current) throw new MessageQueueNotFoundError("Queued message not found");
      if (current.status !== "queued") {
        throw new MessageQueueConflictError("Queued message is already being sent");
      }
      const trimmed = text.trim();
      if (!trimmed && !current.images?.length && !current.files?.length) {
        throw new MessageQueueValidationError("Queued message text must not be empty");
      }
      const updated = { ...current, text: trimmed };
      await this.store.update((state) => {
        const messages = state.messageQueues?.[threadId];
        if (!messages?.some((message) => message.id === messageId)) {
          throw new MessageQueueNotFoundError("Queued message not found");
        }
        state.messageQueues![threadId] = messages.map((message) =>
          message.id === messageId ? updated : message,
        );
      });
      this.publish(threadId);
      return updated;
    });
  }

  cancel(threadId: string, messageId: string): Promise<void> {
    return this.withLock(threadId, async () => {
      const current = this.list(threadId).find((candidate) => candidate.id === messageId);
      if (!current) throw new MessageQueueNotFoundError("Queued message not found");
      if (current.status !== "queued") {
        throw new MessageQueueConflictError("Queued message is already being sent");
      }
      await this.remove(threadId, messageId);
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
    const queues = this.store.view().messageQueues ?? {};
    for (const [threadId, messages] of Object.entries(queues)) {
      const orphaned = await this.withLock(threadId, async () => {
        for (const message of messages.filter((candidate) => candidate.status === "dispatching")) {
          let deliveredTurnId: string | null;
          try {
            deliveredTurnId = await this.delivery.deliveredTurnId(threadId, message.id);
          } catch (error) {
            if (!isMissingThreadError(error)) throw error;
            await this.cleanupMissingThread(threadId);
            return true;
          }
          await this.store.update((state) => {
            const queue = state.messageQueues?.[threadId] ?? [];
            state.messageQueues![threadId] = deliveredTurnId
              ? queue.filter((candidate) => candidate.id !== message.id)
              : queue.map((candidate) =>
                  candidate.id === message.id ? { ...candidate, status: "queued" } : candidate,
                );
            if (!state.messageQueues![threadId].length) delete state.messageQueues![threadId];
            if (deliveredTurnId) {
              state.messageReceipts ??= {};
              state.messageReceipts[message.id] = {
                threadId,
                turnId: deliveredTurnId,
                contentHash: messageContentHash(
                  message.text,
                  message.images ?? [],
                  message.files ?? [],
                  !!message.goal,
                ),
                createdAt: Date.now(),
              };
            }
          });
        }
        this.publish(threadId);
        return false;
      });
      if (orphaned) continue;
      await this.drain(threadId).catch(() => undefined);
    }
  }

  async resume(): Promise<void> {
    this.suspended = false;
    const threadIds = Object.keys(this.store.view().messageQueues ?? {});
    await Promise.all(threadIds.map((threadId) => this.drain(threadId).catch(() => undefined)));
  }

  async pause(): Promise<void> {
    this.suspended = true;
    await Promise.all([...this.locks.values()].map((pending) => pending.catch(() => undefined)));
  }

  async removeThread(threadId: string): Promise<void> {
    if (!this.store.view().messageQueues?.[threadId]) return;
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
    if (this.suspended) throw new MessageQueuePausedError("CodexNest is preparing to restart");
    const activeTurnId = this.delivery.currentTurnId(threadId);
    if (activeTurnId && !allowSteer) return activeTurnId;
    await this.setStatus(threadId, message.id, "dispatching");
    let turnId: string;
    try {
      turnId = activeTurnId
        ? await this.delivery.steer(threadId, activeTurnId, message)
        : await this.delivery.start(threadId, message);
    } catch (error) {
      if (isMissingThreadError(error)) {
        await this.cleanupMissingThread(threadId);
        throw error;
      }
      try {
        const deliveredTurnId = await this.delivery.deliveredTurnId(threadId, message.id);
        if (deliveredTurnId) {
          await this.remove(threadId, message.id, deliveredTurnId, message);
          return deliveredTurnId;
        }
      } catch (deliveryError) {
        if (isMissingThreadError(deliveryError)) {
          await this.cleanupMissingThread(threadId);
          throw error;
        }
        // Keep an ambiguous delivery parked until a later recovery can reconcile it.
        throw error;
      }
      await this.setStatus(threadId, message.id, "queued").catch(() => undefined);
      throw error;
    }
    await this.remove(threadId, message.id, turnId, message);
    return turnId;
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

  private async remove(
    threadId: string,
    messageId: string,
    deliveredTurnId?: string,
    deliveredMessage?: QueuedMessage,
  ): Promise<void> {
    await this.store.update((state) => {
      const queue = state.messageQueues?.[threadId] ?? [];
      state.messageQueues![threadId] = queue.filter((message) => message.id !== messageId);
      if (!state.messageQueues![threadId].length) delete state.messageQueues![threadId];
      if (deliveredTurnId && deliveredMessage) {
        state.messageReceipts ??= {};
        state.messageReceipts[messageId] = {
          threadId,
          turnId: deliveredTurnId,
          contentHash: messageContentHash(
            deliveredMessage.text,
            deliveredMessage.images ?? [],
            deliveredMessage.files ?? [],
            !!deliveredMessage.goal,
          ),
          createdAt: Date.now(),
        };
      }
    });
    this.publish(threadId);
  }

  private publish(threadId: string): void {
    this.delivery.publish(threadId, this.list(threadId));
  }

  private async cleanupMissingThread(threadId: string): Promise<void> {
    await Promise.resolve(this.options.onMissingThreadCleanup?.(threadId)).catch(() => undefined);
    await removeThreadState(this.store, threadId);
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

export function messageContentHash(
  text: string,
  images: readonly string[],
  files: readonly ThreadFileAttachment[],
  goal: boolean,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        files.length ? [text.trim(), images, files, goal] : [text.trim(), images, goal],
      ),
    )
    .digest("hex");
}
