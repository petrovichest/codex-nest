import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ThreadDetail } from "@codexnest/protocol";

import { installVisualFixture, mainThread, snapshot, waitForVisualReady } from "./fixtures";

const messageText = "По ширине. Именно блок с кнопками «Настройки» и блок переключения разделов.";

async function openQueue(page: Page, theme: "light" | "dark") {
  const summary = { ...mainThread, state: "completed" as const, currentTurnId: null };
  const seed = structuredClone(snapshot);
  seed.attention = [];
  seed.threads = [summary];
  const detail: ThreadDetail = {
    summary,
    turns: [],
    olderTurnsCursor: null,
    draft: null,
    queuedMessages: [
      { id: "first", threadId: summary.id, text: messageText, status: "queued", createdAt: 1 },
      {
        id: "second",
        threadId: summary.id,
        text: "Следующая правка",
        status: "queued",
        createdAt: 2,
      },
    ],
  };
  await installVisualFixture(page, { theme, snapshot: seed });
  await page.route("**/api/v1/threads/session-main", (route) =>
    route.fulfill({ json: detail, headers: { "access-control-allow-origin": "*" } }),
  );
  await page.goto("/threads/session-main");
  const card = page.locator('.queued-message[data-message-id="first"]');
  await card.getByRole("button", { name: "Изменить сообщение в очереди", exact: true }).click();
  await waitForVisualReady(page);
  return { card, field: card.getByRole("textbox"), detail };
}

async function height(locator: Locator) {
  return locator.evaluate((element) => element.getBoundingClientRect().height);
}

async function expectAligned(page: Page) {
  const editor = await page.locator(".queued-message-editing > .message-body").boundingBox();
  const composer = await page.locator(".composer-box").boundingBox();
  expect(editor!.x).toBeCloseTo(composer!.x, 1);
  expect(editor!.width).toBeCloseTo(composer!.width, 1);
  expect(
    await page
      .locator(".conversation-scroll")
      .evaluate((node) => node.scrollWidth - node.clientWidth),
  ).toBeLessThanOrEqual(1);
}

for (const width of [320, 390, 1440]) {
  for (const theme of ["light", "dark"] as const) {
    test(`queue editor ${width}px ${theme}: full width and content height`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const { card, field } = await openQueue(page, theme);
      await expectAligned(page);
      await expect(field).toBeFocused();
      await expect(field).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(field).toHaveCSS("outline-style", "none");
      if (width !== 320) {
        await field.fill(messageText + "!");
        await expect(card).toHaveScreenshot(`queue-editor-${width}-${theme}.png`);
      }

      await field.fill("Короткое сообщение");
      const shortHeight = await height(field);
      expect(shortHeight).toBeLessThan(27);
      expect(await height(card.locator(".message-body"))).toBeLessThan(108);
      await field.fill("Один\nДва\nТри\nЧетыре\nПять");
      expect(await height(field)).toBeGreaterThan(shortHeight * 4);
      await field.fill("Очень длинное сообщение с переносами. ".repeat(100));
      await expect.poll(() => height(field)).toBeCloseTo(240, 0);
      expect(await field.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
      await expectAligned(page);
      await field.fill("Короткое сообщение");
      await expect.poll(() => height(field)).toBeCloseTo(shortHeight, 1);
      expect(
        await page.locator('.queued-message[data-message-id="second"]').getAttribute("class"),
      ).not.toContain("queued-message-editing");

      if (width === 1440) {
        await page.getByRole("button", { name: "Показать сведения", exact: true }).click();
        await expectAligned(page);
      }
      await card.getByRole("button", { name: "Отмена", exact: true }).click();
      await expect(card.getByRole("textbox")).toHaveCount(0);
      await expect(card.locator(".queued-message-text")).toHaveText(messageText);
      expect((await card.boundingBox())!.width).toBeLessThan(
        (await page.locator(".composer-box").boundingBox())!.width,
      );
    });
  }
}

test("queue editor fallback grows, shrinks and follows width changes", async ({ page }) => {
  await page.addInitScript(() => {
    const supports = CSS.supports.bind(CSS);
    CSS.supports = (property: string, value?: string) =>
      property === "field-sizing"
        ? false
        : value === undefined
          ? supports(property)
          : supports(property, value);
  });
  await page.setViewportSize({ width: 1440, height: 844 });
  const { field } = await openQueue(page, "dark");
  await page.addStyleTag({
    content: ".queued-message-editor textarea { field-sizing: fixed !important; }",
  });
  // Fill almost one desktop line so narrowing the pane must add a line.
  const resizeText = await field.evaluate((node) => {
    const context = document.createElement("canvas").getContext("2d")!;
    const style = getComputedStyle(node);
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    return "Ш".repeat(Math.floor((node.clientWidth - 8) / context.measureText("Ш").width));
  });
  await field.fill(resizeText);
  const desktopHeight = await height(field);
  await page.getByRole("button", { name: "Показать сведения", exact: true }).click();
  await expectAligned(page);
  await expect.poll(() => height(field)).toBeGreaterThan(desktopHeight);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => height(field)).toBeGreaterThan(desktopHeight * 2);
  await field.fill("Длинное сообщение. ".repeat(150));
  await expect.poll(() => height(field)).toBeCloseTo(240, 0);
  await field.fill("Короткое");
  await expect.poll(() => height(field)).toBeLessThan(27);
  await page.setViewportSize({ width: 1440, height: 844 });
  await expectAligned(page);
});

test("queue editor preserves edits on failure and closes after saving", async ({ page }) => {
  const { card, field, detail } = await openQueue(page, "light");
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fail = true;
  await page.route("**/api/v1/threads/session-main/queue/first", async (route) => {
    if (route.request().method() === "OPTIONS") return route.fallback();
    await pending;
    const input = route.request().postDataJSON().input as string;
    if (!fail) detail.queuedMessages[0]!.text = input;
    await route.fulfill({
      status: fail ? 500 : 200,
      headers: { "access-control-allow-origin": "*" },
      json: fail
        ? { error: { code: "test_error", message: "Не удалось сохранить" } }
        : detail.queuedMessages[0],
    });
  });
  await field.fill("");
  await expect(card.getByRole("button", { name: "Сохранить", exact: true })).toBeDisabled();
  await field.fill("Исправленное сообщение");
  await card.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(field).toBeDisabled();
  await expect(card.getByRole("button", { name: "Отмена", exact: true })).toBeDisabled();
  release();
  await expect(field).toBeEnabled();
  await expect(field).toHaveValue("Исправленное сообщение");
  await expectAligned(page);
  fail = false;
  await card.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(card.getByRole("textbox")).toHaveCount(0);
  await expect(card).not.toHaveClass(/queued-message-editing/u);
});

test("queue editor remains reachable in a keyboard-sized viewport with visible focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { card, field } = await openQueue(page, "dark");
  await field.fill("Длинное сообщение. ".repeat(150));
  await page.setViewportSize({ width: 390, height: 430 });
  const save = card.getByRole("button", { name: "Сохранить", exact: true });
  await field.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const saveBox = (await save.boundingBox())!;
  const composer = (await page.locator(".composer-box").boundingBox())!;
  expect(saveBox.y).toBeGreaterThanOrEqual(0);
  expect(saveBox.y + saveBox.height).toBeLessThanOrEqual(composer.y);
  await expect(save).toBeFocused();
  await expect(save).toHaveCSS("outline-style", "solid");
  await page.emulateMedia({ forcedColors: "active" });
  await field.focus();
  await expect(card.locator(".message-body")).toHaveCSS("outline-style", "solid");
});
