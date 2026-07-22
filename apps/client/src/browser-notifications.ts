import { Capacitor } from "@capacitor/core";

import type { AppSnapshot, ServerEvent } from "@codexnest/protocol";

export type BrowserNotificationPermission = NotificationPermission | "unsupported";

export function getBrowserNotificationPermission(): BrowserNotificationPermission {
  if (Capacitor.isNativePlatform() || !window.isSecureContext || !("Notification" in window)) {
    return "unsupported";
  }
  return Notification.permission;
}

export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationPermission> {
  if (getBrowserNotificationPermission() === "unsupported") return "unsupported";
  return Notification.requestPermission();
}

export class BrowserNotificationTracker {
  private readonly threadStates = new Map<string, string>();
  private readonly threadTitles = new Map<string, string>();
  private readonly attentionIds = new Set<string>();
  private serviceWorkerRegistration: Promise<ServiceWorkerRegistration> | null = null;
  private lastObservedAt = 0;

  acceptSnapshot(snapshot: AppSnapshot): void {
    const cutoff = this.lastObservedAt;
    const firstConnection = cutoff === 0;
    let newest = cutoff;
    this.threadStates.clear();
    this.threadTitles.clear();
    this.attentionIds.clear();

    for (const thread of snapshot.threads) {
      this.threadStates.set(thread.id, thread.state);
      this.threadTitles.set(thread.id, thread.title);
      newest = Math.max(newest, thread.updatedAt);
      if (!firstConnection && thread.updatedAt > cutoff && thread.unread) {
        this.showTerminal(thread.state, thread.id, thread.title);
      }
    }

    for (const attention of snapshot.attention) {
      this.attentionIds.add(attention.id);
      newest = Math.max(newest, attention.createdAt);
      if (!firstConnection && attention.createdAt > cutoff) {
        this.show(
          "Codex ждёт решения",
          this.titleFor(attention.threadId),
          `attention:${attention.id}`,
          attention.threadId,
        );
      }
    }
    this.lastObservedAt = newest;
  }

  acceptEvent(event: ServerEvent): void {
    if (event.type === "thread.upserted") {
      const previous = this.threadStates.get(event.thread.id);
      this.threadStates.set(event.thread.id, event.thread.state);
      this.threadTitles.set(event.thread.id, event.thread.title);
      if (previous !== event.thread.state) {
        this.showTerminal(event.thread.state, event.thread.id, event.thread.title);
      }
      this.lastObservedAt = Math.max(this.lastObservedAt, event.thread.updatedAt);
    } else if (event.type === "thread.removed") {
      this.threadStates.delete(event.threadId);
      this.threadTitles.delete(event.threadId);
    } else if (event.type === "attention.upserted") {
      if (!this.attentionIds.has(event.attention.id)) {
        this.attentionIds.add(event.attention.id);
        this.show(
          "Codex ждёт решения",
          this.titleFor(event.attention.threadId),
          `attention:${event.attention.id}`,
          event.attention.threadId,
        );
      }
      this.lastObservedAt = Math.max(this.lastObservedAt, event.attention.createdAt);
    } else if (event.type === "attention.removed") {
      this.attentionIds.delete(event.attentionId);
    }
  }

  private showTerminal(state: string, threadId: string, threadTitle: string): void {
    if (state === "completed") {
      this.show("Задача завершена", threadTitle, `completed:${threadId}`, threadId);
    } else if (state === "failed") {
      this.show("Задача завершилась с ошибкой", threadTitle, `failed:${threadId}`, threadId);
    }
  }

  private titleFor(threadId: string | null): string {
    if (!threadId) return "Откройте CodexNest для подробностей";
    return this.threadTitles.get(threadId) ?? "Задача Codex";
  }

  private show(title: string, body: string, tag: string, threadId: string | null): void {
    if (
      getBrowserNotificationPermission() !== "granted" ||
      document.visibilityState === "visible"
    ) {
      return;
    }
    void this.showSystemNotification(title, body, tag, threadId).catch(() => {
      // Permission and browser support can change while the page is open.
    });
  }

  private async showSystemNotification(
    title: string,
    body: string,
    tag: string,
    threadId: string | null,
  ): Promise<void> {
    if ("serviceWorker" in navigator) {
      try {
        this.serviceWorkerRegistration ??=
          navigator.serviceWorker.register("/notification-worker.js");
        const registration = await this.serviceWorkerRegistration;
        await registration.showNotification(title, { body, tag, data: { threadId } });
        return;
      } catch {
        this.serviceWorkerRegistration = null;
      }
    }

    const notification = new Notification(title, { body, tag });
    notification.onclick = () => {
      notification.close();
      window.focus();
      if (!threadId) return;
      window.history.pushState(null, "", `/threads/${encodeURIComponent(threadId)}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    };
  }
}
