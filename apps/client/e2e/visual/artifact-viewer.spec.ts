import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { installDocsFixture, report } from "../docs/fixtures";
import { waitForVisualReady } from "./fixtures";

const serverContentSecurityPolicy = readFileSync(
  resolve(import.meta.dirname, "../../../server/src/app.ts"),
  "utf8",
).match(/"Content-Security-Policy",\s*"([^"]+)"/u)![1]!;

async function openReport(page: Page) {
  await page.goto("/threads/session-main");
  await page.getByRole("button", { name: "Show details", exact: true }).click();
  const inspector = page.getByRole("complementary", { name: "Task details" });
  await inspector.getByRole("tab", { name: /^Artifacts/u }).click();
  await inspector.getByRole("button", { name: "Open project-search.md" }).click();
  return page.locator(".artifact-viewer");
}

for (const width of [390, 1440]) {
  test.describe(`HTML viewer at ${width}px`, () => {
    test.use({ viewport: { width, height: 1000 }, hasTouch: width <= 820 });

    test("preserves report styles under the server CSP while isolating active and remote content", async ({
      page,
    }) => {
      await installDocsFixture(page, "light");
      const html = `<!doctype html><html lang="ru"><head>
        <meta charset="utf-8">
        <style>
          @import url("https://artifact-preview.invalid/import.css");
          body { margin: 0; font: 15px/1.6 system-ui, sans-serif; color: #182622; }
          main { padding: 24px; }
          h1 { font-size: 34px; }
          .cards { display: flex; gap: 16px; flex-wrap: wrap; }
          .card { padding: 20px; background: #f4f5f1; }
          .scroll { overflow-x: auto; }
          table { border-collapse: collapse; font-size: 13px; }
          td { min-width: 80px; padding: 8px 10px; white-space: nowrap; }
          .remote { background-image: url("https://artifact-preview.invalid/background.png"); }
        </style>
        <script>parent.document.body.dataset.artifactScript = "executed";</script>
        </head><body><main>
        <h1>282 сделки · 288 вариантов выхода</h1>
        <div class="cards"><div class="card">281 / 282</div><div class="card">288</div></div>
        <div class="scroll"><table><tbody><tr>${"<td>+19.814 SOL</td>".repeat(16)}</tr></tbody></table></div>
        <p class="inline" style="background: rgb(31, 143, 106)">Цвет матрицы</p>
        <div class="remote">Remote resources are blocked</div>
        <img src="https://artifact-preview.invalid/tracker.png">
        <button onclick="parent.document.body.dataset.artifactScript = 'executed'">Action</button>
        <iframe src="https://artifact-preview.invalid/frame"></iframe>
        <form action="https://artifact-preview.invalid/submit"><input></form>
        </main></body></html>`;
      const remoteRequests: string[] = [];
      await page.route("https://artifact-preview.invalid/**", (route) => {
        remoteRequests.push(route.request().url());
        return route.abort();
      });
      await page.route("**/api/v1/threads/session-main/artifacts", (route) =>
        route.fulfill({
          headers: { "access-control-allow-origin": "*" },
          json: {
            capability: "explicit",
            artifacts: [
              {
                id: "html-report",
                label: "HTML report",
                path: "/work/launchpad/report.html",
                relativePath: "report.html",
                fileName: "report.html",
                turnId: "turn-main",
                createdAt: Date.now(),
              },
            ],
          },
        }),
      );
      await page.route("**/api/v1/threads/session-main/downloads", (route) =>
        route.fulfill({
          headers: { "access-control-allow-origin": "*" },
          json: {
            downloadUrl: "/downloads/report.html",
            fileName: "report.html",
            size: new TextEncoder().encode(html).byteLength,
            expiresAt: Date.now() + 60_000,
          },
        }),
      );
      await page.route("**/downloads/report.html", (route) =>
        route.fulfill({ contentType: "text/html; charset=utf-8", body: html }),
      );

      await page.goto("/threads/session-main");
      await waitForVisualReady(page);
      // Vite injects the app's CSS inline. Apply the actual server policy after it
      // loads so the report inherits production restrictions without breaking Vite.
      await page.evaluate((policy) => {
        const meta = document.createElement("meta");
        meta.httpEquiv = "Content-Security-Policy";
        meta.content = policy;
        document.head.append(meta);
      }, serverContentSecurityPolicy);
      await page.getByRole("button", { name: "Show details", exact: true }).click();
      const inspector = page.getByRole("complementary", { name: "Task details" });
      await inspector.getByRole("tab", { name: /^Artifacts/u }).click();
      await inspector.getByRole("button", { name: "Open report.html" }).click();

      const iframe = page.locator(".artifact-html-frame");
      await expect(iframe).toHaveAttribute("sandbox", "");
      const report = page.frameLocator(".artifact-html-frame");
      await expect(report.getByRole("heading")).toHaveText("282 сделки · 288 вариантов выхода");
      await expect(report.locator("body")).toHaveCSS("font-size", "15px");
      await expect(report.locator("body")).toHaveCSS("color", "rgb(24, 38, 34)");
      await expect(report.locator("h1")).toHaveCSS("font-size", "34px");
      await expect(report.locator(".cards")).toHaveCSS("display", "flex");
      await expect(report.locator(".cards")).toHaveCSS("gap", "16px");
      await expect(report.locator(".inline")).toHaveCSS("background-color", "rgb(31, 143, 106)");
      const scroll = report.locator(".scroll");
      await expect(scroll).toHaveCSS("overflow-x", "auto");
      expect(await scroll.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
      expect(await report.locator("body").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
        true,
      );
      await scroll.evaluate((el) => {
        el.scrollLeft = 100;
      });
      expect(await scroll.evaluate((el) => el.scrollLeft)).toBe(100);
      await expect(report.locator("script, iframe, form, [onclick]")).toHaveCount(0);
      await report.getByRole("button", { name: "Action" }).click();
      expect(await page.locator("body").getAttribute("data-artifact-script")).toBeNull();
      expect(await iframe.evaluate((el) => (el as HTMLIFrameElement).contentDocument)).toBeNull();
      expect(remoteRequests).toEqual([]);
    });
  });
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
