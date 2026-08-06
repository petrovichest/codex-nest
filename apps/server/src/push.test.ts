import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const firebase = vi.hoisted(() => ({
  cert: vi.fn((value: unknown) => value),
  getApps: vi.fn((): unknown[] => []),
  initializeApp: vi.fn(),
  sendEachForMulticast: vi.fn().mockResolvedValue({
    responses: [{ success: true }, { success: true }],
  }),
}));

vi.mock("firebase-admin/app", () => ({
  cert: firebase.cert,
  getApps: firebase.getApps,
  initializeApp: firebase.initializeApp,
}));
vi.mock("firebase-admin/messaging", () => ({
  getMessaging: () => ({ sendEachForMulticast: firebase.sendEachForMulticast }),
}));

import { PushNotifier } from "./push";
import { StateStore } from "./state/store";

const parentThread = {
  id: "thread",
  relation: { kind: "session", sessionId: "session" },
} as const;

const childThread = {
  id: "child",
  relation: {
    kind: "subagent",
    sessionId: "child-session",
    parentThreadId: "thread",
    nickname: null,
    role: null,
  },
} as const;

const directories: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  firebase.getApps.mockReturnValue([]);
  firebase.sendEachForMulticast.mockResolvedValue({
    responses: [{ success: true }, { success: true }],
  });
});

afterEach(async () =>
  Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  ),
);

describe("PushNotifier", () => {
  it("sends one multicast notification to every registered device", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-push-test-"));
    directories.push(directory);
    const statePath = join(directory, "state.json");
    const credentialPath = join(directory, "firebase.json");
    const store = new StateStore(statePath);
    await store.load();
    await store.update((state) => {
      state.devices.phone = { fcmToken: "phone-token", updatedAt: 1 };
      state.devices.tablet = { fcmToken: "tablet-token", updatedAt: 2 };
    });
    await writeFile(
      credentialPath,
      JSON.stringify({
        project_id: "project",
        client_email: "firebase@example.invalid",
        private_key: "private-key",
      }),
    );

    const notifier = new PushNotifier(store, credentialPath);
    await notifier.send(parentThread, "completed");

    expect(firebase.sendEachForMulticast).toHaveBeenCalledOnce();
    expect(firebase.sendEachForMulticast).toHaveBeenCalledWith(
      expect.objectContaining({
        tokens: ["phone-token", "tablet-token"],
        data: { threadId: "thread", eventType: "completed" },
        notification: {
          title: "Codex session finished",
          body: "Open CodexNest for details",
        },
      }),
    );

    await store.update((state) => {
      state.uiLanguage = "ru";
    });
    await notifier.send(parentThread, "failed");
    expect(firebase.sendEachForMulticast).toHaveBeenLastCalledWith(
      expect.objectContaining({
        notification: {
          title: "Сессия Codex завершена",
          body: "Сессия завершилась с ошибкой",
        },
      }),
    );

    firebase.sendEachForMulticast.mockClear();
    await notifier.send(childThread, "completed");
    await notifier.send(childThread, "failed");
    await notifier.send(childThread, "attention");
    expect(firebase.sendEachForMulticast).not.toHaveBeenCalled();

    await notifier.send(parentThread, "attention");
    expect(firebase.sendEachForMulticast).toHaveBeenCalledOnce();
    expect(firebase.sendEachForMulticast).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { threadId: "thread", eventType: "attention" },
      }),
    );
  });
});
