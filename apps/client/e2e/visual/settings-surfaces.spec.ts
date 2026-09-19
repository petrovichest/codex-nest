import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { installVisualFixture, snapshot, waitForVisualReady } from "./fixtures";

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: settings navigation follows layout and preserves an unsaved form`, async ({
    page,
  }) => {
    await installVisualFixture(page, { theme });
    await page.goto("/settings?section=application");
    await waitForVisualReady(page);
    const tabs = page.getByRole("tablist");
    await expect(tabs).toHaveAttribute("aria-orientation", "vertical");
    const language = page.locator("#settings-language");
    await expect(language).toHaveCSS("appearance", "none");
    await expect(language).toHaveCSS("background-size", "18px 18px");
    await expect(language).toHaveCSS("background-position", "calc(100% - 12px) 50%");
    await expect(language).toHaveCSS("padding-right", "44px");
    const surface = theme === "light" ? "rgb(248, 249, 246)" : "rgb(36, 39, 34)";
    for (const element of [
      language,
      page.locator(".sidebar"),
      page.locator(".settings-group").first(),
    ]) {
      await expect(element).toHaveCSS("background-color", surface);
    }
    await expect(page).toHaveScreenshot(`settings-c-${theme}.png`);
    const order = page.locator("#settings-project-order");
    const orderBounds = await order.boundingBox();
    const restingShadow = await order.evaluate((el) => getComputedStyle(el).boxShadow);
    await order.click();
    await page.keyboard.press("Escape");
    await expect(order).toBeFocused();
    await expect(order).toHaveCSS("outline-style", "none");
    await expect(order).not.toHaveCSS("box-shadow", restingShadow);
    expect(await order.boundingBox()).toEqual(orderBounds);
    await expect(page.locator(".settings-group:visible").first()).toHaveScreenshot(
      `settings-field-focus-${theme}.png`,
    );
    await page.keyboard.press("Shift+Tab");
    await expect(order).toHaveCSS("box-shadow", restingShadow);
    await page.keyboard.press("Tab");
    await expect(order).toBeFocused();
    await expect(order).toHaveCSS("outline-style", "none");
    await expect(order).not.toHaveCSS("box-shadow", restingShadow);
    await tabs.getByRole("tab").first().focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator("#settings-section-tab-codex")).toBeFocused();
    await expect(page).toHaveURL(/section=codex/);
    await page.keyboard.press("End");
    await expect(page.locator("#settings-section-tab-maintenance")).toBeFocused();
    await page.keyboard.press("Home");
    await expect(page.locator("#settings-section-tab-application")).toBeFocused();

    const provider = page.locator("#settings-transcription-provider");
    await provider.selectOption("local");
    const address = page.locator("#settings-local-stt-url");
    await address.fill("http://unsaved.example/inference");
    const original = await address.elementHandle();
    for (const width of [1279, 820, 390, 320, 1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(tabs).toHaveAttribute(
        "aria-orientation",
        width >= 1280 ? "vertical" : "horizontal",
      );
      await expect(address).toHaveValue("http://unsaved.example/inference");
      expect(await address.evaluate((node, before) => node === before, original)).toBe(true);
      expect(
        await page.locator(".settings-scroll").evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(tabs).toHaveAttribute("aria-orientation", "horizontal");
    await tabs.getByRole("tab").first().focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#settings-section-tab-codex")).toBeFocused();
    await page.keyboard.press("Home");
    await page.mouse.move(0, 0);
    await expect(page).toHaveScreenshot(`settings-c-mobile-${theme}.png`);
    expect(
      (await new AxeBuilder({ page }).include(".settings-workspace").analyze()).violations,
    ).toEqual([]);
    await page.emulateMedia({ forcedColors: "active" });
    await order.focus();
    await expect(order).toHaveCSS("outline-style", "solid");
    await expect(order).toHaveCSS("outline-width", "2px");
  });

  for (const width of [390, 1440]) {
    test(`${theme} ${width}: compact project and search dialogs keep controls outside scrolling content`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await installVisualFixture(page, { theme });
      await page.route(/\/api\/v1\/directories(?:\?|$)/, async (route) => {
        if (route.request().method() === "OPTIONS") return route.fallback();
        await route.fulfill({
          headers: { "access-control-allow-origin": "*" },
          json: {
            rootPath: "/home/codex",
            path: "/home/codex",
            parentPath: null,
            directories: Array.from({ length: 40 }, (_, index) => ({
              name: `Проект ${index + 1} — длинное название папки`,
              path: `/home/codex/project-${index}`,
            })),
          },
        });
      });
      await page.route("**/api/v1/threads/search?*", async (route) => {
        if (route.request().method() === "OPTIONS") return route.fallback();
        await route.fulfill({
          headers: { "access-control-allow-origin": "*" },
          json: {
            data:
              new URL(route.request().url()).searchParams.get("archived") === "true"
                ? []
                : Array.from({ length: 30 }, (_, index) => ({
                    thread: {
                      ...snapshot.threads[0]!,
                      id: `result-${index}`,
                      title: `Обсуждение интерфейса ${index + 1}`,
                    },
                    snippet: "Настройки, проекты и поиск по диалогам",
                  })),
            nextCursor: null,
          },
        });
      });
      await page.goto("/threads/session-main");
      const composer = page.locator(".composer-box");
      await composer.locator("textarea").focus();
      const composerFocus = await composer.evaluate((el) => getComputedStyle(el).boxShadow);
      if (width < 821) await page.getByRole("button", { name: "Открыть список задач" }).click();
      const opener = page.getByRole("button", { name: "Добавить проект", exact: true });
      await opener.click();
      const project = page.locator(".project-browser-modal");
      await expect(project.locator(".project-directory-entry")).toHaveCount(40);
      const bounds = (await project.boundingBox())!;
      expect(bounds.width).toBe(width === 1440 ? 560 : width);
      expect(bounds.height).toBeCloseTo(width === 1440 ? 500 : 844, 0);
      const actions = project.locator(".project-browser-actions");
      const before = await actions.boundingBox();
      await project.locator(".project-directory-entry").last().scrollIntoViewIfNeeded();
      expect(await actions.boundingBox()).toEqual(before);
      await expect(actions).toBeInViewport();
      await project.locator(".project-directory-entry").first().scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
      await waitForVisualReady(page);
      await expect(project).toHaveScreenshot(`project-p2-${width}-${theme}.png`);
      expect(
        (await new AxeBuilder({ page }).include(".project-browser-modal").analyze()).violations,
      ).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(opener).toBeFocused();

      await page.getByRole("button", { name: "Поиск по диалогам", exact: true }).click();
      const search = page.locator(".thread-search-dialog");
      const input = search.getByRole("textbox");
      await expect(input).toBeFocused();
      await expect(input).toHaveCSS("outline-style", "none");
      await expect(input).toHaveCSS("box-shadow", composerFocus);
      const empty = (await search.boundingBox())!;
      if (width === 1440) {
        expect(empty.width).toBe(740);
        expect(empty.height).toBeLessThan(350);
      } else expect(empty.height).toBeCloseTo(844, 0);
      await expect(search).toHaveScreenshot(`search-s1-${width}-${theme}.png`);
      await search.getByRole("button", { name: "Закрыть" }).focus();
      await expect(input).not.toHaveCSS("box-shadow", composerFocus);
      await page.keyboard.press("Tab");
      await expect(input).toBeFocused();
      await expect(input).toHaveCSS("outline-style", "none");
      await expect(input).toHaveCSS("box-shadow", composerFocus);
      expect(await search.boundingBox()).toEqual(empty);
      await input.fill("интерфейс");
      await input.press("Enter");
      await expect(search.locator(".thread-search-result")).toHaveCount(30);
      const form = search.locator(".thread-search-form");
      const formBefore = await form.boundingBox();
      await search.locator(".thread-search-result").last().scrollIntoViewIfNeeded();
      expect(await form.boundingBox()).toEqual(formBefore);
      await expect(form).toBeInViewport();
      expect(await search.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(
        (await new AxeBuilder({ page }).include(".thread-search-dialog").analyze()).violations,
      ).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(search).toHaveCount(0);
    });
  }
}
