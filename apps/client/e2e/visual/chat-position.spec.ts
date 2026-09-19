import { expect, test, type Page, type Route } from "@playwright/test";
import type { ServerEvent, ThreadDetail, ThreadSummary, TurnView } from "@codexnest/protocol";
import { installVisualFixture, mainThread, snapshot, waitForVisualReady } from "./fixtures";

async function json(route: Route, body: unknown) {
  await route.fulfill({
    headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function turn(id: string, text: string): TurnView {
  return {
    id,
    status: "inProgress",
    startedAt: 1,
    completedAt: null,
    durationMs: null,
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
        id: `${id}-answer`,
        type: "agentMessage",
        text,
        images: [],
        status: "inProgress",
        timestamp: 1,
        phase: "commentary",
      },
    ],
  };
}

async function setup(page: Page, running = false, draft = "", draftReady = Promise.resolve()) {
  const summary: ThreadSummary = {
    ...mainThread,
    state: running ? "running" : "completed",
    currentTurnId: running ? "history" : null,
    settings: { collaborationMode: "default" },
  };
  const other: ThreadSummary = {
    ...summary,
    id: "other",
    title: "Другой чат",
    relation: { kind: "session", sessionId: "other" },
  };
  const seed = structuredClone(snapshot);
  seed.attention = [];
  seed.threads = [summary, other];
  const detail: ThreadDetail = {
    summary,
    turns: [turn("history", "Абзац истории для проверки прокрутки.\n\n".repeat(80))],
    queuedMessages: [],
    olderTurnsCursor: null,
    draft: draft
      ? { input: draft, images: [], annotations: [], goalMode: false, updatedAt: 1 }
      : null,
  };
  await installVisualFixture(page, {
    theme: "light",
    snapshot: seed,
    reducedMotion: "no-preference",
  });
  await page.route("**/api/v1/threads/session-main", async (route) => {
    if (route.request().method() === "OPTIONS") return route.fallback();
    await draftReady;
    return json(route, detail);
  });
  await page.route("**/api/v1/threads/*/draft", async (route) => {
    if (route.request().method() === "OPTIONS") return route.fallback();
    const saved = { ...route.request().postDataJSON(), updatedAt: Date.now() };
    if (route.request().url().includes("/session-main/")) detail.draft = saved;
    return json(route, saved);
  });
  let sequence = seed.sequence;
  let send!: (event: ServerEvent) => void;
  await page.routeWebSocket("wss://codexnest.visual/api/v1/events", (socket) => {
    send = (event) => socket.send(JSON.stringify({ type: "event", sequence: ++sequence, event }));
    socket.onMessage((message) => {
      const frame = JSON.parse(message.toString());
      if (frame.type === "authenticate")
        socket.send(JSON.stringify({ type: "snapshot", snapshot: seed }));
      if (frame.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
    });
  });
  return { send: (event: ServerEvent) => send(event) };
}

async function openChat(page: Page, id: string) {
  if (page.viewportSize()!.width <= 820)
    await page.getByRole("button", { name: "Открыть список задач" }).click();
  await page.locator(`.thread-link[href="/threads/${id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/threads/${id}$`, "u"));
}

for (const width of [390, 1440]) {
  for (const submit of ["Enter", "button"] as const) {
    test(`sending with ${submit} returns to the tail and follows replies at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      const { send } = await setup(page, submit === "button");
      const accepted = deferred();
      await page.route("**/api/v1/threads/session-main/queue", async (route) => {
        if (route.request().method() === "OPTIONS") return route.fallback();
        const body = route.request().postDataJSON();
        await accepted.promise;
        return json(route, { id: body.clientMessageId });
      });
      await page.goto("/threads/session-main");
      const field = page.locator(".composer textarea");
      const scroll = page.locator(".conversation-scroll");
      const jump = page.getByRole("button", { name: "Прокрутить к последнему сообщению" });
      const distance = () =>
        scroll.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
      await expect.poll(distance).toBeLessThanOrEqual(1);

      try {
        for (const fromHistory of [false, true]) {
          const text = fromHistory
            ? "Многострочное сообщение\n".repeat(8).trim()
            : "Продолжим обсуждение";
          await field.fill(text);
          await waitForVisualReady(page);
          if (fromHistory) {
            await scroll.evaluate((el) => {
              el.scrollTop = 300;
            });
            await expect(jump).toBeVisible();
          }
          if (submit === "Enter") await field.press("Enter");
          else
            await page.getByRole("button", { name: /^(Отправить|Добавить в очередь)$/u }).click();

          await expect(field).toHaveValue("");
          const message = page
            .locator(".queued-message")
            .filter({ hasText: text.split("\n")[0]! })
            .last();
          await expect(message).toBeVisible();
          accepted.resolve();

          // A fast reply can grow the timeline while the send scroll is still starting.
          send({
            type: "turn.replaced",
            threadId: mainThread.id,
            turn: turn(`reply-${fromHistory}`, "Начало ответа"),
          });
          send({
            type: "activity.delta",
            threadId: mainThread.id,
            turnId: `reply-${fromHistory}`,
            itemId: `reply-${fromHistory}-answer`,
            activityType: "agentMessage",
            delta: "\n\nПродолжение потокового ответа. ".repeat(30),
          });
          await expect(page.locator(".timeline")).toContainText("Продолжение потокового ответа.");
          await expect.poll(distance).toBeLessThanOrEqual(1);
          await expect(jump).toBeHidden();
          const bubble = (await page.locator(".composer-box").boundingBox())!;
          const box = (await message.boundingBox())!;
          expect(box.y + box.height).toBeLessThanOrEqual(bubble.y);

          await scroll.evaluate((el) => {
            el.scrollTop = 300;
          });
          await expect(jump).toBeVisible();
          send({
            type: "activity.delta",
            threadId: mainThread.id,
            turnId: `reply-${fromHistory}`,
            itemId: `reply-${fromHistory}-answer`,
            activityType: "agentMessage",
            delta: "\n\nЧитаем историю",
          });
          await expect(page.locator(".timeline")).toContainText("Читаем историю");
          await waitForVisualReady(page);
          expect(await scroll.evaluate((el) => el.scrollTop)).toBeCloseTo(300, 0);
        }
      } finally {
        accepted.resolve();
      }
    });
  }

  for (const delayed of [false, true]) {
    test(`opening a chat places the caret after its ${delayed ? "delayed" : "cached"} draft at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      const loaded = deferred();
      const draft = "Черновик для продолжения\n".repeat(20).trim();
      const { send } = await setup(page, false, draft, delayed ? loaded.promise : undefined);
      const field = page.locator(".composer textarea");
      try {
        if (!delayed) {
          await page.goto("/threads/session-main");
          await expect(field).toHaveValue(draft);
          await openChat(page, "other");
        } else await page.goto("/threads/other");
        await openChat(page, "session-main");
        await expect(field).toBeFocused();
        loaded.resolve();
        await expect(field).toHaveValue(draft);
        await expect
          .poll(() =>
            field.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]),
          )
          .toEqual([draft.length, draft.length]);
        await page.keyboard.type(" ДОПИСАНО");
        await expect(field).toHaveValue(`${draft} ДОПИСАНО`);
        await expect
          .poll(() => field.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
          .toBeLessThanOrEqual(1);

        await field.press("Home");
        const caret = await field.evaluate((el: HTMLTextAreaElement) => el.selectionStart);
        send({
          type: "turn.replaced",
          threadId: mainThread.id,
          turn: turn("background", "Обновление чата"),
        });
        await expect(page.locator(".timeline")).toContainText("Обновление чата");
        await waitForVisualReady(page);
        expect(await field.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(caret);
        await page.keyboard.type("!");
        const edited = `${draft} ДОПИСАНО`;
        await expect(field).toHaveValue(`${edited.slice(0, caret)}!${edited.slice(caret)}`);
        await field.press("Control+z");
        await expect(field).toHaveValue(edited);
        await openChat(page, "other");
        await expect(field).toHaveValue("");
        await openChat(page, "session-main");
        await expect(field).toHaveValue(edited);
        await expect
          .poll(() =>
            field.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]),
          )
          .toEqual([edited.length, edited.length]);
      } finally {
        loaded.resolve();
      }
    });
  }
}
