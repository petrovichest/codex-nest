import { expect, test } from "@playwright/test";
import type { ThreadDetail, UpdateThreadDraftRequest } from "@codexnest/protocol";
import type * as OfflineStore from "../../src/offline-store";
import { installVisualFixture, mainThread } from "./fixtures";

test("outbox handoffs are atomic in real IndexedDB, including aborted transactions", async ({
  page,
}) => {
  await installVisualFixture(page, { theme: "light" });
  await page.goto("/threads/session-main");
  const result = await page.evaluate(async (summary) => {
    const modulePath = "/src/offline-store.ts";
    const store = (await import(modulePath)) as typeof OfflineStore;
    const settings = { baseUrl: "https://storage-test.invalid", token: "test" };
    const draft: UpdateThreadDraftRequest = {
      input: "Сохранить",
      images: [],
      files: [],
      annotations: [],
      goalMode: false,
    };
    const message = {
      id: "storage-message",
      threadId: summary.id,
      input: draft.input,
      connectionKey: store.connectionCacheKey(settings),
      images: [],
      files: [],
      goal: false,
      createdAt: 1,
      attempts: 0,
      lastError: null,
    };
    const originalPut = IDBObjectStore.prototype.put;
    function abortWritesTo(storeName: string) {
      IDBObjectStore.prototype.put = function (...args) {
        const request = originalPut.apply(this, args);
        if (this.name === storeName) this.transaction.abort();
        return request;
      };
    }
    await store.saveLocalDraft(settings, summary.id, draft);
    abortWritesTo("outbox");
    const abortedTransfer = await store.putOutboxMessage(message, { draft });
    IDBObjectStore.prototype.put = originalPut;
    const draftAfterAbort = await store.loadLocalDraft(settings, summary.id);
    const outboxAfterAbort = await store.listOutboxMessages(settings);
    const transferred = await store.putOutboxMessage(message, { draft });
    const draftAfterTransfer = await store.loadLocalDraft(settings, summary.id);
    await store.acknowledgeOutboxMessage(message);
    const accepted = await store.listOutboxMessages(settings);
    const detail: ThreadDetail = {
      summary,
      turns: [],
      queuedMessages: [
        {
          id: message.id,
          threadId: summary.id,
          text: message.input,
          status: "queued",
          createdAt: 1,
        },
      ],
      olderTurnsCursor: null,
    };
    await store.saveCachedThread(settings, detail);
    const queueOnly = await store.listOutboxMessages(settings);
    detail.queuedMessages = [];
    detail.turns = [
      {
        id: "turn",
        status: "completed",
        startedAt: 1,
        completedAt: 2,
        durationMs: 1,
        progress: {
          startedAt: 1,
          explanation: null,
          steps: [],
          filesChanged: 0,
          additions: 0,
          deletions: 0,
        },
        items: [
          {
            type: "userMessage",
            id: message.id,
            text: message.input,
            images: [],
            status: "completed",
            timestamp: 1,
            phase: null,
          },
        ],
      },
    ];
    abortWritesTo("threads");
    const abortedCache = await store.saveCachedThread(settings, detail);
    IDBObjectStore.prototype.put = originalPut;
    const afterFailedCache = await store.listOutboxMessages(settings);
    const cached = await store.saveCachedThread(settings, detail);
    const afterCache = await store.listOutboxMessages(settings);
    // A late/repeated HTTP acknowledgement must not resurrect the fallback.
    await store.acknowledgeOutboxMessage(message);
    const afterLateAck = await store.listOutboxMessages(settings);
    const history = await store.loadCachedThread(settings, summary.id);
    await store.saveLocalDraft(settings, summary.id, { ...draft, input: "Следующий черновик" });
    await store.putOutboxMessage({ ...message, id: "next-message" }, { draft });
    const newer = await store.loadLocalDraft(settings, summary.id);
    return {
      abortedTransfer,
      draftAfterAbort,
      outboxAfterAbort,
      transferred,
      draftAfterTransfer,
      accepted,
      queueOnly,
      abortedCache,
      afterFailedCache,
      cached,
      afterCache,
      afterLateAck,
      history,
      newer,
    };
  }, mainThread);
  expect(result.abortedTransfer).toBe(false);
  expect(result.draftAfterAbort?.value.input).toBe("Сохранить");
  expect(result.outboxAfterAbort).toEqual([]);
  expect(result.transferred).toBe(true);
  expect(result.draftAfterTransfer).toBeNull();
  for (const records of [result.accepted, result.queueOnly, result.afterFailedCache])
    expect(records).toEqual([expect.objectContaining({ id: "storage-message", accepted: true })]);
  expect(result.abortedCache).toBe(false);
  expect(result.cached).toBe(true);
  expect(result.afterCache).toEqual([]);
  expect(result.afterLateAck).toEqual([]);
  expect(result.history?.turns[0]?.items[0]?.id).toBe("storage-message");
  expect(result.newer?.value.input).toBe("Следующий черновик");
});

test("the preparation handoff preserves attachments and the next draft across reload", async ({
  page,
}) => {
  await installVisualFixture(page, { theme: "light" });
  await page.goto("/threads/session-main");
  await page.evaluate(async (thread) => {
    const modulePath = "/src/offline-store.ts";
    const store = (await import(modulePath)) as typeof OfflineStore;
    const settings = { baseUrl: "https://storage-test.invalid", token: "test" };
    const draft: UpdateThreadDraftRequest = {
      input: "Первое с вложениями",
      images: [{ name: "image.png", url: "data:image/png;base64,aW1hZ2U=" }],
      files: [
        { id: "file", name: "notes.txt", path: "/tmp/notes.txt", size: 3, mediaType: "text/plain" },
      ],
      annotations: [],
      goalMode: false,
    };
    await store.saveNewSessionDraft(
      settings,
      "project",
      { ...draft, input: "Новый черновик" },
      {
        phase: "transferring",
        threadId: thread.id,
        thread,
        revision: 2,
        submission: { id: "first", intent: "queue", input: draft.input, draft, staged: true },
      },
    );
    await store.putOutboxMessage(
      {
        id: "first",
        threadId: thread.id,
        connectionKey: store.connectionCacheKey(settings),
        input: draft.input,
        images: draft.images.map((image) => image.url),
        files: draft.files,
        goal: false,
        createdAt: 1,
        attempts: 0,
        lastError: null,
      },
      { draft, projectId: "project" },
    );
  }, mainThread);
  await page.reload();
  const result = await page.evaluate(async (threadId) => {
    const modulePath = "/src/offline-store.ts";
    const store = (await import(modulePath)) as typeof OfflineStore;
    const settings = { baseUrl: "https://storage-test.invalid", token: "test" };
    return {
      prep: await store.loadNewSessionDraft(settings, "project"),
      draft: await store.loadLocalDraft(settings, threadId),
      outbox: await store.listOutboxMessages(settings),
    };
  }, mainThread.id);
  expect(result.prep?.submission).toBeUndefined();
  expect(result.draft?.value.input).toBe("Новый черновик");
  expect(result.draft?.value.images[0]?.name).toBe("image.png");
  expect(result.draft?.value.files?.[0]?.id).toBe("file");
  expect(result.outbox).toEqual([
    expect.objectContaining({
      id: "first",
      input: "Первое с вложениями",
      images: ["data:image/png;base64,aW1hZ2U="],
      files: [expect.objectContaining({ id: "file" })],
    }),
  ]);
});
