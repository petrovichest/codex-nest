import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppSnapshot, ThreadDetail, ThreadSummary } from "@codexnest/protocol";

import { replaceCachedProjection, upgradeOfflineDatabase } from "./offline-store";

const settings = { baseUrl: "https://codexnest.example", token: "token" };

describe("offline projection cache v2", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("invalidates only reconstructable v1 records during the v2 upgrade", () => {
    const names = new Set(["meta", "threads", "drafts", "outbox", "recordings"]);
    const cleared: string[] = [];
    const database = {
      objectStoreNames: { contains: (name: string) => names.has(name) },
      createObjectStore: vi.fn(),
    } as unknown as IDBDatabase;
    const transaction = {
      objectStore: (name: string) => ({ clear: () => cleared.push(name) }),
    } as unknown as IDBTransaction;

    upgradeOfflineDatabase(database, transaction, 1);

    expect(cleared).toEqual(["meta", "threads"]);
    expect(cleared).not.toContain("drafts");
    expect(cleared).not.toContain("outbox");
    expect(cleared).not.toContain("recordings");
  });

  it("commits a ready snapshot and active thread in one transaction", async () => {
    const writes = new Map<string, unknown[]>();
    const transaction = vi.fn((storeNames: string[], mode: IDBTransactionMode) => {
      const target = new EventTarget() as IDBTransaction;
      Object.defineProperty(target, "error", { value: null });
      Object.defineProperty(target, "objectStore", {
        value: (name: string) => ({
          put: (value: unknown) => writes.set(name, [...(writes.get(name) ?? []), value]),
        }),
      });
      queueMicrotask(() => target.dispatchEvent(new Event("complete")));
      expect(storeNames).toEqual(["meta", "threads"]);
      expect(mode).toBe("readwrite");
      return target;
    });
    const close = vi.fn();
    const database = { transaction, close } as unknown as IDBDatabase;
    const request = new EventTarget() as IDBOpenDBRequest;
    Object.defineProperties(request, {
      result: { value: database },
      error: { value: null },
    });
    vi.stubGlobal("indexedDB", {
      open: vi.fn(() => {
        queueMicrotask(() => request.dispatchEvent(new Event("success")));
        return request;
      }),
    });

    await expect(
      replaceCachedProjection(settings, snapshot(), detail(), { thread: null }),
    ).resolves.toBe(true);

    expect(transaction).toHaveBeenCalledOnce();
    expect(writes.get("meta")?.[0]).toMatchObject({
      formatVersion: 2,
      snapshot: { epoch: "epoch", revision: 3 },
    });
    expect(writes.get("threads")?.[0]).toMatchObject({
      threadId: "thread",
      formatVersion: 2,
      detail: { summary: { id: "thread" } },
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("refuses to cache a reconciling or malformed projection", async () => {
    const open = vi.fn();
    vi.stubGlobal("indexedDB", { open });

    await expect(
      replaceCachedProjection(
        settings,
        { ...snapshot(), projectionStatus: "reconciling" },
        null,
        {},
      ),
    ).resolves.toBe(false);
    await expect(
      replaceCachedProjection(settings, { ...snapshot(), epoch: "" }, null, {}),
    ).resolves.toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});

function snapshot(): AppSnapshot {
  return {
    protocolVersion: 2,
    epoch: "epoch",
    revision: 3,
    projectionStatus: "ready",
    uiLanguage: "ru",
    connection: { state: "ready", message: null, syncedAt: "2026-08-05T00:00:00.000Z" },
    projects: [],
    threads: [summary()],
    attention: [],
    models: [],
    pushConfigured: false,
  };
}

function summary(): ThreadSummary {
  return {
    id: "thread",
    relation: { kind: "session", sessionId: "session" },
    projectId: null,
    title: "Thread",
    preview: "",
    cwd: "/work",
    state: "idle",
    unread: false,
    unseen: false,
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 2,
    currentTurnId: null,
    queuedMessageCount: 0,
    settings: { collaborationMode: "default" },
  };
}

function detail(): ThreadDetail {
  return { summary: summary(), turns: [], queuedMessages: [], olderTurnsCursor: null };
}
