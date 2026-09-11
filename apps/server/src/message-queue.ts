import { createHash, randomUUID } from "node:crypto";

import type { QueuedMessage, ThreadFileAttachment } from "@codexnest/protocol";

import type { StateStore } from "./state/store";
import { RpcError } from "./codex/transport";
import { isMissingThreadError, isThreadNotLoadedError } from "./thread-state";

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
  private readonly retries = new Map<string, { attempt: number; timer?: NodeJS.Timeout }>();
  private suspended = false;

  constructor(
    private readonly store: StateStore,
    private readonly delivery: MessageQueueDelivery,
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
        // This is only an acknowledgement replay. The draft may already belong
        // to the user's next message, so do not clear it again.
        if (
          options.completeVoiceTranscriptionId &&
          state.voiceTranscriptions?.[threadId]?.id === options.completeVoiceTranscriptionId
        ) {
          delete state.voiceTranscriptions[threadId];
        }
        return;
      }
      if (!state.threadMeta[threadId]) {
        throw new MessageQueueNotFoundError("Thread not found");
      }
      state.messageQueues ??= {};
      const queue = (state.messageQueues[threadId] ??= []);
      const existing = queue.find((candidate) => candidate.id === messageId);
      if (existing) {
        if (
          messageContentHash(
            existing.text,
            existing.images ?? [],
            existing.files ?? [],
            !!existing.goal,
          ) !== contentHash
        ) {
          throw new MessageQueueConflictError("Message id has already been used");
        }
        stored = existing;
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
      if (message.status === "dispatching") {
        if (!(await this.reconcile(threadId, message))) {
          throw new MessageQueueConflictError("Delivery is still being confirmed");
        }
        const receipt = this.store.view().messageReceipts?.[messageId];
        if (receipt?.turnId) return receipt.turnId;
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
      if (!message || message.status !== "queued" || message.deliveryError?.retryable === false)
        return;
      if (this.retries.get(threadId)?.timer) return;
      await this.dispatch(threadId, message, false);
    });
  }

  async recover(): Promise<void> {
    await Promise.all(
      Object.keys(this.store.view().messageQueues ?? {}).map((id) => this.recoverThread(id)),
    );
  }

  private async recoverThread(threadId: string): Promise<void> {
    await this.withLock(threadId, async () => {
      for (const message of this.list(threadId)) {
        if (message.status !== "dispatching" || message.deliveryError?.retryable === false)
          continue;
        if (!(await this.reconcile(threadId, message))) break;
      }
    });
    await this.drain(threadId).catch(() => undefined);
  }

  private async reconcile(threadId: string, message: QueuedMessage): Promise<boolean> {
    try {
      const receipt = this.store.view().messageReceipts?.[message.id];
      const turnId = receipt?.turnId ?? (await this.delivery.deliveredTurnId(threadId, message.id));
      if (turnId) await this.remove(threadId, message.id, turnId, message);
      else await this.setStatus(threadId, message.id, "queued");
      return true;
    } catch (error) {
      await this.recordFailure(threadId, message.id, "dispatching", error);
      return false;
    }
  }

  async resume(): Promise<void> {
    this.suspended = false;
    const threadIds = Object.keys(this.store.view().messageQueues ?? {});
    await Promise.all(
      threadIds.map(async (threadId) => {
        if (
          this.list(threadId).some(
            (message) =>
              message.status === "dispatching" && message.deliveryError?.retryable !== false,
          )
        ) {
          this.scheduleRetry(threadId);
        } else {
          await this.drain(threadId).catch(() => undefined);
        }
      }),
    );
  }

  async pause(): Promise<void> {
    this.suspended = true;
    for (const retry of this.retries.values()) {
      if (retry.timer) clearTimeout(retry.timer);
      retry.timer = undefined;
    }
    await Promise.all([...this.locks.values()].map((pending) => pending.catch(() => undefined)));
  }

  async removeThread(threadId: string): Promise<void> {
    this.clearRetry(threadId);
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
      if (isMissingThreadError(error) || isThreadNotLoadedError(error)) {
        await this.recordFailure(threadId, message.id, "queued", error);
        throw error;
      }
      try {
        const deliveredTurnId = await this.delivery.deliveredTurnId(threadId, message.id);
        if (deliveredTurnId) {
          await this.remove(threadId, message.id, deliveredTurnId, message);
          return deliveredTurnId;
        }
      } catch (deliveryError) {
        // Keep an ambiguous delivery parked until a later recovery can reconcile it.
        await this.recordFailure(threadId, message.id, "dispatching", deliveryError);
        throw error;
      }
      await this.recordFailure(threadId, message.id, "queued", error);
      throw error;
    }
    await this.remove(threadId, message.id, turnId, message);
    return turnId;
  }

  private async setStatus(
    threadId: string,
    messageId: string,
    status: QueuedMessage["status"],
    deliveryError?: QueuedMessage["deliveryError"],
  ): Promise<void> {
    await this.store.update((state) => {
      const queue = state.messageQueues?.[threadId];
      if (!queue?.some((message) => message.id === messageId)) {
        throw new MessageQueueNotFoundError("Queued message not found");
      }
      state.messageQueues![threadId] = queue.map((message) =>
        message.id === messageId ? { ...message, status, deliveryError } : message,
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
    this.clearRetry(threadId);
    this.publish(threadId);
  }

  private publish(threadId: string): void {
    this.delivery.publish(threadId, this.list(threadId));
  }

  private async recordFailure(
    threadId: string,
    messageId: string,
    status: QueuedMessage["status"],
    error: unknown,
  ): Promise<void> {
    const missing = isMissingThreadError(error);
    const retryable =
      !missing &&
      !(
        error instanceof RpcError &&
        [-32600, -32602].includes(error.code) &&
        !isThreadNotLoadedError(error)
      );
    await this.setStatus(threadId, messageId, status, {
      message: missing
        ? "Сессия недоступна. Сообщение сохранено."
        : status === "dispatching"
          ? "Проверяем, было ли сообщение отправлено."
          : retryable
            ? "Ожидаем восстановления связи. Сообщение сохранено."
            : "Не удалось отправить сообщение. Оно сохранено.",
      retryable,
    });
    if (retryable) this.scheduleRetry(threadId);
  }

  private scheduleRetry(threadId: string): void {
    if (this.suspended || this.retries.get(threadId)?.timer) return;
    const attempt = (this.retries.get(threadId)?.attempt ?? 0) + 1;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5));
    const timer = setTimeout(() => {
      const retry = this.retries.get(threadId);
      if (retry) retry.timer = undefined;
      void this.recoverThread(threadId).catch(() => this.scheduleRetry(threadId));
    }, delay);
    timer.unref();
    this.retries.set(threadId, { attempt, timer });
  }

  private clearRetry(threadId: string): void {
    const retry = this.retries.get(threadId);
    if (retry?.timer) clearTimeout(retry.timer);
    this.retries.delete(threadId);
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
