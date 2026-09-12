import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { installVisualFixture, snapshot, waitForVisualReady, PHONE_VIEWPORT } from "./fixtures";

async function openSidebar(page: Page, theme: "light" | "dark") {
  const seed = structuredClone(snapshot);
  await installVisualFixture(page, { theme, snapshot: seed });
  await page.route("**/api/v1/threads/session-main", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const thread = seed.threads.find((candidate) => candidate.id === "session-main")!;
    thread.pinned = route.request().postDataJSON().pinned;
    await route.fulfill({
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(thread),
    });
  });
  await page.route("**/api/v1/projects/project-nest/threads", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const thread = {
      ...seed.threads[0]!,
      id: "created-session",
      title: "Новая задача",
      pinned: false,
      state: "idle" as const,
    };
    seed.threads.push(thread);
    await route.fulfill({
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ thread }),
    });
  });
  await page.goto("/threads/session-active");
  await expect(page.locator(".thread-link").first()).toBeAttached();
  await waitForVisualReady(page);
}

for (const theme of ["light", "dark"] as const) {
  test(`desktop ${theme} active alignment, hover actions and pin persistence`, async ({ page }) => {
    await openSidebar(page, theme);
    await page.getByRole("button", { name: "Активные", exact: true }).click();
    const roots = page.locator(".active-session-list > .thread-branch > .thread-branch-row");
    const row = roots.filter({ has: page.locator('a[href="/threads/session-main"]') });
    await expect(roots.first()).toContainText("Полировка мастерской");
    const title = row.locator(".thread-link-title");
    const expectedLeft = await page
      .locator(".sidebar-control-action svg")
      .first()
      .evaluate((element) => element.getBoundingClientRect().left);
    expect(await title.evaluate((element) => element.getBoundingClientRect().left)).toBe(
      expectedLeft,
    );
    const before = await title.boundingBox();
    const create = row.getByRole("button", { name: "Создать новую сессию в проекте CodexNest" });
    const pin = row.getByRole("button", { name: "Открепить сессию «Полировка мастерской»" });
    await expect(create).toHaveCSS("opacity", "0");
    await expect(pin).toHaveCSS("opacity", "1");
    await create.focus();
    await expect(create).toHaveCSS("opacity", "1");
    await title.hover();
    expect(await title.boundingBox()).toEqual(before);
    const statusBounds = await row.locator(".status").boundingBox();
    const actionBounds = await pin.boundingBox();
    expect(actionBounds!.x + actionBounds!.width).toBeLessThanOrEqual(statusBounds!.x);
    await expect(page.locator(".sidebar")).toHaveScreenshot(`sidebar-active-${theme}.png`, {
      maxDiffPixelRatio: 0,
    });
    expect((await new AxeBuilder({ page }).include(".sidebar").analyze()).violations).toEqual([]);

    await pin.click();
    await expect(row).toHaveCount(0);
    await page.getByRole("button", { name: "Проекты", exact: true }).click();
    await page.getByRole("button", { name: "Закрепить сессию «Полировка мастерской»" }).focus();
    await page.getByRole("button", { name: "Закрепить сессию «Полировка мастерской»" }).click();
    await page.getByRole("button", { name: "Активные", exact: true }).click();
    await expect(roots.first()).toContainText("Полировка мастерской");
    await page.reload();
    await page.getByRole("button", { name: "Активные", exact: true }).click();
    await expect(roots.first()).toContainText("Полировка мастерской");
    await row.locator(".thread-link").hover();
    await create.click();
    await expect(page.getByRole("heading", { name: "Новая задача", exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/threads\/created-session|\/new\?projectId=project-nest/);
  });
}

test.describe("touch sidebar actions", () => {
  test.use({ hasTouch: true, viewport: PHONE_VIEWPORT });

  test("opens a compact menu, pins without navigation and creates in the same project", async ({
    page,
  }) => {
    await openSidebar(page, "light");
    await page.getByRole("button", { name: "Открыть список задач" }).click();
    await page.getByRole("button", { name: "Активные", exact: true }).click();
    const trigger = page.getByLabel("Действия с сессией «Полировка мастерской»");
    const menu = trigger.locator("..");
    await expect(menu.locator(".thread-row-popover")).toBeHidden();
    await trigger.tap();
    await expect(menu.locator(".thread-row-popover")).toBeVisible();
    await expect(page).toHaveURL(/\/threads\/session-active$/);
    const touchBounds = await trigger.boundingBox();
    expect(touchBounds!.width).toBeGreaterThanOrEqual(44);
    expect(touchBounds!.height).toBeGreaterThanOrEqual(44);
    await expect(page.locator(".sidebar")).toHaveScreenshot("sidebar-touch-actions.png", {
      maxDiffPixelRatio: 0,
    });
    expect((await new AxeBuilder({ page }).include(".sidebar").analyze()).violations).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(menu.locator(".thread-row-popover")).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.tap();
    await menu.getByRole("button", { name: "Открепить сессию «Полировка мастерской»" }).tap();
    await expect(trigger).toHaveCount(0);
    await expect(page).toHaveURL(/\/threads\/session-active$/);
    await page.getByRole("button", { name: "Проекты", exact: true }).tap();
    await trigger.tap();
    await menu.getByRole("button", { name: "Закрепить сессию «Полировка мастерской»" }).tap();
    await expect(menu.locator(".thread-row-popover")).toBeHidden();
    await page.getByRole("button", { name: "Активные", exact: true }).tap();
    await trigger.tap();
    await menu.getByRole("button", { name: "Создать новую сессию в проекте CodexNest" }).tap();
    await expect(page.getByRole("heading", { name: "Новая задача", exact: true })).toBeVisible();
    await expect(page.locator(".sidebar")).not.toHaveClass(/open/);
  });
});
