import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { installVisualFixture, waitForVisualReady } from "../visual/fixtures";

for (const [width, theme] of [
  [1440, "light"],
  [390, "dark"],
] as const) {
  test(`capture font settings at ${width}px in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await installVisualFixture(page, { theme });
    await page.route("http://127.0.0.1:4310/**", (route) => route.abort());
    await page.goto("/settings?section=application");
    await waitForVisualReady(page);
    const group = page.locator(".typography-settings");
    await expect(group.locator('input[type="number"]')).toHaveCount(9);
    await group.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.locator(".settings-scroll").evaluate((el) => {
      const shelf = el.querySelector(".settings-section-shelf")!;
      el.scrollTop -= shelf.getBoundingClientRect().height;
    });
    await page.mouse.move(0, 0);
    await page.screenshot({
      path: resolve(
        import.meta.dirname,
        `../../../../docs/assets/font-settings-${width === 1440 ? "desktop" : "mobile"}-${theme}.png`,
      ),
      animations: "disabled",
      caret: "hide",
    });
  });
}
