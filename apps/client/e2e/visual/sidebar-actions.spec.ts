import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { installVisualFixture, snapshot, waitForVisualReady, PHONE_VIEWPORT } from "./fixtures";

async function openSidebar(page: Page, theme: "light" | "dark", pinnedCount?: number) {
  const seed = structuredClone(snapshot);
  if (pinnedCount !== undefined) {
    const main = seed.threads.find((thread) => thread.id === "session-main")!;
    main.pinned = pinnedCount > 0;
    for (let index = 1; index < pinnedCount; index++) {
      const id = `extra-pin-${index}`;
      seed.threads.push({ ...main, id, relation: { kind: "session", sessionId: id } });
    }
  }
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

async function modeButtonBounds(page: Page) {
  return page.locator(".session-list-mode button").evaluateAll((buttons) =>
    buttons.map((button) => {
      const { x, y, width, height } = button.getBoundingClientRect();
      return { x, y, width, height };
    }),
  );
}

for (const theme of ["light", "dark"] as const) {
  test(`desktop ${theme} active alignment, hover actions and pin persistence`, async ({ page }) => {
    await openSidebar(page, theme);
    const switcher = page.locator(".session-list-mode");
    const switcherBefore = await switcher.boundingBox();
    const buttonsBefore = await modeButtonBounds(page);
    const navBefore = await page.locator(".thread-nav").boundingBox();
    await page.getByRole("button", { name: "Активные", exact: true }).click();
    expect(await switcher.boundingBox()).toEqual(switcherBefore);
    expect(await modeButtonBounds(page)).toEqual(buttonsBefore);
    expect(await page.locator(".thread-nav").boundingBox()).toEqual(navBefore);
    const roots = page.locator(
      ".active-session-list > .thread-branch > .thread-branch-row, .active-pinned-sessions > .thread-branch > .thread-branch-row",
    );
    const row = roots.filter({ has: page.locator('a[href="/threads/session-main"]') });
    await expect(roots.first()).toContainText("Полировка мастерской");
    const topRowBounds = await row.boundingBox();
    expect(topRowBounds!.y).toBe(navBefore!.y + 8);
    expect(topRowBounds!.height).toBe(42);
    const collapse = page.locator(".pinned-group-toggle");
    await expect(collapse).toHaveAccessibleName("Свернуть закрепленные (1)");
    await collapse.focus();
    await page.keyboard.press("Enter");
    await expect(row).toBeHidden();
    await expect(collapse).toHaveAttribute("aria-expanded", "false");
    expect(await switcher.boundingBox()).toEqual(switcherBefore);
    expect(await modeButtonBounds(page)).toEqual(buttonsBefore);
    const ordinary = page.locator('a[href="/threads/session-active"]');
    expect((await ordinary.boundingBox())!.y).toBe(topRowBounds!.y);
    await expect(page.locator(".sidebar")).toHaveScreenshot(
      `sidebar-pinned-collapsed-${theme}.png`,
      {
        maxDiffPixelRatio: 0,
      },
    );
    await page.keyboard.press("Tab");
    await expect(ordinary).toBeFocused();
    await page.getByRole("button", { name: "Проекты", exact: true }).click();
    await expect(collapse).toBeVisible();
    await page.getByRole("button", { name: "Активные", exact: true }).click();
    await expect(collapse).toHaveAttribute("aria-expanded", "false");
    await expect(row).toBeHidden();
    await collapse.focus();
    await page.keyboard.press("Space");
    await expect(row).toBeVisible();
    await expect(collapse).toHaveAttribute("aria-expanded", "true");
    const title = row.locator(".thread-link-title");
    const expectedLeft = await page
      .locator(".sidebar-control-action svg")
      .first()
      .evaluate((element) => element.getBoundingClientRect().left);
    expect(await title.evaluate((element) => element.getBoundingClientRect().left)).toBe(
      expectedLeft,
    );
    const before = await title.boundingBox();
    const plainRow = roots.filter({ has: page.locator('a[href="/threads/session-active"]') });
    const plainTitleBounds = await plainRow.locator(".thread-link-title").boundingBox();
    const plainStatusBounds = await plainRow.locator(".status").boundingBox();
    expect(
      plainStatusBounds!.x - (plainTitleBounds!.x + plainTitleBounds!.width),
    ).toBeLessThanOrEqual(16);
    const create = row.getByRole("button", { name: "Создать новую сессию в проекте CodexNest" });
    const pin = row.getByRole("button", { name: "Открепить сессию «Полировка мастерской»" });
    const trigger = row.getByLabel("Действия с сессией «Полировка мастерской»");
    const menu = row.locator(".thread-row-menu");
    await expect(trigger).toHaveCSS("opacity", "0");
    await expect(create).toBeHidden();
    await expect(pin).toBeHidden();
    const restingPin = await row.locator(".thread-pinned-marker").boundingBox();
    expect(before!.x + before!.width).toBeLessThanOrEqual(restingPin!.x);
    expect(restingPin!.x - (before!.x + before!.width)).toBeLessThanOrEqual(12);
    await trigger.focus();
    await expect(trigger).toHaveCSS("opacity", "1");
    await title.hover();
    const hovered = await title.boundingBox();
    expect(hovered!.x).toBe(before!.x);
    expect(hovered!.width).toBeLessThan(before!.width);
    const triggerBounds = await trigger.boundingBox();
    expect(hovered!.x + hovered!.width).toBeLessThanOrEqual(triggerBounds!.x);
    const statusBounds = await row.locator(".status").boundingBox();
    expect(triggerBounds!.x + triggerBounds!.width).toBeLessThanOrEqual(statusBounds!.x);
    await expect(create).toBeHidden();
    await trigger.click();
    await expect(create).toBeVisible();
    await expect(pin).toBeVisible();
    await expect(trigger).toBeHidden();
    expect(await row.boundingBox()).toEqual(topRowBounds);
    expect(await row.locator(".status").boundingBox()).toEqual(statusBounds);
    const actions = row.locator(".thread-row-actions");
    const actionBounds = (await actions.boundingBox())!;
    const expandedTitle = (await title.boundingBox())!;
    expect(expandedTitle.x + expandedTitle.width).toBeLessThanOrEqual(actionBounds.x);
    expect(actionBounds.x + actionBounds.width).toBeLessThanOrEqual(statusBounds!.x);
    await page.getByRole("button", { name: "Активные", exact: true }).hover();
    await expect(menu).not.toHaveAttribute("open");
    await expect(trigger).toHaveCSS("opacity", "0");
    await expect(create).toBeHidden();
    expect(await title.boundingBox()).toEqual(before);
    await title.hover();
    await expect(trigger).toHaveCSS("opacity", "1");
    await expect(create).toBeHidden();
    await trigger.click();
    await expect(page.locator(".sidebar")).toHaveScreenshot(`sidebar-active-${theme}.png`, {
      maxDiffPixelRatio: 0,
    });
    expect((await new AxeBuilder({ page }).include(".sidebar").analyze()).violations).toEqual([]);

    await page.keyboard.press("Escape");
    await expect(create).toBeHidden();
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(create).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(pin).toBeFocused();
    await page.getByRole("button", { name: "Активные", exact: true }).hover();
    await expect(pin).toBeFocused();
    await expect(menu).toHaveAttribute("open", "");
    await page.keyboard.press("Tab");
    await expect(menu).not.toHaveAttribute("open");
    await trigger.focus();
    await page.keyboard.press("Space");
    await expect(create).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await trigger.evaluate((element) => (element as HTMLElement).blur());
    await page.getByRole("button", { name: "Активные", exact: true }).hover();
    expect(await title.boundingBox()).toEqual(before);

    await title.hover();
    await trigger.click();
    await pin.click();
    await expect(row).toHaveCount(0);
    await expect(collapse).toHaveText(/0$/);
    expect(await switcher.boundingBox()).toEqual(switcherBefore);
    expect(await modeButtonBounds(page)).toEqual(buttonsBefore);
    await page.getByRole("button", { name: "Проекты", exact: true }).click();
    await page.getByLabel("Действия с сессией «Полировка мастерской»").focus();
    await page.getByLabel("Действия с сессией «Полировка мастерской»").click();
    await page.getByRole("button", { name: "Закрепить сессию «Полировка мастерской»" }).click();
    await page.getByRole("button", { name: "Активные", exact: true }).click();
    await expect(roots.first()).toContainText("Полировка мастерской");
    await page.reload();
    await page.getByRole("button", { name: "Активные", exact: true }).click();
    await expect(roots.first()).toContainText("Полировка мастерской");
    await row.locator(".thread-link").hover();
    await trigger.click();
    await create.click();
    await expect(page.getByRole("heading", { name: "Новая задача", exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/threads\/created-session|\/new\?projectId=project-nest/);
  });
}

for (const count of [0, 1, 12]) {
  test(`keeps each mode button fixed in a narrow sidebar with ${count} pins`, async ({ page }) => {
    await openSidebar(page, "light", count);
    await page.locator(".sidebar").evaluate((element) => {
      (element as HTMLElement).style.width = "240px";
    });
    const switcher = page.locator(".session-list-mode");
    const before = await switcher.boundingBox();
    const buttonsBefore = await modeButtonBounds(page);
    expect(buttonsBefore).toHaveLength(3);
    expect(buttonsBefore[0]!.width).toBe(buttonsBefore[1]!.width);
    const pinned = page.locator(".pinned-group-toggle");
    await pinned.click();
    expect(await switcher.boundingBox()).toEqual(before);
    expect(await modeButtonBounds(page)).toEqual(buttonsBefore);
    await expect(page.getByRole("button", { name: "Активные", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(pinned).toHaveAttribute("aria-expanded", String(count > 0));
    await pinned.click();
    await expect(pinned).toHaveAttribute("aria-expanded", "false");
    await page.getByRole("button", { name: "Проекты", exact: true }).click();
    expect(await modeButtonBounds(page)).toEqual(buttonsBefore);
    await pinned.click();
    await expect(pinned).toHaveAttribute("aria-expanded", String(count > 0));
    expect(await modeButtonBounds(page)).toEqual(buttonsBefore);
    expect(
      await switcher.locator("button").evaluateAll((buttons) =>
        buttons.every((button) => {
          const bounds = button.getBoundingClientRect();
          const parent = button.parentElement!.getBoundingClientRect();
          return (
            bounds.left >= parent.left &&
            bounds.right <= parent.right &&
            bounds.top >= parent.top &&
            bounds.bottom <= parent.bottom &&
            button.scrollWidth <= button.clientWidth
          );
        }),
      ),
    ).toBe(true);
  });
}

test.describe("touch sidebar actions", () => {
  test.use({ hasTouch: true, viewport: PHONE_VIEWPORT });

  test("fits all three actions in the session row and keeps finish confirmation actionable", async ({
    page,
  }) => {
    await installVisualFixture(page, { theme: "dark", finishableSidebar: true });
    await page.goto("/threads/session-active");
    await waitForVisualReady(page);
    await page.getByRole("button", { name: "Открыть список задач" }).tap();
    await page.locator(".pinned-group-toggle").tap();
    const row = page
      .locator(".thread-branch-row")
      .filter({ has: page.locator('a[href="/threads/session-main"]') });
    const before = await row.boundingBox();
    const status = await row.locator(".status").boundingBox();
    await row.getByLabel("Действия с сессией «Полировка мастерской»").tap();
    const actions = row.locator(".thread-row-actions");
    await expect(actions.locator("button")).toHaveCount(3);
    const bounds = (await actions.boundingBox())!;
    const title = (await row.locator(".thread-link-title").boundingBox())!;
    expect(await row.boundingBox()).toEqual(before);
    expect(await row.locator(".status").boundingBox()).toEqual(status);
    expect(title.width).toBeGreaterThan(0);
    expect(title.x + title.width).toBeLessThanOrEqual(bounds.x);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(status!.x);
    for (const button of await actions.locator("button").all()) {
      const box = (await button.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.y).toBeGreaterThanOrEqual(before!.y);
      expect(box.y + box.height).toBeLessThanOrEqual(before!.y + before!.height);
    }
    const finish = row.getByRole("button", { name: "Закончить сессию «Полировка мастерской»" });
    await finish.tap();
    await expect(finish).toHaveClass(/confirming/);
    await expect(page.locator(".sidebar")).toHaveScreenshot("sidebar-touch-finish-dark.png");
    expect((await new AxeBuilder({ page }).include(".sidebar").analyze()).violations).toEqual([]);
    await page.locator(".server-status").tap();
    await row.getByLabel("Действия с сессией «Полировка мастерской»").tap();
    await expect(finish).not.toHaveClass(/confirming/);
  });

  test("opens inline actions, pins without navigation and creates in the same project", async ({
    page,
  }) => {
    await openSidebar(page, "light");
    await page.getByRole("button", { name: "Открыть список задач" }).click();
    const switcher = page.locator(".session-list-mode");
    const switcherBefore = await switcher.boundingBox();
    const buttonsBefore = await modeButtonBounds(page);
    await page.getByRole("button", { name: "Активные", exact: true }).click();
    expect(await switcher.boundingBox()).toEqual(switcherBefore);
    expect(await modeButtonBounds(page)).toEqual(buttonsBefore);
    const collapse = page.locator(".pinned-group-toggle");
    expect((await collapse.boundingBox())!.height).toBeGreaterThanOrEqual(32);
    await collapse.tap();
    await expect(page.locator(".active-pinned-sessions")).toBeHidden();
    expect(await switcher.boundingBox()).toEqual(switcherBefore);
    expect(await modeButtonBounds(page)).toEqual(buttonsBefore);
    await collapse.tap();
    await expect(page.locator(".active-pinned-sessions")).toBeVisible();
    const trigger = page.getByLabel("Действия с сессией «Полировка мастерской»");
    const menu = trigger.locator("..");
    await expect(menu.locator(".thread-row-actions")).toBeHidden();
    const touchBounds = await trigger.boundingBox();
    expect(touchBounds!.width).toBeGreaterThanOrEqual(44);
    expect(touchBounds!.height).toBeGreaterThanOrEqual(44);
    const row = menu.locator("..");
    const rowBefore = await row.boundingBox();
    await trigger.tap();
    await expect(menu.locator(".thread-row-actions")).toBeVisible();
    await expect(trigger).toBeHidden();
    expect(await row.boundingBox()).toEqual(rowBefore);
    for (const button of await menu.locator("button").all()) {
      const bounds = (await button.boundingBox())!;
      expect(bounds.width).toBeGreaterThanOrEqual(44);
      expect(bounds.height).toBeGreaterThanOrEqual(44);
      expect(bounds.y).toBeGreaterThanOrEqual(rowBefore!.y);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(rowBefore!.y + rowBefore!.height);
    }
    await expect(page).toHaveURL(/\/threads\/session-active$/);
    await expect(page.locator(".sidebar")).toHaveScreenshot("sidebar-touch-actions.png", {
      maxDiffPixelRatio: 0,
    });
    expect((await new AxeBuilder({ page }).include(".sidebar").analyze()).violations).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(menu.locator(".thread-row-actions")).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.tap();
    await page.locator(".server-status").tap();
    await expect(menu.locator(".thread-row-actions")).toBeHidden();
    await expect(trigger).toBeVisible();
    await trigger.tap();
    await menu.getByRole("button", { name: "Открепить сессию «Полировка мастерской»" }).tap();
    await expect(trigger).toHaveCount(0);
    await expect(page).toHaveURL(/\/threads\/session-active$/);
    await page.getByRole("button", { name: "Проекты", exact: true }).tap();
    await trigger.tap();
    await menu.getByRole("button", { name: "Закрепить сессию «Полировка мастерской»" }).tap();
    await expect(menu.locator(".thread-row-actions")).toBeHidden();
    await page.getByRole("button", { name: "Активные", exact: true }).tap();
    await trigger.tap();
    await menu.getByRole("button", { name: "Создать новую сессию в проекте CodexNest" }).tap();
    await expect(page.getByRole("heading", { name: "Новая задача", exact: true })).toBeVisible();
    await expect(page.locator(".sidebar")).not.toHaveClass(/open/);
  });
});
