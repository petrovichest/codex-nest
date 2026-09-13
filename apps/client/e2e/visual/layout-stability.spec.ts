import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import type { ServerEvent, ThreadDetail, ThreadSummary, TurnView } from "@codexnest/protocol";
import {
  DESKTOP_VIEWPORT,
  PHONE_VIEWPORT,
  installVisualFixture,
  mainThread,
  snapshot,
  waitForVisualReady,
} from "./fixtures";

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
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

async function geometry(locator: Locator) {
  return locator.evaluateAll((elements) =>
    elements.map((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    }),
  );
}

function unchanged(before: Awaited<ReturnType<typeof geometry>>, after: typeof before) {
  expect(after).toHaveLength(before.length);
  before.forEach((box, index) => {
    for (const key of ["x", "y", "width", "height"] as const) {
      expect(
        Math.abs(box[key] - after[index]![key]),
        `element ${index}: ${key}`,
      ).toBeLessThanOrEqual(1);
    }
  });
}

async function expectPackedActions(page: Page) {
  const actions = page.locator(".composer-actions");
  const bounds = (await actions.boundingBox())!;
  const buttons = await geometry(actions.locator(":scope > button"));
  expect(buttons[0]!.x).toBeCloseTo(bounds.x, 1);
  const last = buttons.at(-1)!;
  expect(last.x + last.width).toBeCloseTo(bounds.x + bounds.width, 1);
  for (let index = 1; index < buttons.length; index++) {
    const previous = buttons[index - 1]!;
    const current = buttons[index]!;
    const gap = current.x - previous.x - previous.width;
    expect(gap).toBeGreaterThanOrEqual(-0.1);
    expect(gap).toBeLessThanOrEqual(4);
    expect(current.y + current.height / 2).toBeCloseTo(previous.y + previous.height / 2, 1);
  }
}

async function verticalGap(before: Locator, after: Locator) {
  const first = (await before.boundingBox())!;
  const second = (await after.boundingBox())!;
  return second.y - first.y - first.height;
}

const messageText =
  "Одинаковое **сообщение** со ссылкой [пример](https://example.test).\n\n" +
  "Длинный текст должен целиком сохранять переносы и размеры до и после отправки. ".repeat(8);

function turn(id: string, text: string, messageId = id): TurnView {
  return {
    id,
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
        id: messageId,
        type: "userMessage",
        text,
        images: [],
        status: "completed",
        timestamp: 1,
        phase: null,
      },
    ],
  };
}

async function chat(
  page: Page,
  theme: "light" | "dark",
  text = messageText,
  options: { modelName?: string; voice?: boolean } = {},
) {
  const summary: ThreadSummary = { ...mainThread, state: "completed", currentTurnId: null };
  const seed = structuredClone(snapshot);
  seed.attention = [];
  seed.threads = [summary];
  if (options.modelName) seed.models[0]!.displayName = options.modelName;
  const detail: ThreadDetail = {
    summary,
    turns: [turn("original", text)],
    olderTurnsCursor: null,
    draft: null,
    queuedMessages: [{ id: "queued", threadId: summary.id, text, status: "queued", createdAt: 1 }],
  };
  await installVisualFixture(page, { theme, snapshot: seed });
  if (options.voice === false)
    await page.route("**/api/v1/transcriptions/config", (route) =>
      json(route, { error: "Voice unavailable in this fixture" }, 503),
    );
  await page.route("**/api/v1/threads/session-main", (route) => json(route, detail));
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
  await page.goto("/threads/session-main");
  await expect(page.locator(".queued-message-text")).toBeVisible();
  await waitForVisualReady(page);
  return { summary, detail, send: (event: ServerEvent) => send(event) };
}

for (const mobile of [false, true]) {
  for (const theme of ["light", "dark"] as const) {
    test(`${mobile ? "mobile" : "desktop"} ${theme}: queue typography and delivery geometry`, async ({
      page,
    }) => {
      await page.setViewportSize(mobile ? PHONE_VIEWPORT : DESKTOP_VIEWPORT);
      const { detail, send } = await chat(page, theme);
      const original = page.locator('[data-message-id="original"] > .message-body');
      const queued = page.locator('[data-message-id="queued"] > .message-body');
      const compare = async (locator: Locator) =>
        locator.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            width: element.getBoundingClientRect().width,
            height: element.getBoundingClientRect().height,
            font: style.fontFamily,
            size: style.fontSize,
            lineHeight: style.lineHeight,
          };
        });
      const before = await compare(queued);
      expect(before).toEqual(await compare(original));
      await expect(queued.locator("strong")).toHaveText("сообщение");
      expect(
        await queued
          .locator("p")
          .last()
          .evaluate((el) => el.scrollHeight <= el.clientHeight),
      ).toBe(true);
      send({
        type: "turn.replaced",
        threadId: mainThread.id,
        turn: turn("delivered", messageText, "queued"),
      });
      detail.queuedMessages = [];
      send({ type: "queue.changed", threadId: mainThread.id, messages: [] });
      await expect(page.locator(".queued-message")).toHaveCount(0);
      expect(await compare(queued)).toEqual(before);
    });

    test(`${mobile ? "mobile" : "desktop"} ${theme}: toolbar stays compact through running and voice states`, async ({
      page,
    }) => {
      await page.setViewportSize(mobile ? PHONE_VIEWPORT : DESKTOP_VIEWPORT);
      const { summary, send } = await chat(page, theme, "Проверка");
      const controls = page.locator(
        ".composer-add-image,.model-toggle,.plan-toggle,.team-toggle,.goal-toggle,.composer-actions > .microphone,.composer-actions > .composer-action:last-child",
      );
      const before = await geometry(controls);
      await expectPackedActions(page);
      if (mobile) {
        for (const control of before) expect(control.y).toBeCloseTo(before[0]!.y, 0);
        expect((await page.locator(".composer-toolbar").boundingBox())!.height).toBeLessThanOrEqual(
          48,
        );
      }
      send({
        type: "thread.upserted",
        thread: { ...summary, state: "running", currentTurnId: "running" },
      });
      await expect(
        page.getByRole("button", { name: "Остановить задачу", exact: true }),
      ).toBeVisible();
      const running = await geometry(controls);
      unchanged(before.slice(0, 5), running.slice(0, 5));
      unchanged(before.slice(-1), running.slice(-1));
      await expectPackedActions(page);
      await page.evaluate(() => {
        class Recorder extends EventTarget {
          static isTypeSupported() {
            return true;
          }
          state = "inactive";
          mimeType = "audio/webm";
          start() {
            this.state = "recording";
          }
          stop() {
            this.state = "inactive";
            this.dispatchEvent(new Event("stop"));
          }
        }
        Object.defineProperty(window, "MediaRecorder", { configurable: true, value: Recorder });
        Object.defineProperty(navigator, "mediaDevices", {
          configurable: true,
          value: {
            getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
          },
        });
      });
      const now = await page.evaluate(() => Date.now());
      await page.getByRole("button", { name: "Начать запись", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Остановить запись", exact: true }),
      ).toBeVisible();
      let recording: Awaited<ReturnType<typeof geometry>> | undefined;
      for (const elapsed of [9, 10, 59, 60, 599, 600]) {
        await page.evaluate(
          (time) => {
            Date.now = () => time;
          },
          now + elapsed * 1000,
        );
        await expect(page.locator(".composer-action-timer")).toHaveText(
          `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`,
        );
        const current = await geometry(controls);
        if (recording && elapsed < 600) unchanged(recording, current);
        recording = current;
        unchanged(before.slice(-1), current.slice(-1));
        await expectPackedActions(page);
      }
      await page.getByRole("button", { name: "Отменить запись", exact: true }).click();
      send({
        type: "voiceTranscription.upserted",
        job: {
          id: "voice",
          threadId: summary.id,
          mode: "draft",
          status: "failed",
          createdAt: now,
          startedAt: now,
          audioDurationMs: 10000,
          estimatedTotalSeconds: null,
          error: "No speech was detected in the recording",
        },
      });
      await expect(page.locator(".composer-error")).toBeVisible();
      unchanged(running, await geometry(controls));
      await expectPackedActions(page);
      expect(
        await page.locator(".composer-options").evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
    });
  }

  for (const voice of [false, true]) {
    for (const modelName of ["6astra", "Model with an unusually long display name"]) {
      test(`${mobile ? "mobile" : "desktop"}: compact ${modelName} controls with voice ${voice ? "enabled" : "unavailable"}`, async ({
        page,
      }) => {
        await page.setViewportSize(mobile ? PHONE_VIEWPORT : DESKTOP_VIEWPORT);
        const { summary, send } = await chat(page, "light", "Проверка", { modelName, voice });
        await expect(page.locator(".composer-actions > button")).toHaveCount(voice ? 3 : 1);
        await expectPackedActions(page);
        const model = page.locator(".model-toggle");
        const modelBounds = (await model.boundingBox())!;
        expect(modelBounds.width).toBeLessThanOrEqual(mobile ? 60 : 150);
        if (modelName === "6astra") {
          expect(modelBounds.width).toBeLessThan(mobile ? 60 : 100);
          expect(
            await model.locator("span").evaluate((el) => el.scrollWidth <= el.clientWidth),
          ).toBe(true);
        }
        if (voice) {
          const microphone = (await page.locator(".composer-actions > .microphone").boundingBox())!;
          expect(microphone.width).toBe(mobile ? 32 : 34);
        }
        send({
          type: "thread.upserted",
          thread: { ...summary, state: "running", currentTurnId: "running" },
        });
        await expect(
          page.getByRole("button", { name: "Остановить задачу", exact: true }),
        ).toBeVisible();
        await expectPackedActions(page);
        send({ type: "thread.upserted", thread: summary });
        await expect(
          page.getByRole("button", { name: "Остановить задачу", exact: true }),
        ).toHaveCount(0);
        await expectPackedActions(page);
      });
    }
  }

  test(`${mobile ? "mobile" : "desktop"}: queue spacing after messages, questions and finish action`, async ({
    page,
  }) => {
    await page.setViewportSize(mobile ? PHONE_VIEWPORT : DESKTOP_VIEWPORT);
    const { summary, detail, send } = await chat(page, "dark", "Короткое сообщение");
    const queue = page.locator(".outgoing-messages");
    const previousTurn = page.locator(".turn").last();
    const finish = page.locator(".finish-thread-action");
    expect(await verticalGap(previousTurn, queue)).toBe(32);
    send({ type: "thread.upserted", thread: { ...summary, unread: true } });
    await expect(finish).toBeVisible();
    expect(await verticalGap(finish, queue)).toBe(16);
    await page.route("https://images.example/queue.svg", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90"><rect width="120" height="90" fill="gray"/></svg>',
      }),
    );
    const messages = [
      detail.queuedMessages[0]!,
      { ...detail.queuedMessages[0]!, id: "queued-long", text: messageText },
      {
        ...detail.queuedMessages[0]!,
        id: "queued-image",
        text: "![Пример](https://images.example/queue.svg)",
      },
    ];
    send({ type: "queue.changed", threadId: summary.id, messages });
    const cards = queue.locator(".queued-message");
    await expect(cards).toHaveCount(3);
    await expect(cards.last().locator("img")).toBeVisible();
    const checkSpacing = async () => {
      for (let index = 0; index < 3; index++) {
        const card = cards.nth(index);
        expect(
          await verticalGap(card.locator(".message-body"), card.locator(".message-footer")),
        ).toBe(5);
        if (index > 0) expect(await verticalGap(cards.nth(index - 1), card)).toBe(16);
      }
    };
    await checkSpacing();
    await cards
      .first()
      .getByRole("button", { name: "Изменить сообщение в очереди", exact: true })
      .click();
    await expect(cards.first().getByRole("textbox")).toBeVisible();
    await checkSpacing();
    await cards.first().getByRole("button", { name: "Отмена", exact: true }).click();
    send({ type: "thread.upserted", thread: summary });
    await expect(finish).toHaveCount(0);
    expect(await verticalGap(previousTurn, queue)).toBe(32);
    const attention = { ...snapshot.attention[0]!, threadId: summary.id };
    send({ type: "attention.upserted", attention });
    const questions = page.locator(".attention-stack");
    await expect(questions).toBeVisible();
    expect(await verticalGap(questions, queue)).toBe(16);
    send({ type: "attention.removed", attentionId: attention.id });
    await expect(questions).toHaveCount(0);
    send({ type: "thread.upserted", thread: { ...summary, unread: true } });
    await expect(finish).toBeVisible();
    send({ type: "queue.changed", threadId: summary.id, messages: [] });
    await expect(queue).toHaveCount(0);
    await expect(finish).toHaveCSS("margin-bottom", "0px");
    await expect(finish).toHaveCSS("margin-top", "24px");
  });

  test(`${mobile ? "mobile" : "desktop"}: settings and fork loading keep their controls anchored`, async ({
    page,
  }) => {
    await page.setViewportSize(mobile ? PHONE_VIEWPORT : DESKTOP_VIEWPORT);
    await installVisualFixture(page, { theme: "light" });
    const loading = deferred();
    await page.route("**/api/v1/settings/codex", async (route) => {
      await loading.promise;
      return route.fallback();
    });
    await page.goto("/settings?section=maintenance");
    const card = page.locator(".codex-settings-card").first();
    await expect(card.locator(".settings-group-body")).toHaveAttribute("aria-busy", "true");
    await waitForVisualReady(page);
    const actions = card.locator(".settings-actions button");
    const initial = await geometry(actions);
    loading.resolve();
    await expect(card.locator(".settings-group-body")).not.toHaveAttribute("aria-busy");
    unchanged(initial, await geometry(actions));
    const checking = deferred();
    await page.route("**/api/v1/settings/app/check", async (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback();
      await checking.promise;
      return json(route, { error: "Fixture failure" }, 500);
    });
    const app = page.locator(".application-settings-card");
    const appActions = app.locator(".settings-actions > *");
    await appActions.last().scrollIntoViewIfNeeded();
    const before = await geometry(appActions);
    await app.getByRole("button", { name: "Проверить обновления", exact: true }).click();
    await expect(app.getByRole("button", { name: "Проверяем…", exact: true })).toBeVisible();
    unchanged(before, await geometry(appActions));
    checking.resolve();
    await expect(app.getByRole("alert")).toBeVisible();
    unchanged(before, await geometry(appActions));
    const restarting = deferred();
    await page.route("**/api/v1/settings/codex/force-restart", async (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback();
      await restarting.promise;
      return json(route, {});
    });
    const recovery = page.locator(".recovery-settings-card");
    const recoveryActions = recovery.locator(".settings-actions button");
    await recoveryActions.last().scrollIntoViewIfNeeded();
    const recoveryBefore = await geometry(recoveryActions);
    page.once("dialog", (dialog) => dialog.accept());
    await recovery.getByRole("button", { name: "Жёстко перезапустить Codex", exact: true }).click();
    await expect(
      recovery.getByRole("button", { name: "Перезапускаем Codex…", exact: true }),
    ).toBeVisible();
    unchanged(recoveryBefore, await geometry(recoveryActions));
    restarting.resolve();
    await expect(recovery.getByText("Codex daemon аварийно перезапущен.")).toBeVisible();
    unchanged(recoveryBefore, await geometry(recoveryActions));
    await page.goto("/threads/session-main");
    const estimate = deferred();
    await page.route("**/fork-estimate", async (route) => {
      await estimate.promise;
      return route.fallback();
    });
    await page.getByRole("button", { name: "Создать ответвление отсюда" }).click();
    const dialog = page.getByRole("dialog", { name: "Создать ветку" });
    await expect(dialog.getByText("Считаем…").first()).toBeVisible();
    const chrome = dialog.locator(".dialog-header,.fork-dialog-actions");
    const pending = await geometry(chrome);
    estimate.resolve();
    await expect(dialog.getByText("Считаем…")).toHaveCount(0);
    unchanged(pending, await geometry(chrome));
  });
}

test("sidebar typography and actual title animation use fixed geometry and speed", async ({
  page,
}) => {
  const seed = structuredClone(snapshot);
  seed.threads.find((thread) => thread.id === mainThread.id)!.title =
    "Очень длинное название сессии для проверки одинаковой скорости движения текста";
  await installVisualFixture(page, { theme: "dark", snapshot: seed });
  await page.goto("/threads/session-main");
  await waitForVisualReady(page);
  const fonts = await page.locator(".sidebar-control-action").evaluateAll((elements) =>
    elements.map((el) => {
      const s = getComputedStyle(el);
      return [s.fontSize, s.lineHeight, s.fontFamily];
    }),
  );
  expect(new Set(fonts.map((font) => JSON.stringify(font))).size).toBe(1);
  expect(fonts[0]![0]).toBe("14px");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => document.querySelector("style[data-visual-test-motion]")?.remove());
  const row = page.locator('a[href="/threads/session-main"]').locator("..");
  const title = row.locator(".thread-link-title");
  const before = await geometry(title);
  await title.hover();
  const speed = await title.evaluate((el) => {
    const animation = el.getAnimations()[0]!;
    animation.pause();
    animation.currentTime = 0;
    const start = parseFloat(getComputedStyle(el).textIndent);
    animation.currentTime = 200;
    const end = parseFloat(getComputedStyle(el).textIndent);
    return Math.abs(end - start) / 0.2;
  });
  expect(speed).toBeCloseTo(45, 1);
  unchanged(before, await geometry(title));
  const rowBefore = await geometry(row);
  await row.locator("summary").click();
  unchanged(rowBefore, await geometry(row));
  await page.keyboard.press("Escape");
  await expect(row.locator("summary")).toBeFocused();
  unchanged(before, await geometry(title));
});

test.describe("compact mobile controls", () => {
  test.use({ hasTouch: true });

  for (const width of [320, 360, 390, 412]) {
    test(`one toolbar row at ${width}px with a reduced viewport`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const { summary, send } = await chat(page, "dark", "Проверка");
      await page.locator(".composer-box textarea").focus();
      send({
        type: "thread.upserted",
        thread: { ...summary, state: "running", currentTurnId: "running" },
      });
      await expect(
        page.getByRole("button", { name: "Остановить задачу", exact: true }),
      ).toBeVisible();
      for (const height of [844, 520]) {
        await page.setViewportSize({ width, height });
        const toolbar = (await page.locator(".composer-toolbar").boundingBox())!;
        const buttons = await geometry(
          page.locator(".composer-add-image,.settings-picker > button,.composer-actions > button"),
        );
        expect(buttons).toHaveLength(9);
        expect(toolbar.height).toBeLessThanOrEqual(48);
        for (const button of buttons) {
          expect(button.y).toBeCloseTo(buttons[0]!.y, 0);
          expect(button.x).toBeGreaterThanOrEqual(toolbar.x);
          expect(button.x + button.width).toBeLessThanOrEqual(toolbar.x + toolbar.width);
          expect(button.width).toBeGreaterThanOrEqual(32);
        }
      }
    });
  }

  test("session titles use the space up to the menu when markers are absent", async ({ page }) => {
    await page.setViewportSize(PHONE_VIEWPORT);
    await installVisualFixture(page, { theme: "dark" });
    await page.goto("/threads/session-active");
    await page.getByRole("button", { name: "Открыть список задач" }).click();
    await page.getByRole("button", { name: "Активные", exact: true }).click();
    const row = page
      .locator('.active-session-list a[href="/threads/session-active"]')
      .locator("..");
    const title = row.locator(".thread-link-title");
    const before = (await title.boundingBox())!;
    const trigger = (await row.locator("summary").boundingBox())!;
    expect(trigger.x - before.x - before.width).toBeLessThanOrEqual(5);
    await row.locator("summary").click();
    const expanded = (await title.boundingBox())!;
    const actions = (await row.locator(".thread-row-actions").boundingBox())!;
    expect(expanded.x).toBe(before.x);
    expect(expanded.width).toBeLessThan(before.width);
    expect(expanded.x + expanded.width).toBeLessThanOrEqual(actions.x);
    await page.keyboard.press("Escape");
    expect(await title.boundingBox()).toEqual(before);
  });
});

test("image loading and retry keep preview frames and following content stationary", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1800 });
  const image = deferred();
  let failImage = true;
  await page.route("https://image.test/preview.svg", async (route) => {
    await image.promise;
    if (failImage) return route.abort();
    await route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="240"><rect width="80" height="240" fill="#888"/></svg>',
    });
  });
  await chat(page, "light", "![Превью](https://image.test/preview.svg)\n\nТекст под изображением.");
  const frames = page.locator(".markdown-image-preview,.markdown-image-state");
  await expect(frames).toHaveCount(2);
  const paragraphs = page.getByText("Текст под изображением.", { exact: true });
  const following = await geometry(paragraphs);
  const before = await geometry(frames);
  image.resolve();
  await expect(page.locator(".markdown-image-retry")).toHaveCount(2);
  unchanged(before, await geometry(frames));
  unchanged(following, await geometry(paragraphs));
  failImage = false;
  for (let remaining = 2; remaining > 0; remaining--) {
    await page.locator(".markdown-image-retry").first().click();
    await expect(page.locator(".markdown-image-retry")).toHaveCount(remaining - 1);
  }
  await expect
    .poll(() =>
      frames
        .locator("img")
        .evaluateAll((images) =>
          images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
        ),
    )
    .toBe(true);
  unchanged(before, await geometry(frames));
  unchanged(following, await geometry(paragraphs));
  for (const frame of before) expect(frame.width / frame.height).toBeCloseTo(4 / 3, 2);
});

for (const mobile of [false, true]) {
  test(`${mobile ? "mobile" : "desktop"}: English busy labels keep adjacent actions stationary`, async ({
    page,
  }) => {
    await page.setViewportSize(mobile ? PHONE_VIEWPORT : DESKTOP_VIEWPORT);
    await installVisualFixture(page, {
      theme: "light",
      snapshot: { ...snapshot, uiLanguage: "en" },
    });
    const checking = deferred();
    await page.route("**/api/v1/settings/app/check", async (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback();
      await checking.promise;
      return json(route, { error: "Fixture failure" }, 500);
    });
    await page.goto("/settings?section=maintenance");
    const card = page.locator(".application-settings-card");
    const check = card.getByRole("button", { name: "Check for updates", exact: true });
    await expect(check).toBeEnabled();
    await card.locator(".settings-actions > *").last().scrollIntoViewIfNeeded();
    const controls = card.locator(".settings-actions > *");
    const before = await geometry(controls);
    await check.click();
    await expect(card.getByRole("button", { name: "Checking…", exact: true })).toBeVisible();
    unchanged(before, await geometry(controls));
    checking.resolve();
    await expect(card.getByRole("alert")).toBeVisible();
    unchanged(before, await geometry(controls));
  });

  test(`${mobile ? "mobile" : "desktop"}: background updates preserve the reader's scroll position`, async ({
    page,
  }) => {
    await page.setViewportSize(mobile ? PHONE_VIEWPORT : DESKTOP_VIEWPORT);
    const { summary, send } = await chat(page, "light", (messageText + "\n\n").repeat(12));
    const scroll = page.locator(".conversation-scroll");
    await scroll.evaluate((element) => {
      element.dispatchEvent(new WheelEvent("wheel", { deltaY: -500, bubbles: true }));
      element.scrollTop = 250;
    });
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(250);
    const before = await geometry(
      page.locator(
        '.workspace-header,.composer-toolbar,[data-message-id="original"] > .message-body',
      ),
    );
    send({
      type: "thread.upserted",
      thread: {
        ...summary,
        state: "running",
        currentTurnId: "new-turn",
        updatedAt: summary.updatedAt + 1,
      },
    });
    send({
      type: "turn.replaced",
      threadId: summary.id,
      turn: turn("new-turn", "Новое сообщение в конце истории."),
    });
    await expect(page.getByText("Новое сообщение в конце истории.", { exact: true })).toHaveCount(
      1,
    );
    await waitForVisualReady(page);
    expect(await scroll.evaluate((element) => element.scrollTop)).toBe(250);
    unchanged(
      before,
      await geometry(
        page.locator(
          '.workspace-header,.composer-toolbar,[data-message-id="original"] > .message-body',
        ),
      ),
    );
  });
}
