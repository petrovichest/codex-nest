import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

import { installDocsFixture, report } from "../docs/fixtures";
import { waitForVisualReady } from "./fixtures";

async function openReport(page: Page) {
  await page.goto("/threads/session-main");
  await page.getByRole("button", { name: "Show details", exact: true }).click();
  const inspector = page.getByRole("complementary", { name: "Task details" });
  await inspector.getByRole("tab", { name: /^Artifacts/u }).click();
  await inspector.getByRole("button", { name: "Open project-search.md" }).click();
  return page.locator(".artifact-viewer");
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [320, 390, 821, 1440]) {
    test.describe(`${theme} Markdown viewer at ${width}px`, () => {
      test.use({
        viewport: { width, height: width <= 820 ? 844 : 1000 },
        hasTouch: width <= 820,
      });

      test("single surface, readable table and fixed actions", async ({ page, browserName }) => {
        await installDocsFixture(page, theme);
        await openReport(page);
        const viewer = page.locator(".artifact-viewer");
        const document = viewer.locator(".artifact-markdown");
        await expect(
          document.getByRole("heading", { name: "Project search", exact: true }),
        ).toBeVisible();
        await waitForVisualReady(page);
        const surface = theme === "light" ? "rgb(248, 249, 246)" : "rgb(36, 39, 34)";
        await expect(viewer).toHaveCSS("background-color", surface);
        await expect(document).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        await expect(document).toHaveCSS("border-width", "0px");
        await expect(document).toHaveCSS("padding", "0px");
        await expect(document).toHaveCSS("font-size", "15px");
        await expect(viewer.locator(".artifact-viewer-stage")).toHaveCSS(
          "padding-left",
          width <= 820 ? "20px" : "24px",
        );
        await expect(viewer.getByTitle("project-search.md")).toBeVisible();
        const table = viewer.getByRole("group", { name: "Table", exact: true });
        await expect(table).toHaveCSS("border-radius", "20px");
        await expect(table).toHaveCSS("background-color", surface);
        await expect(table).not.toHaveCSS("box-shadow", "none");
        await expect(table.locator("table")).toHaveCSS("font-size", "14px");
        await expect(table.locator("th").first()).toHaveCSS("font-weight", "400");
        for (const area of [viewer, document, table]) {
          expect(await area.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        }
        for (const button of await viewer.locator("header button").all()) {
          await expect(button).toHaveCSS("width", width <= 820 ? "44px" : "36px");
          await expect(button).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        }
        await viewer.locator("header button").last().blur();
        await page.mouse.move(0, 0);
        if (width === 390 || width === 1440) {
          await expect(viewer).toHaveScreenshot(`markdown-viewer-${width}-${theme}.png`);
        }
        if (
          process.env.UPDATE_ARTIFACT_DOCS &&
          browserName === "chromium" &&
          width === 390 &&
          theme === "dark"
        ) {
          await page.screenshot({
            path: resolve(import.meta.dirname, "../../../../docs/assets/mobile-report.png"),
          });
        }
        await page.keyboard.press("Tab");
        await table.focus();
        await expect(table).toBeFocused();
        await expect(table).toHaveCSS("outline-style", "solid");
        await page.keyboard.press("Escape");
        await expect(viewer).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Open project-search.md" })).toBeFocused();
      });
    });
  }
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`${theme} long Markdown on touch`, () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

    test("contains wide tables, large text and safe areas without moving the header", async ({
      page,
      browserName,
    }) => {
      await installDocsFixture(page, theme);
      const longName = "project-search-with-a-very-long-report-name-for-mobile.md";
      const wideTable =
        "| Source | Result |\n| --- | ---: |\n| " +
        "long_unbroken_file_path_".repeat(8) +
        " | **12 passed** |";
      const content =
        report +
        "\n\n" +
        wideTable +
        "\n\n```text\n" +
        "long-code-token".repeat(30) +
        "\n```\n\n" +
        "[Details](https://example.test/report)\n\n> A quoted result.\n\n![Diagram](/favicon.svg)\n\n" +
        report.repeat(6);
      await page.route("**/api/v1/threads/session-main/downloads", (route) => {
        if (route.request().method() === "OPTIONS") return route.fallback();
        return route.fulfill({
          json: {
            downloadUrl: "/downloads/project-search.md",
            fileName: longName,
            size: new TextEncoder().encode(content).byteLength,
            expiresAt: Date.now() + 60_000,
          },
          headers: { "access-control-allow-origin": "*" },
        });
      });
      await page.route("**/downloads/project-search.md", (route) =>
        route.fulfill({ contentType: "text/markdown", body: content }),
      );
      await openReport(page);
      const viewer = page.locator(".artifact-viewer");
      const header = viewer.locator("header");
      const document = viewer.locator(".artifact-markdown");
      await expect(document).toBeVisible();
      await page.addStyleTag({
        content:
          ":root { --app-safe-area-top: 34px; --app-safe-area-left: 24px; --app-safe-area-right: 22px; --app-safe-area-bottom: 34px; --text-message: 20px; }",
      });
      await waitForVisualReady(page);
      await expect(viewer.getByTitle(longName)).toHaveCSS("text-overflow", "ellipsis");
      await expect(document).toHaveCSS("font-size", "20px");
      await expect(document.locator("h1").first()).toHaveCSS("font-size", "40px");
      await expect(viewer.locator(".artifact-viewer-title > span")).toHaveCSS("font-size", "12px");
      const stage = viewer.locator(".artifact-viewer-stage");
      await expect(stage).toHaveCSS("padding-left", "24px");
      await expect(stage).toHaveCSS("padding-right", "22px");
      await expect(stage).toHaveCSS("padding-bottom", "34px");
      const actions = await header.locator("button").first().boundingBox();
      expect(actions!.y).toBeGreaterThanOrEqual(34);
      const table = viewer.getByRole("group", { name: "Table", exact: true }).nth(1);
      await expect(table.locator("th").last()).toHaveCSS("text-align", "right");
      expect(await table.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
      await table.focus();
      await table.press("ArrowRight");
      await expect.poll(() => table.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
      await table.evaluate((el) => {
        for (const [type, x] of [
          ["touchstart", 100],
          ["touchmove", 270],
          ["touchend", 270],
        ] as const) {
          const event = new Event(type, { bubbles: true, cancelable: true });
          Object.defineProperty(event, "touches", {
            value: type === "touchend" ? [] : [{ clientX: x, clientY: 300 }],
          });
          el.dispatchEvent(event);
        }
      });
      await expect(page.locator(".sidebar")).not.toHaveClass(/\bopen\b/u);
      const before = await header.boundingBox();
      await stage.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      expect(await header.boundingBox()).toEqual(before);
      for (const area of [viewer, stage, document]) {
        expect(await area.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      }
      await expect(document.locator("pre")).toHaveCSS("font-size", "14px");
      await expect(document.locator("pre")).toHaveCSS("border-radius", "20px");
      await expect(document.getByRole("link", { name: "Details" })).toHaveAttribute(
        "rel",
        "noopener noreferrer",
      );
      const image = document.getByRole("img", { name: "Diagram" });
      expect(
        await image.evaluate(
          (el) => el.getBoundingClientRect().width <= el.parentElement!.clientWidth,
        ),
      ).toBe(true);
      if (browserName === "chromium") {
        const audit = await new AxeBuilder({ page }).include(".artifact-viewer").analyze();
        expect(audit.violations).toEqual([]);
      }
    });
  });
}
