import { readFile } from "node:fs/promises";

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";

import type { StateStore } from "./state/store";

export class PushNotifier {
  private initialized = false;

  constructor(
    private readonly store: StateStore,
    private readonly credentialPath?: string,
    private readonly projectId?: string,
  ) {}

  get configured(): boolean {
    return !!this.credentialPath;
  }

  async send(threadId: string, eventType: "completed" | "failed" | "attention"): Promise<void> {
    if (!this.credentialPath) return;
    const state = this.store.snapshot();
    if (eventType !== "attention" && state.threadMeta[threadId]?.managedParent) return;
    await this.initialize();
    const registrations = Object.entries(state.devices);
    if (!registrations.length) return;
    const english = state.uiLanguage === "en";
    const result = await getMessaging().sendEachForMulticast({
      tokens: registrations.map(([, device]) => device.fcmToken),
      data: { threadId, eventType },
      notification: {
        title:
          eventType === "attention"
            ? english
              ? "Codex needs your decision"
              : "Codex ждёт решения"
            : english
              ? "Codex session finished"
              : "Сессия Codex завершена",
        body:
          eventType === "failed"
            ? english
              ? "The session finished with an error"
              : "Сессия завершилась с ошибкой"
            : english
              ? "Open CodexNest for details"
              : "Откройте CodexNest для подробностей",
      },
      android: { priority: "high" },
    });
    const invalid = new Set<string>();
    result.responses.forEach((response, index) => {
      const code = response.error?.code;
      if (
        code === "messaging/registration-token-not-registered" ||
        code === "messaging/invalid-registration-token"
      ) {
        const registration = registrations[index];
        if (registration) invalid.add(registration[0]);
      }
    });
    if (invalid.size) {
      await this.store.update((state) => {
        for (const installationId of invalid) delete state.devices[installationId];
      });
    }
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    if (!getApps().length) {
      const serialized = await readFile(this.credentialPath!, "utf8");
      const serviceAccount = JSON.parse(serialized) as {
        project_id?: string;
        client_email?: string;
        private_key?: string;
      };
      if (
        !serviceAccount.project_id ||
        !serviceAccount.client_email ||
        !serviceAccount.private_key
      ) {
        throw new Error("Invalid Firebase service-account credential");
      }
      const projectId = this.projectId ?? serviceAccount.project_id;
      initializeApp({
        credential: cert({
          projectId: serviceAccount.project_id,
          clientEmail: serviceAccount.client_email,
          privateKey: serviceAccount.private_key,
        }),
        projectId,
      });
    }
    this.initialized = true;
  }
}
