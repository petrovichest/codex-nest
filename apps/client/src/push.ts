import { Capacitor, registerPlugin } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { useEffect, useRef } from "react";
import type { NavigateFunction } from "react-router";
import type { UiLanguage } from "@codexnest/protocol";

const PENDING_THREAD_KEY = "codexnest.pendingThreadId";

type PermissionState = "prompt" | "prompt-with-rationale" | "granted" | "denied";

interface SelfHostedNotificationsPlugin {
  addListener(
    event: "notificationActionPerformed",
    listener: (event: { threadId?: string }) => void,
  ): Promise<{ remove(): Promise<void> }>;
  checkPermissions(): Promise<{ receive: PermissionState }>;
  requestPermissions(): Promise<{ receive: PermissionState }>;
  acknowledgeThread(options: { threadId: string }): Promise<void>;
  setLanguage(options: { language: UiLanguage }): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

const SelfHostedNotifications =
  registerPlugin<SelfHostedNotificationsPlugin>("SelfHostedNotifications");

export function usePushNotifications(navigate: NavigateFunction, language: UiLanguage): void {
  const initialLanguage = useRef(language);
  const languageInitialized = useRef(false);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    if (!languageInitialized.current) {
      languageInitialized.current = true;
      return;
    }
    void SelfHostedNotifications.setLanguage({ language }).catch(() => undefined);
  }, [language]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let active = true;
    let handle: { remove(): Promise<void> } | undefined;

    void SelfHostedNotifications.addListener("notificationActionPerformed", ({ threadId }) => {
      if (!active || !threadId) return;
      void Preferences.set({ key: PENDING_THREAD_KEY, value: threadId })
        .catch(() => undefined)
        .then(() => {
          if (active) navigate(`/threads/${encodeURIComponent(threadId)}`);
        });
    })
      .then((value) => {
        handle = value;
      })
      .catch(() => undefined);
    void (async () => {
      const pending = await Preferences.get({ key: PENDING_THREAD_KEY });
      if (active && pending.value) {
        navigate(`/threads/${encodeURIComponent(pending.value)}`);
      }
    })().catch(() => undefined);
    void (async () => {
      await SelfHostedNotifications.setLanguage({ language: initialLanguage.current }).catch(
        () => undefined,
      );
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

export async function acknowledgePendingThread(threadId: string): Promise<void> {
  if (!Capacitor.isNativePlatform() || !threadId) return;
  await Promise.allSettled([
    SelfHostedNotifications.acknowledgeThread({ threadId }),
    Preferences.get({ key: PENDING_THREAD_KEY }).then((pending) =>
      pending.value === threadId
        ? Preferences.remove({ key: PENDING_THREAD_KEY })
        : Promise.resolve(),
    ),
  ]);
}

export async function stopPushNotifications(): Promise<void> {
  if (Capacitor.isNativePlatform()) await SelfHostedNotifications.stop();
}
