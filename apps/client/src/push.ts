import { Capacitor, registerPlugin } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { useEffect } from "react";
import type { NavigateFunction } from "react-router-dom";

const PENDING_THREAD_KEY = "codexnest.pendingThreadId";

type PermissionState = "prompt" | "prompt-with-rationale" | "granted" | "denied";

interface SelfHostedNotificationsPlugin {
  addListener(
    event: "notificationActionPerformed",
    listener: (event: { threadId?: string }) => void,
  ): Promise<{ remove(): Promise<void> }>;
  checkPermissions(): Promise<{ receive: PermissionState }>;
  requestPermissions(): Promise<{ receive: PermissionState }>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

const SelfHostedNotifications =
  registerPlugin<SelfHostedNotificationsPlugin>("SelfHostedNotifications");

export function usePushNotifications(navigate: NavigateFunction): void {
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let active = true;
    let handle: { remove(): Promise<void> } | undefined;

    void (async () => {
      handle = await SelfHostedNotifications.addListener(
        "notificationActionPerformed",
        ({ threadId }) => {
          if (active && threadId) navigate(`/threads/${encodeURIComponent(threadId)}`);
        },
      );
      const pending = await Preferences.get({ key: PENDING_THREAD_KEY });
      if (active && pending.value) {
        navigate(`/threads/${encodeURIComponent(pending.value)}`);
        await Preferences.remove({ key: PENDING_THREAD_KEY });
      }
      const current = await SelfHostedNotifications.checkPermissions();
      const permission =
        current.receive === "prompt" ? await SelfHostedNotifications.requestPermissions() : current;
      if (permission.receive === "granted") await SelfHostedNotifications.start();
    })().catch(() => undefined);

    return () => {
      active = false;
      void handle?.remove();
    };
  }, [navigate]);
}

export async function stopPushNotifications(): Promise<void> {
  if (Capacitor.isNativePlatform()) await SelfHostedNotifications.stop();
}
