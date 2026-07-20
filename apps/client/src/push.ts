import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { PushNotifications } from "@capacitor/push-notifications";
import { useEffect } from "react";
import type { NavigateFunction } from "react-router-dom";

import type { ApiClient } from "./api";

const INSTALLATION_KEY = "codexnest.installationId";
const PENDING_THREAD_KEY = "codexnest.pendingThreadId";

export function usePushNotifications(api: ApiClient, navigate: NavigateFunction): void {
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let active = true;
    const handles: Array<{ remove(): Promise<void> }> = [];

    void (async () => {
      const installationId = await getInstallationId();
      const pending = await Preferences.get({ key: PENDING_THREAD_KEY });
      if (active && pending.value) {
        navigate(`/threads/${encodeURIComponent(pending.value)}`);
        await Preferences.remove({ key: PENDING_THREAD_KEY });
      }
      handles.push(
        await PushNotifications.addListener("registration", (token) => {
          if (active)
            void api
              .registerDevice(installationId, { fcmToken: token.value })
              .catch(() => undefined);
        }),
        await PushNotifications.addListener("registrationError", () => undefined),
        await PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
          const threadId = action.notification.data?.threadId;
          if (typeof threadId === "string") {
            void Preferences.set({ key: PENDING_THREAD_KEY, value: threadId });
            if (active) navigate(`/threads/${encodeURIComponent(threadId)}`);
          }
        }),
      );
      const current = await PushNotifications.checkPermissions();
      const permission =
        current.receive === "prompt" ? await PushNotifications.requestPermissions() : current;
      if (permission.receive === "granted") await PushNotifications.register();
    })();

    return () => {
      active = false;
      for (const handle of handles) void handle.remove();
    };
  }, [api, navigate]);
}

async function getInstallationId(): Promise<string> {
  const existing = await Preferences.get({ key: INSTALLATION_KEY });
  if (existing.value) return existing.value;
  const value = crypto.randomUUID();
  await Preferences.set({ key: INSTALLATION_KEY, value });
  return value;
}
