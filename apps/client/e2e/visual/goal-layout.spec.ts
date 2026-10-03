import { expect, test, type Page } from "@playwright/test";

import { installVisualFixture, mainThread, waitForVisualReady } from "./fixtures";

async function expectGoalFits(page: Page, side: "left" | "right") {
  const panel = page.locator(".goal-popover");
  await expect(panel).toBeVisible();
  const goal = (await panel.boundingBox())!;
  const composer = (await page.locator(".composer-box").boundingBox())!;
  const sidebar = (await page.locator(".sidebar").boundingBox())!;

  expect(goal.x).toBeGreaterThanOrEqual(composer.x);
  expect(goal.x + goal.width).toBeLessThanOrEqual(composer.x + composer.width);
  expect(goal.width).toBeGreaterThan(composer.width - 30);
  expect(goal.y).toBeGreaterThanOrEqual(0);
  expect(goal.y + goal.height).toBeLessThan(composer.y);
  if (side === "left") expect(goal.x).toBeGreaterThan(sidebar.x + sidebar.width);
  else expect(goal.x + goal.width).toBeLessThan(sidebar.x);
  expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await panel.locator("p").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  for (const button of await panel.locator("button").all()) await button.click({ trial: true });
}

for (const side of ["left", "right"] as const) {
  for (const enlarged of [false, true]) {
    test(`goal stays inside the composer with ${side} sidebar and ${enlarged ? "large" : "default"} fonts`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await installVisualFixture(page, {
        theme: enlarged ? "dark" : "light",
        sidebarSide: side,
      });
      await page.route("http://127.0.0.1:4310/**", (route) => route.abort());
      await page.route("**/api/v1/threads/session-main/goal", (route) =>
        route.fulfill({
          json: {
            threadId: mainThread.id,
            objective: `${"Проверить гипотезу с учётом комиссий и проскальзывания. ".repeat(20)}\n${"ДлинныйИдентификатор".repeat(20)}`,
            status: "active",
            tokenBudget: null,
            tokensUsed: 22399222,
            timeUsedSeconds: 79248,
            createdAt: 1,
            updatedAt: 1,
          },
          headers: { "access-control-allow-origin": "*" },
        }),
      );
      await page.goto("/threads/session-main");
      await waitForVisualReady(page);
      if (enlarged) {
        await page.evaluate(async () => {
          const modulePath = performance
            .getEntriesByType("resource")
            .find((entry) => new URL(entry.name).pathname === "/src/typography.ts")!.name;
          const { setTypographySize } = await import(modulePath);
          for (const role of ["ui", "caption", "message"]) setTypographySize(role, 32);
        });
      }
      await page.locator(".goal-picker summary").click();
      await expectGoalFits(page, side);

      const handle = page.getByRole("separator", { name: "Ширина боковой панели" });
      const bounds = (await handle.boundingBox())!;
      const startX = bounds.x + bounds.width / 2;
      const y = bounds.y + bounds.height / 2;
      await page.mouse.move(startX, y);
      await page.mouse.down();
      await page.mouse.move(startX + (side === "left" ? 148 : -148), y);
      await expect(page.locator(".sidebar")).toHaveCSS("width", "440px");
      await expectGoalFits(page, side);
      await page.mouse.up();

      for (const width of [900, 821]) {
        await page.setViewportSize({ width, height: 1000 });
        await expectGoalFits(page, side);
      }
    });
  }
}
