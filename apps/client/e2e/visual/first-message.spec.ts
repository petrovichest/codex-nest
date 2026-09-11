import { expect, test, type Page, type Route } from "@playwright/test";

import type { QueueMessageRequest, QueuedMessage, ThreadSummary } from "@codexnest/protocol";

import {
  installVisualFixture,
  mainThread,
  snapshot,
  PHONE_VIEWPORT,
  DESKTOP_VIEWPORT,
} from "./fixtures";

const serverOrigin = "https://codexnest.visual";
const messageText = "Первое сообщение не должно пропасть после быстрого Enter";

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "Authorization, Content-Type",
      "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function storedMessages(page: Page, store: "drafts" | "outbox") {
  return page.evaluate(async (storeName) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("codexnest-offline");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<
        Array<{ id?: string; accepted?: boolean; submission?: { id: string; input: string } }>
      >((resolve, reject) => {
        const request = database.transaction(storeName).objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  }, store);
}

test("fast first Enter survives reloads during creation and after a lost acceptance response", async ({
  page,
}, testInfo) => {
  const createdThread: ThreadSummary = {
    ...mainThread,
    id: "session-first-message",
    title: "Без названия",
    preview: "",
    pinned: false,
    state: "idle",
    queuedMessageCount: 0,
    settings: { collaborationMode: "default" },
    relation: { kind: "session", sessionId: "session-first-message" },
  };
  const liveSnapshot = structuredClone(snapshot);
  liveSnapshot.instanceId = "first-message-test";
  liveSnapshot.threads.push(createdThread);
  await installVisualFixture(page, { theme: "light", snapshot: liveSnapshot });

  let releaseCreation!: () => void;
  const creationGate = new Promise<void>((resolve) => {
    releaseCreation = resolve;
  });
  const submissions: QueueMessageRequest[] = [];
  const accepted = new Map<string, QueuedMessage>();
  let connectionRestored = false;
  await page.route(`${serverOrigin}/api/v1/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") return route.fallback();
    if (path === "/api/v1/projects/project-nest/threads" && request.method() === "POST") {
      await creationGate;
      return json(route, { thread: createdThread, draft: null });
    }
    if (path === `/api/v1/threads/${createdThread.id}/queue` && request.method() === "POST") {
      const body = request.postDataJSON() as QueueMessageRequest;
      submissions.push(body);
      const id = body.clientMessageId!;
      if (!accepted.has(id)) {
        accepted.set(id, {
          id,
          threadId: createdThread.id,
          text: body.input,
          createdAt: Date.now(),
          status: "queued",
          deliveryError: { message: "Сессия недоступна. Сообщение сохранено.", retryable: false },
        });
        createdThread.state = "queued";
        createdThread.queuedMessageCount = accepted.size;
      }
      // The server accepted the message, but its first response never reaches the browser.
      if (submissions.length === 1) return route.abort("failed");
      if (!connectionRestored)
        return json(route, { error: { code: "unavailable", message: "Temporary outage" } }, 503);
      return json(route, accepted.get(id), 202);
    }
    if (path === `/api/v1/threads/${createdThread.id}` && request.method() === "GET") {
      return json(route, {
        summary: createdThread,
        turns: [],
        olderTurnsCursor: null,
        draft: null,
        queuedMessages: [...accepted.values()],
        historyError: { message: "Не удалось загрузить историю сессии", retryable: false },
      });
    }
    if (path === `/api/v1/threads/${createdThread.id}/draft` && request.method() === "PUT")
      return json(route, { ...request.postDataJSON(), updatedAt: Date.now() });
    if (path === `/api/v1/threads/${createdThread.id}/settings`) return json(route, createdThread);
    return route.fallback();
  });

  try {
    await page.goto("/threads/session-main");
    await page.getByRole("button", { name: "Создать новую сессию в проекте CodexNest" }).click();
    const composer = page.getByRole("textbox", { name: "Сообщение для Codex", exact: true });
    await composer.fill(messageText);
    await composer.press("Enter");
    await composer.press("Enter");
    await expect(composer).toHaveValue("");
    await expect(page.locator(".timeline")).toContainText(messageText);
    await expect(page.locator(".timeline")).toContainText("Отправляется…");
    await page.screenshot({ path: testInfo.outputPath("sending-desktop.png") });
    await page.setViewportSize(PHONE_VIEWPORT);
    await expect(page.locator(".timeline")).toContainText(messageText);
    await page.screenshot({ path: testInfo.outputPath("sending-phone.png") });
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await expect(page).toHaveURL(/\/new\?/u);
    let messageId = "";
    await expect
      .poll(async () => {
        const pending = (await storedMessages(page, "drafts")).find((draft) => draft.submission);
        messageId = pending?.submission?.id ?? "";
        return pending?.submission?.input;
      })
      .toBe(messageText);
    expect(submissions).toHaveLength(0);

    await page.reload();
    await expect(composer).toHaveValue("");
    await expect(page.locator(".timeline")).toContainText(messageText);
    releaseCreation();
    await expect(page).toHaveURL(`/threads/${createdThread.id}`);
    await expect(composer).toHaveValue("");
    await expect(page.locator(".queued-message")).toContainText(messageText);
    await expect(page.locator(".queued-message")).toContainText("Нет связи — повторим отправку");
    await expect
      .poll(async () => (await storedMessages(page, "outbox")).map((item) => item.id))
      .toEqual([messageId]);

    connectionRestored = true;
    await page.reload();
    await expect(page.locator(".queued-message")).toContainText(messageText);
    await expect(
      page.getByRole("button", { name: "Скопировать сообщение", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Повторить загрузку истории" })).toBeVisible();
    await expect.poll(async () => (await storedMessages(page, "outbox"))[0]?.accepted).toBe(true);
    const attempts = submissions.length;
    await page.reload();
    await expect(page.locator(".queued-message")).toContainText("Отправлено");
    await expect(page.locator(".queued-message")).toContainText(messageText);
    expect(submissions).toHaveLength(attempts);
    expect(submissions.length).toBeGreaterThanOrEqual(2);
    expect(new Set(submissions.map((body) => body.clientMessageId))).toEqual(new Set([messageId]));
    expect(accepted.size).toBe(1);
  } finally {
    releaseCreation();
  }
});
