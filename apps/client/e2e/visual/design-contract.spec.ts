import { expect, test } from "@playwright/test";

import { installVisualFixture, snapshot, waitForVisualReady } from "./fixtures";

for (const width of [320, 390, 610, 1440]) {
  for (const language of ["ru", "en"] as const) {
    for (const theme of ["light", "dark"] as const) {
      test(`fork at ${width}px, ${language}, ${theme}: readable metrics and anchored actions`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: width < 610 ? 640 : 1000 });
        const seed = structuredClone(snapshot);
        seed.uiLanguage = language;
        const sourceTitle = "Длинное название / A long source title ".repeat(5).trim();
        seed.threads.find((thread) => thread.id === "session-main")!.title = sourceTitle;
        // Cover a failed estimate as well as the ready result in each theme and locale.
        await installVisualFixture(page, {
          theme,
          snapshot: seed,
          forkEstimate: width === 390 ? "failure" : "ready",
        });
        let release!: () => void;
        const pending = new Promise<void>((resolve) => {
          release = resolve;
        });
        await page.route("**/fork-estimate", async (route) => {
          if (route.request().method() === "OPTIONS") return route.fallback();
          await pending;
          return route.fallback();
        });
        await page.goto("/threads/session-main");
        await page
          .getByRole("button", {
            name: language === "ru" ? "Создать ответвление отсюда" : "Fork from here",
            exact: true,
          })
          .click();
        const dialog = page.locator(".fork-dialog");
        await expect(dialog.locator(".fork-source-copy strong")).toHaveText(sourceTitle);
        const loading = dialog.getByText(language === "ru" ? "Считаем…" : "Calculating…", {
          exact: true,
        });
        await expect(loading.first()).toBeVisible();
        await waitForVisualReady(page);
        const chrome = dialog.locator(".dialog-header,.fork-dialog-actions");
        const geometry = () =>
          chrome.evaluateAll((elements) =>
            elements.map((element) => {
              const { x, y, width, height } = element.getBoundingClientRect();
              return { x, y, width, height };
            }),
          );
        const before = await geometry();
        const expectCompact = async () => {
          const body = (await dialog.locator(".fork-dialog-body").boundingBox())!;
          const choices = (await dialog.locator(".fork-mode-options").boundingBox())!;
          const actions = (await dialog.locator(".fork-dialog-actions").boundingBox())!;
          const contentEnd = Math.min(body.y + body.height, choices.y + choices.height);
          expect(actions.y - contentEnd).toBeCloseTo(16, 0);
        };
        await expectCompact();
        release();
        await expect(loading).toHaveCount(0);
        expect(await geometry()).toEqual(before);
        await expectCompact();
        await expect(dialog.locator(".fork-dialog-actions .primary")).toBeEnabled();
        await expect(dialog.locator(".fork-mode-metrics small").first()).toHaveCSS(
          "font-size",
          "11px",
        );
        const metrics = dialog.locator(".fork-mode-metrics");
        await expect(metrics.first()).toHaveCSS("font-size", "12px");
        for (const card of await dialog.locator(".fork-mode-card").all()) {
          const description = (await card.locator(".fork-mode-description").boundingBox())!;
          const values = card.locator(".fork-mode-metrics");
          const bounds = (await values.boundingBox())!;
          expect(bounds.y).toBeGreaterThanOrEqual(description.y + description.height);
          expect(await values.locator(":scope > span").count()).toBe(2);
        }
        expect(
          await dialog
            .locator(".fork-dialog-body,.fork-mode-metrics > span")
            .evaluateAll((items) => items.every((item) => item.scrollWidth <= item.clientWidth)),
        ).toBe(true);
        const actions = (await dialog.locator(".fork-dialog-actions").boundingBox())!;
        expect(actions.y + actions.height).toBeLessThanOrEqual(page.viewportSize()!.height);
        if (width === 320 || width === 1440) {
          await page.setViewportSize({ width, height: 360 });
          await expectCompact();
          const header = (await dialog.locator(".dialog-header").boundingBox())!;
          const footer = (await dialog.locator(".fork-dialog-actions").boundingBox())!;
          expect(header.y).toBeGreaterThanOrEqual(0);
          expect(footer.y + footer.height).toBeLessThanOrEqual(360);
          expect(
            await dialog
              .locator(".fork-dialog-body")
              .evaluate((body) => body.scrollHeight > body.clientHeight),
          ).toBe(true);
          await dialog.locator(".fork-mode-card").last().click();
          await expect(dialog.locator('input[value="exact"]')).toBeChecked();
        }
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
      });
    }
  }
}

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: neutral native controls preserve semantic progress colors`, async ({ page }) => {
    await installVisualFixture(page, { theme });
    await page.goto("/settings?section=application");
    const checkbox = page.getByRole("checkbox").first();
    await expect(checkbox).toBeVisible();
    await expect(checkbox).toHaveCSS(
      "accent-color",
      theme === "light" ? "rgb(32, 33, 31)" : "rgb(241, 242, 239)",
    );
    await checkbox.focus();
    await expect(checkbox).toHaveCSS("outline-style", "solid");
    await page.goto("/threads/session-main");
    await expect(page.locator('.plan-checklist input[type="checkbox"]').first()).toHaveCSS(
      "accent-color",
      theme === "light" ? "rgb(43, 162, 76)" : "rgb(90, 200, 120)",
    );
  });
}
