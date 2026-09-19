import { expect, test } from "@playwright/test";

import { installVisualFixture, waitForVisualReady } from "./fixtures";

const layouts = [
  { width: 1440, height: 900, top: 0, bottom: 0, left: 0, right: 0, size: 14 },
  { width: 390, height: 844, top: 34, bottom: 24, left: 0, right: 0, size: 14 },
  { width: 320, height: 640, top: 34, bottom: 24, left: 0, right: 0, size: 14 },
  { width: 390, height: 360, top: 34, bottom: 0, left: 0, right: 0, size: 14 },
  { width: 780, height: 390, top: 24, bottom: 24, left: 48, right: 24, size: 14 },
  { width: 320, height: 640, top: 34, bottom: 24, left: 0, right: 0, size: 32 },
];

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: setup remains reachable with safe areas, keyboard height and large text`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.addInitScript((theme) => {
      localStorage.setItem("codexnest.theme", theme);
      localStorage.setItem(
        "codexnest.uiLanguage",
        new URL(location.href).searchParams.get("lang") ?? "ru",
      );
    }, theme);
    for (const language of ["ru", "en"]) {
      await page.goto(`/?lang=${language}`);
      await waitForVisualReady(page);
      await expect(page.locator("html")).toHaveAttribute("data-resolved-theme", theme);
      await expect(page.locator("html")).toHaveAttribute("lang", language);
      for (const layout of layouts) {
        await page.setViewportSize({ width: layout.width, height: layout.height });
        await page.evaluate((layout) => {
          const root = document.documentElement;
          for (const edge of ["top", "bottom", "left", "right"] as const) {
            root.style.setProperty(`--safe-area-inset-${edge}`, `${layout[edge]}px`);
          }
          for (const token of [
            "--text-ui",
            "--text-small",
            "--text-section",
            "--text-input",
            "--text-display",
          ]) {
            const size =
              layout.size === 32
                ? 32
                : token === "--text-display"
                  ? 22
                  : token === "--text-input"
                    ? 15
                    : 14;
            root.style.setProperty(token, `${size}px`);
          }
          document.querySelector(".setup-page")!.scrollTop = 0;
        }, layout);
        await expect(async () => {
          const geometry = await page.locator(".setup-card").evaluate((card) => ({
            card: card.getBoundingClientRect().toJSON(),
            first: card.querySelector("input")!.getBoundingClientRect().toJSON(),
            overflow: document.documentElement.scrollWidth > innerWidth,
          }));
          const edge = layout.width > 820 ? 32 : 16;
          const inner = layout.width > 820 ? 32 : 24;
          expect(geometry.card.top).toBeGreaterThanOrEqual(layout.top + edge - 1);
          expect(geometry.card.left).toBeGreaterThanOrEqual(layout.left + edge - 1);
          expect(geometry.card.right).toBeLessThanOrEqual(layout.width - layout.right - edge + 1);
          expect(geometry.first.left - geometry.card.left).toBeCloseTo(inner, 0);
          expect(geometry.card.right - geometry.first.right).toBeCloseTo(inner, 0);
          expect(geometry.overflow).toBe(false);
        }).toPass();
        await expect(async () => {
          // WebKit may finish text layout a frame after the viewport/font change.
          await page.locator(".setup-page").evaluate((el) => {
            el.scrollTop = el.scrollHeight;
          });
          const button = (await page.locator('button[type="submit"]').boundingBox())!;
          const card = (await page.locator(".setup-card").boundingBox())!;
          expect(button.y).toBeGreaterThanOrEqual(0);
          expect(card.y + card.height).toBeLessThanOrEqual(layout.height - layout.bottom - 15);
          expect(card.y + card.height - button.y - button.height).toBeCloseTo(
            layout.width > 820 ? 32 : 24,
            0,
          );
        }).toPass();
      }
    }
  });

  test(`${theme}: setup fields share soft focus and the submit action keeps its geometry`, async ({
    page,
  }) => {
    await installVisualFixture(page, { theme, connected: false });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await waitForVisualReady(page);
    const url = page.getByLabel("Адрес сервера");
    const token = page.getByLabel("Bearer token");
    const resting = await url.evaluate((el) => getComputedStyle(el).boxShadow);
    const bounds = await url.boundingBox();
    await url.click();
    await expect(url).toHaveCSS("outline-style", "none");
    await expect(url).not.toHaveCSS("box-shadow", resting);
    const focused = await url.evaluate((el) => getComputedStyle(el).boxShadow);
    expect(await url.boundingBox()).toEqual(bounds);
    await page.keyboard.press("Tab");
    await expect(token).toBeFocused();
    await expect(token).toHaveCSS("box-shadow", focused);
    await expect(url).toHaveCSS("box-shadow", resting);

    await url.fill("https://codexnest.visual");
    await token.fill("test-token");
    const button = page.locator('button[type="submit"]');
    await page.locator(".setup-identity").click();
    await page.mouse.move(0, 0);
    await expect(button).toHaveCSS("box-shadow", "none");
    const buttonBounds = await button.boundingBox();
    await button.hover();
    await expect(button).not.toHaveCSS("box-shadow", "none");
    await page.mouse.down();
    await expect(button).toHaveCSS("box-shadow", /inset/);

    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/v1/health", async (route) => {
      await pending;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "unavailable",
            message: "The server is temporarily unavailable. ".repeat(8),
          },
        }),
      });
    });
    await page.mouse.up();
    await expect(page.getByRole("button", { name: "Проверяем…" })).toBeDisabled();
    expect(await button.boundingBox()).toEqual(buttonBounds);
    release();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(url).toHaveValue("https://codexnest.visual");
    await expect(token).toHaveValue("test-token");
    await expect(page.getByRole("button", { name: "Подключиться" })).toBeEnabled();
    await page.setViewportSize({ width: 320, height: 360 });
    await page.evaluate(() => document.documentElement.style.setProperty("--text-ui", "32px"));
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
