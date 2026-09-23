import { expect, test } from "@playwright/test";

import { installVisualFixture, waitForVisualReady } from "./fixtures";

for (const side of ["left", "right"] as const) {
  test(`desktop sidebar resizes from the ${side} and preserves its width`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installVisualFixture(page, {
      theme: "light",
      sidebarSide: side,
      preserveLocalStorage: true,
    });
    await page.goto("/threads/session-active");
    await waitForVisualReady(page);

    const sidebar = page.locator(".sidebar");
    const content = page.locator(".content");
    const handle = page.getByRole("separator", { name: "Ширина боковой панели" });
    await expect(sidebar).toHaveCSS("width", "292px");
    const bounds = (await handle.boundingBox())!;
    const startX = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height / 2;
    await page.mouse.move(startX, y);
    await page.mouse.down();
    await page.mouse.move(startX + (side === "left" ? 148 : -148), y);
    await expect(sidebar).toHaveCSS("width", "440px");
    await expect(content).toHaveCSS("width", "960px");
    expect(await page.evaluate(() => localStorage.getItem("codexnest.sidebarWidth"))).toBeNull();
    await page.mouse.up();
    expect(await page.evaluate(() => localStorage.getItem("codexnest.sidebarWidth"))).toBe("440");

    await page.reload();
    await waitForVisualReady(page);
    await expect(sidebar).toHaveCSS("width", "440px");

    await page.setViewportSize({ width: 821, height: 900 });
    await expect(sidebar).toHaveCSS("width", "361px");
    await expect(content).toHaveCSS("width", "420px");

    await page.setViewportSize({ width: 820, height: 900 });
    await expect(handle).toBeHidden();
    await expect(sidebar).toHaveCSS("width", "310px");
    await expect(content).toHaveCSS("width", "820px");
  });
}
