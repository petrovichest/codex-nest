import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { installVisualFixture, snapshot, waitForVisualReady } from "./fixtures";

for (const theme of ["light", "dark"] as const) {
  for (const language of ["ru", "en"] as const) {
    for (const width of [320, 390, 1440]) {
      test(`application actions ${width} ${language} ${theme}: grouped controls fit and keep keyboard order`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 1000 });
        await installVisualFixture(page, {
          theme,
          snapshot: { ...snapshot, uiLanguage: language },
        });
        await page.route("http://127.0.0.1:4310/**", (route) => route.abort());
        await page.goto("/settings?section=maintenance");
        const card = page.locator(".application-settings-card");
        const actions = card.locator(".application-settings-actions");
        const controls = actions.locator("button, a");
        await expect(controls).toHaveCount(5);
        await expect(card.locator(".settings-group-body")).not.toHaveAttribute("aria-busy");
        await waitForVisualReady(page);

        const update = card.getByRole("group", {
          name: language === "ru" ? "Обновление" : "Update",
          exact: true,
        });
        const downloads = card.getByRole("group", {
          name: language === "ru" ? "Загрузки и ссылки" : "Downloads and links",
          exact: true,
        });
        const check = update.getByRole("button").first();
        await expect(check).toBeEnabled();
        await expect(update.getByRole("button").last()).toBeDisabled();
        await check.focus();
        for (const control of await downloads.locator("a, button").all()) {
          await page.keyboard.press("Tab");
          await expect(control).toBeFocused();
        }
        await controls.last().blur();
        await page.mouse.move(0, 0);

        for (const group of [update, downloads]) {
          const row = group.locator(".settings-actions");
          await expect(row).toHaveCSS("flex-direction", width <= 520 ? "column" : "row");
        }
        expect(
          await actions.evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
        expect(
          await controls.evaluateAll((elements) =>
            elements.every((element) => element.scrollWidth <= element.clientWidth),
          ),
        ).toBe(true);
        for (const control of await controls.all()) {
          expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(
            width <= 520 ? 44 : 40,
          );
        }
        expect(
          (await new AxeBuilder({ page }).include(".application-settings-card").analyze())
            .violations,
        ).toEqual([]);
        if (language === "ru" && width !== 320) {
          await expect(actions).toHaveScreenshot(`application-actions-${width}-${theme}.png`);
        }

        await page.addInitScript(() =>
          localStorage.setItem("codexnest.typography", JSON.stringify({ ui: 32, caption: 22 })),
        );
        await page.reload();
        await expect(check).toBeEnabled();
        await waitForVisualReady(page);
        await expect(check).toHaveCSS("font-size", "32px");
        expect(
          await actions.evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
        expect(
          await controls.evaluateAll((elements) =>
            elements.every((element) => element.scrollWidth <= element.clientWidth),
          ),
        ).toBe(true);
        expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );
      });
    }
  }
}
