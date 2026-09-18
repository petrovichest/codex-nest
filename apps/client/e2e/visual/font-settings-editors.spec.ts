import { expect, test, type Page } from "@playwright/test";
import type { ThreadDetail } from "@codexnest/protocol";
import { installVisualFixture, mainThread, snapshot, waitForVisualReady } from "./fixtures";

async function changeSize(page: Page, role: string, size: number) {
  // Exercise a live preference change while the editor stays mounted.
  await page.evaluate(
    async ({ role, size }) => {
      const modulePath = performance
        .getEntriesByType("resource")
        .find((entry) => new URL(entry.name).pathname === "/src/typography.ts")!.name;
      const { setTypographySize } = await import(modulePath);
      setTypographySize(role, size);
    },
    { role, size },
  );
}

for (const width of [390, 1440]) {
  test(`goal actions stay reachable above the scrolling toolbar at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await installVisualFixture(page, { theme: "dark" });
    await page.route("http://127.0.0.1:4310/**", (route) => route.abort());
    await page.route("**/api/v1/threads/session-main/goal", (route) =>
      route.fulfill({
        json: {
          threadId: mainThread.id,
          objective: "Проверить настройки шрифтов",
          status: "active",
          tokenBudget: null,
          tokensUsed: 1250,
          timeUsedSeconds: 60,
          createdAt: 1,
          updatedAt: 1,
        },
        headers: { "access-control-allow-origin": "*" },
      }),
    );
    await page.goto("/threads/session-main");
    await waitForVisualReady(page);
    await changeSize(page, "ui", 32);
    await changeSize(page, "caption", 32);
    await page.locator(".goal-picker summary").click();
    const panel = page.locator(".goal-popover");
    await expect(panel).toBeInViewport();
    for (const button of await panel.locator("button").all()) await button.click({ trial: true });
    expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  });

  test(`live font changes resize fallback editors and align paste marks at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const summary = { ...mainThread, state: "completed" as const, currentTurnId: null };
    await installVisualFixture(page, {
      theme: "light",
      snapshot: { ...snapshot, attention: [], threads: [summary] },
    });
    await page.route("http://127.0.0.1:4310/**", (route) => route.abort());
    await page.addInitScript(() => {
      const supports = CSS.supports.bind(CSS);
      CSS.supports = (property: string, value?: string) =>
        property === "field-sizing"
          ? false
          : value === undefined
            ? supports(property)
            : supports(property, value);
    });
    const text = "Проверь FATCOINUSDT\nи объясни причину";
    const inlinePastes = [{ id: "symbol", start: 8, end: 19 }];
    const detail: ThreadDetail = {
      summary,
      olderTurnsCursor: null,
      turns: [],
      draft: {
        input: text,
        inlinePastes,
        images: [],
        goalMode: false,
        annotations: [],
        updatedAt: 1,
      },
      queuedMessages: [
        {
          id: "queued-font",
          threadId: summary.id,
          text,
          inlinePastes,
          status: "queued",
          createdAt: 1,
        },
      ],
    };
    await page.route("**/api/v1/threads/session-main", (route) =>
      route.fulfill({
        json: detail,
        headers: { "access-control-allow-origin": "*" },
      }),
    );
    await page.goto("/threads/session-main");
    await waitForVisualReady(page);
    await page.addStyleTag({ content: "textarea { field-sizing: fixed !important; }" });
    const composer = page.locator(".composer-box textarea");
    await expect(composer).toHaveValue(text);
    await page.getByRole("button", { name: "Изменить сообщение в очереди" }).click();
    const queue = page.locator(".queued-message-editor textarea");
    await expect(queue).toHaveValue(text);
    const heights = await Promise.all(
      [composer, queue].map((field) => field.evaluate((el) => el.clientHeight)),
    );
    await changeSize(page, "message", 32);
    for (const [index, field] of [composer, queue].entries()) {
      await expect(field).toHaveCSS("font-size", "32px");
      await expect
        .poll(() => field.evaluate((el) => el.clientHeight))
        .toBeGreaterThan(heights[index]!);
      const mirror = field.locator("..").locator(".paste-input-mirror");
      await expect(mirror).toHaveCSS("font-size", "32px");
      await expect(mirror).toHaveCSS("line-height", "48px");
      expect(await mirror.evaluate((el) => el.clientWidth)).toBe(
        await field.evaluate((el) => el.clientWidth),
      );
      await expect(mirror.locator("mark")).toHaveText("FATCOINUSDT");
      await expect(field).toHaveValue(text);
    }
    await changeSize(page, "message", 16);
    for (const [index, field] of [composer, queue].entries())
      await expect.poll(() => field.evaluate((el) => el.clientHeight)).toBe(heights[index]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

test("saved font sizes apply on the disconnected setup screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await installVisualFixture(page, { theme: "dark", connected: false });
  await page.route("http://127.0.0.1:4310/**", (route) => route.abort());
  await page.addInitScript(() =>
    localStorage.setItem(
      "codexnest.typography",
      JSON.stringify({ display: 32, message: 24, description: 18 }),
    ),
  );
  await page.goto("/");
  await expect(page.locator(".setup-card h1")).toHaveCSS("font-size", "32px");
  await expect(page.locator('input[type="url"]')).toHaveCSS("font-size", "24px");
  await expect(page.locator(".setup-card p")).toHaveCSS("font-size", "16px");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("technical sizes are independent of message and description sizes", async ({ page }) => {
  await installVisualFixture(page, { theme: "light" });
  await page.route("http://127.0.0.1:4310/**", (route) => route.abort());
  await page.goto("/threads/session-main");
  await waitForVisualReady(page);
  await changeSize(page, "technical", 28);
  await changeSize(page, "description", 10);
  await page.getByRole("button", { name: "Показать сведения", exact: true }).click();
  const inspector = page.locator(".session-inspector");
  await expect(inspector.locator(".inspector-value-technical").first()).toHaveCSS(
    "font-size",
    "28px",
  );
  await expect(inspector.locator("dt").first()).toHaveCSS("font-size", "10px");
  await expect(page.locator(".composer-box textarea")).toHaveCSS("font-size", "16px");
});
