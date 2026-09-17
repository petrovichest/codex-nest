import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ActivityItem, ThreadDetail } from "@codexnest/protocol";

import { installVisualFixture, snapshot, waitForVisualReady } from "./fixtures";

const transparent = "rgba(0, 0, 0, 0)";
const copyText = "Готовый текст для копирования";

async function openChat(page: Page, theme: "light" | "dark") {
  const seed = structuredClone(snapshot);
  const summary = seed.threads.find((thread) => thread.id === "session-main")!;
  summary.settings.collaborationMode = "plan";
  summary.browserStatus = "disabled";
  const message = (
    id: string,
    type: "agentMessage" | "userMessage" | "plan",
    text: string,
  ): ActivityItem => ({
    id,
    type,
    text,
    status: "completed",
    images: [],
    timestamp: 1,
    phase: null,
  });
  const detail: ThreadDetail = {
    summary,
    olderTurnsCursor: null,
    queuedMessages: [],
    draft: null,
    turns: [
      {
        id: "turn-main",
        status: "completed",
        startedAt: 1,
        completedAt: 2000,
        durationMs: 1999,
        progress: {
          startedAt: 1,
          explanation: null,
          steps: [],
          filesChanged: 0,
          additions: 0,
          deletions: 0,
        },
        items: [
          message("user", "userMessage", "Покажи план"),
          message(
            "intro",
            "agentMessage",
            "Обычный ответ без общей подложки.\n\n" +
              "Пояснение остаётся на фоне чата. ".repeat(15),
          ),
          message("copy", "agentMessage", "Готовый фрагмент:\n\n```text\n" + copyText + "\n```"),
          message("plan", "plan", "# План\n\n1. Проверить оформление\n2. Проверить кнопки"),
        ],
      },
    ],
  };
  await installVisualFixture(page, { theme, snapshot: seed, reducedMotion: "no-preference" });
  await page.route("**/api/v1/threads/session-main", async (route) => {
    const method = route.request().method();
    if (method === "OPTIONS") return route.fallback();
    if (method === "PATCH") {
      summary.browserStatus = route.request().postDataJSON().browserEnabled
        ? "disconnected"
        : "disabled";
    }
    await route.fulfill({
      json: method === "PATCH" ? summary : detail,
      headers: { "access-control-allow-origin": "*" },
    });
  });
  await page.goto("http://127.0.0.1:4173/threads/session-main");
  await expect(page.locator(".implement-plan")).toHaveCount(3);
  await waitForVisualReady(page);
}

async function background(button: Locator) {
  return button.evaluate((element) => getComputedStyle(element).backgroundColor);
}

async function expectNoBorder(button: Locator) {
  expect(
    await button.evaluate((element) => {
      const style = getComputedStyle(element);
      return ["Top", "Right", "Bottom", "Left"].every(
        (side) =>
          style.getPropertyValue(`border-${side.toLowerCase()}-width`) === "0px" ||
          style.getPropertyValue(`border-${side.toLowerCase()}-color`) === "rgba(0, 0, 0, 0)",
      );
    }),
  ).toBe(true);
}

// Inspect a real pointer press without sending a command or closing its menu.
async function expectFeedback(page: Page, button: Locator, filled = false) {
  await button.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  const idle = await background(button);
  if (filled) expect(idle).not.toBe(transparent);
  else expect(idle).toBe(transparent);
  const bounds = await button.boundingBox();
  await button.hover();
  const hover = await background(button);
  expect(hover).not.toBe(idle);
  await expectNoBorder(button);
  await page.mouse.down();
  try {
    const pressed = await background(button);
    expect(pressed).not.toBe(idle);
    expect(pressed).not.toBe(hover);
    expect(await button.boundingBox()).toEqual(bounds);
    await expectNoBorder(button);
  } finally {
    await button.evaluate((element) =>
      element.addEventListener(
        "click",
        (event) => {
          event.preventDefault();
          event.stopPropagation();
        },
        { capture: true, once: true },
      ),
    );
    await page.mouse.up();
    await page.mouse.move(0, 0);
  }
  expect(await background(button)).toBe(idle);
  await expect(button).toHaveCSS("font-weight", "400");
  // Isolate the disabled CSS contract; existing component tests cover when it is set.
  await button.evaluate((element) => element.setAttribute("disabled", ""));
  await button.hover();
  expect(await background(button)).toBe(idle);
  await expectNoBorder(button);
  await button.evaluate((element) => element.removeAttribute("disabled"));
  await page.mouse.move(0, 0);
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [320, 390, 1440]) {
    test(`${theme} ${width}: plain responses, copy cards and distinct plan button states`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1000 });
      await openChat(page, theme);
      await expect(page.locator(".implement-plan").first()).toHaveCSS(
        "transition-duration",
        "0.12s, 0.12s, 0.12s",
      );
      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(
        await page
          .locator(".implement-plan")
          .first()
          .evaluate((element) =>
            getComputedStyle(element)
              .transitionDuration.split(",")
              .every((value) => parseFloat(value) <= 0.00001),
          ),
      ).toBe(true);
      await expect(page.locator(".response-surface")).toHaveCSS("display", "none");
      await expect(page.locator(".message.agentMessage").first()).toHaveCSS(
        "background-color",
        transparent,
      );
      await expect(page.locator(".message.plan")).not.toHaveCSS("box-shadow", "none");
      await expect(page.locator(".markdown-code-block")).not.toHaveCSS("box-shadow", "none");
      for (const button of await page.locator(".implement-plan").all())
        await expectFeedback(page, button, true);
      const browser = page.locator(".browser-session-status");
      await expect(browser).toHaveAttribute("aria-pressed", "false");
      await expectFeedback(page, browser);
      await browser.click();
      await expect(browser).toHaveAttribute("aria-pressed", "true");
      await expectFeedback(page, browser, true);
      await browser.click();
      await expect(browser).toHaveAttribute("aria-pressed", "false");
      await page.mouse.move(0, 0);
      expect(await background(browser)).toBe(transparent);
      await page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: async (text: string) => {
              document.documentElement.dataset.copiedText = text;
            },
          },
        });
      });
      const copy = page.getByRole("button", { name: "Копировать блок", exact: true });
      await expectFeedback(page, copy);
      await copy.click();
      await expect(page.locator("html")).toHaveAttribute("data-copied-text", copyText);
      const primary = page.locator(".implement-plan").first();
      await primary.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(primary).toBeFocused();
      await expect(primary).toHaveCSS("outline-style", "solid");
      expect(
        await page
          .locator(".conversation-scroll")
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
    });
  }

  test(`${theme}: scroll, menus, dialogs, downloads and question actions share feedback`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 620 });
    await openChat(page, theme);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator(".conversation-scroll").evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
    });
    const scroll = page.getByRole("button", { name: "Прокрутить к последнему сообщению" });
    await expect(scroll).toBeVisible();
    await expectFeedback(page, scroll);
    await scroll.click();
    await expect(scroll).toBeHidden();
    await page.locator(".thread-action-menu > summary").click();
    await expectFeedback(page, page.getByRole("button", { name: "Переименовать", exact: true }));
    await page.getByRole("button", { name: "Переименовать", exact: true }).click();
    await expectFeedback(page, page.locator(".chat-dialog button.primary"), true);
    await expectFeedback(page, page.locator(".chat-dialog .icon-button"));
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Показать сведения", exact: true }).click();
    await expectFeedback(page, page.getByRole("tab", { name: "Обзор", exact: true }), true);
    await page.getByRole("tab", { name: /Артефакты/ }).click();
    const download = page.locator(".inspector-artifact-download");
    await expectFeedback(page, download);
    await expect(download).toHaveCSS("width", "32px");
    await expect(download).toHaveCSS("height", "32px");
    await expect(download).toHaveCSS("border-radius", "50%");
    await page.goto("/threads/session-attention");
    await expect(page.locator(".attention-card")).toBeVisible();
    await expect(page.locator(".attention-card")).not.toHaveCSS("box-shadow", "none");
    await expectFeedback(page, page.locator(".attention-card button.primary"), true);
    await expectFeedback(
      page,
      page.getByRole("button", { name: "Удалить сообщение из очереди", exact: true }),
    );
  });

  test(`${theme}: touch controls show press without sticky hover`, async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 320, height: 1000 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      const page = await context.newPage();
      await openChat(page, theme);
      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(await page.evaluate(() => matchMedia("(hover: hover)").matches)).toBe(false);
      for (const button of [
        page.locator(".browser-session-status"),
        page.locator(".implement-plan").first(),
      ]) {
        await button.scrollIntoViewIfNeeded();
        await page.mouse.move(0, 0);
        const idle = await background(button);
        await button.hover();
        expect(await background(button)).toBe(idle);
        await page.mouse.down();
        try {
          expect(await background(button)).not.toBe(idle);
        } finally {
          await page.mouse.move(0, 0);
          await page.mouse.up();
        }
        expect(await background(button)).toBe(idle);
      }
    } finally {
      await context.close();
    }
  });
}
