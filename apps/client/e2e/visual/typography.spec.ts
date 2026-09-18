import { expect, test } from "@playwright/test";
import { installVisualFixture, snapshot, waitForVisualReady } from "./fixtures";

for (const theme of ["light", "dark"] as const) {
  for (const language of ["ru", "en"] as const) {
    for (const width of [320, 390, 820, 821, 1440]) {
      test(`typography at ${width}px, ${language}, ${theme}: content, controls and forms`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 1000 });
        await installVisualFixture(page, {
          theme,
          snapshot: { ...snapshot, uiLanguage: language },
        });
        await page.route("http://127.0.0.1:4310/**", (route) => route.abort());
        await page.goto("/threads/session-main");
        await waitForVisualReady(page);
        const message = page.locator(".message.userMessage").first();
        const input = page.locator(".composer-box textarea");
        for (const text of [message, input]) {
          await expect(text).toHaveCSS("font-size", "16px");
          await expect(text).toHaveCSS("line-height", "24px");
        }
        await expect(page.locator("body")).toHaveCSS("font-size", "16px");
        await expect(page.locator(".workspace-title h1")).toHaveCSS("font-size", "16px");
        await expect(page.locator(".workspace-title h1")).toHaveCSS("line-height", "20px");
        await expect(page.locator(".workspace-title p")).toHaveCSS("font-size", "14px");
        await expect(page.locator(".workspace-title p")).toHaveCSS(
          "line-height",
          width <= 820 ? "18px" : "20px",
        );
        await expect(page.locator(".thread-link-title").first()).toHaveCSS("font-size", "16px");
        await expect(page.locator(".session-list-mode button").first()).toHaveCSS(
          "font-size",
          "16px",
        );
        await expect(page.locator(".pinned-group-toggle")).toHaveCSS("font-size", "12px");
        await expect(page.locator(".message-footer time").first()).toHaveCSS("font-size", "12px");
        await expect(page.locator(".model-toggle")).toHaveCSS("font-size", "12px");
        await input.fill("");
        await expect
          .poll(async () => (await page.locator(".composer-box").boundingBox())!.height)
          .toBe(width <= 820 ? 86 : 94);

        await page.locator(".model-toggle").click();
        const dialog = page.getByRole("dialog");
        await expect(dialog.locator(".dialog-heading h2")).toHaveCSS("font-size", "20px");
        await expect(dialog.locator(".model-settings-option strong").first()).toHaveCSS(
          "font-size",
          "16px",
        );
        await expect(dialog.locator(".model-settings-option small").first()).toHaveCSS(
          "font-size",
          "14px",
        );
        expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        await dialog.locator(".model-settings-option").last().scrollIntoViewIfNeeded();
        await expect(dialog.locator(".model-settings-option").last()).toBeInViewport();
        await page.keyboard.press("Escape");

        await page
          .getByRole("button", { name: language === "ru" ? "Показать сведения" : "Show details" })
          .click();
        const inspector = page.locator(".session-inspector");
        await expect(inspector.locator(".inspector-list dt").first()).toHaveCSS(
          "font-size",
          "14px",
        );
        await expect(inspector.locator("dd:not(.inspector-value-technical)").first()).toHaveCSS(
          "font-size",
          "16px",
        );
        await expect(inspector.locator(".inspector-value-technical").first()).toHaveCSS(
          "font-size",
          "14px",
        );
        await expect(inspector.locator("time").first()).toHaveCSS("font-size", "12px");
        expect(await inspector.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

        await page.goto("/settings?section=application");
        await waitForVisualReady(page);
        await expect(page.locator(".settings-group-heading h2").first()).toHaveCSS(
          "font-size",
          "18px",
        );
        await expect(page.locator(".settings-row-copy label").first()).toHaveCSS(
          "font-size",
          "16px",
        );
        await expect(page.locator(".settings-row-copy p").first()).toHaveCSS("font-size", "14px");
        expect(
          await page
            .locator(".settings-section-tab")
            .evaluateAll((tabs) => tabs.every((el) => el.scrollWidth <= el.clientWidth)),
        ).toBe(true);
        const fields = page.locator(
          '.settings-workspace :is(input:not([type="checkbox"], [type="radio"], [type="hidden"]), select, textarea)',
        );
        expect(await fields.count()).toBeGreaterThan(0);
        for (const field of await fields.all()) {
          if (await field.isVisible()) await expect(field).toHaveCSS("font-size", "16px");
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        const rows = page.locator(".settings-row");
        expect(
          await rows.evaluateAll((elements) =>
            elements.every((el) => el.scrollWidth <= el.clientWidth),
          ),
        ).toBe(true);
      });
    }
  }
}
