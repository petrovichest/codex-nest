import { expect, test } from "@playwright/test";
import { installVisualFixture, mainThread, snapshot, waitForVisualReady } from "./fixtures";

for (const theme of ["light", "dark"] as const) {
  for (const language of ["ru", "en"] as const) {
    for (const width of [320, 390, 1024, 1440]) {
      test(`inspector sections at ${width}px, ${language}, ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        const seed = structuredClone(snapshot);
        seed.uiLanguage = language;
        const summary = seed.threads.find((thread) => thread.id === mainThread.id)!;
        summary.cwd = "/home/hon/git/codex-nest";
        summary.codexSettings = { model: "gpt-6-astra", reasoningEffort: "xhigh" };
        seed.projects.find((project) => project.id === summary.projectId)!.displayName =
          "codex-nest";
        await installVisualFixture(page, { theme, snapshot: seed });
        await page.route("http://127.0.0.1:4310/**", (route) => route.abort());
        await page.addInitScript(() => {
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: {
              writeText: async (text: string) => {
                document.documentElement.dataset.copiedPath = text;
              },
            },
          });
        });
        await page.goto("/threads/session-main");
        await page
          .getByRole("button", {
            name: language === "ru" ? "Показать сведения" : "Show details",
            exact: true,
          })
          .click();
        await page.mouse.move(0, 0);
        await waitForVisualReady(page);
        const inspector = page.locator(".session-inspector");
        const surface = theme === "light" ? "rgb(248, 249, 246)" : "rgb(36, 39, 34)";
        await expect(inspector).toHaveCSS("background-color", surface);
        await expect(inspector).toHaveCSS("border-radius", "28px");
        await expect(inspector.locator("h2")).toHaveText(
          language === "ru"
            ? ["Проект", "Выполнение", "Активность"]
            : ["Project", "Execution", "Activity"],
        );
        await expect(inspector.locator(".inspector-tabs")).toHaveCSS(
          "background-color",
          "rgba(0, 0, 0, 0)",
        );
        const selected = inspector.getByRole("tab", { selected: true });
        await expect(selected).toHaveCSS("background-color", surface);
        await expect(selected).not.toHaveCSS("box-shadow", "none");
        await expect(inspector.locator(".inspector-path code")).toHaveCSS(
          "background-color",
          "rgba(0, 0, 0, 0)",
        );
        expect(await inspector.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        if (language === "ru" && width >= 390) {
          const bounds = (await inspector.boundingBox())!;
          const x = Math.max(0, bounds.x - 64);
          const y = Math.max(0, bounds.y - 64);
          // Include the surrounding chat so panel elevation and backdrop blur are visible.
          await expect(page).toHaveScreenshot(`inspector-c-${width}-${theme}.png`, {
            clip: {
              x,
              y,
              width: Math.min(width, bounds.x + bounds.width + 64) - x,
              height: Math.min(900, bounds.y + bounds.height + 64) - y,
            },
          });
        }
        const copy = inspector.locator(".inspector-path-copy");
        const before = await copy.boundingBox();
        await page.keyboard.press("Tab");
        await copy.focus();
        await expect(copy).toHaveCSS("background-color", surface);
        await expect(copy).not.toHaveCSS("outline-style", "none");
        await page.keyboard.press("Enter");
        await expect(page.locator("html")).toHaveAttribute("data-copied-path", summary.cwd);
        await expect(copy).toHaveAccessibleName(
          language === "ru" ? "Путь скопирован" : "Path copied",
        );
        expect(await copy.boundingBox()).toEqual(before);
      });
    }
  }
}

for (const theme of ["light", "dark"] as const) {
  for (const { width, sidebarSide } of [
    { width: 390, sidebarSide: "left" },
    { width: 1024, sidebarSide: "right" },
    { width: 1440, sidebarSide: "right" },
  ] as const) {
    test(`inspector floating effects at ${width}px, ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await installVisualFixture(page, { theme, sidebarSide });
      await page.route("http://127.0.0.1:4310/**", (route) => route.abort());

      for (const route of ["/threads/session-main", "/new?projectId=project-nest"]) {
        await page.goto(route);
        await waitForVisualReady(page);
        if (width === 390) {
          await page.getByRole("button", { name: "Открыть список задач" }).click();
        }
        const panelShadow = await page
          .locator(".sidebar")
          .evaluate((element) => getComputedStyle(element).boxShadow);
        expect(panelShadow).not.toBe("none");
        if (width === 390) {
          await page.locator(".drawer-backdrop").click({ position: { x: width - 2, y: 2 } });
        }

        const toggle = page.getByRole("button", { name: "Показать сведения", exact: true });
        await toggle.click();
        const inspector = page.locator(".session-inspector");
        await expect(inspector).toHaveCSS("box-shadow", panelShadow);
        if (route.startsWith("/threads/")) {
          await inspector.getByRole("tab", { name: /^Артефакты/u }).click();
          await expect(inspector.locator(".inspector-artifact-list")).toBeVisible();
          await expect(inspector).toHaveCSS("box-shadow", panelShadow);
        }
        await inspector.getByRole("button", { name: "Закрыть сведения" }).click();
        await expect(inspector).toHaveCount(0);
        await toggle.click();

        const backdrop = page.locator(".inspector-backdrop");
        if (width === 1440) {
          await expect(backdrop).toBeHidden();
          continue;
        }
        const expectBlurOnly = async () => {
          await expect(backdrop).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
          await expect(backdrop).toHaveCSS("box-shadow", "none");
          await expect(backdrop).toHaveCSS("backdrop-filter", "blur(8px)");
        };
        await expectBlurOnly();
        await backdrop.hover({ position: { x: 2, y: 2 } });
        await expectBlurOnly();
        await page.keyboard.press("Tab");
        await backdrop.focus();
        await expect(backdrop).toBeFocused();
        await expect(backdrop).toHaveCSS("outline-style", "solid");
        await expectBlurOnly();
        await page.mouse.down();
        await expectBlurOnly();
        await page.mouse.up();
        await expect(inspector).toHaveCount(0);
        await expect(backdrop).toHaveCount(0);
      }
    });
  }
}

for (const language of ["ru", "en"] as const) {
  for (const width of [320, 1440]) {
    test(`inspector long values and large fonts at ${width}px, ${language}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const seed = structuredClone(snapshot);
      seed.uiLanguage = language;
      seed.projects[0]!.displayName = "A long project name / Длинное название проекта".repeat(3);
      seed.threads.find((thread) => thread.id === mainThread.id)!.cwd =
        "/work/" + "long-directory-name/".repeat(10);
      await installVisualFixture(page, { theme: "dark", snapshot: seed, sidebarSide: "right" });
      await page.route("http://127.0.0.1:4310/**", (route) => route.abort());
      await page.route("**/git-changes", (route) =>
        route.request().method() === "OPTIONS"
          ? route.fallback()
          : route.fulfill({
              json: {
                state: "dirty",
                filesChanged: 474,
                additions: 123456789,
                deletions: 12345678,
              },
              headers: { "access-control-allow-origin": "*" },
            }),
      );
      await page.addInitScript(() =>
        localStorage.setItem(
          "codexnest.typography",
          JSON.stringify({ ui: 32, technical: 32, description: 32, caption: 32, section: 32 }),
        ),
      );
      await page.goto("/threads/session-main");
      await page
        .getByRole("button", {
          name: language === "ru" ? "Показать сведения" : "Show details",
          exact: true,
        })
        .click();
      await waitForVisualReady(page);
      const inspector = page.locator(".session-inspector");
      await expect(inspector.locator(".inspector-path code")).toHaveCSS("font-size", "32px");
      const overflow = await inspector
        .locator(".inspector-panel, .inspector-path-row, .inspector-list dd")
        .evaluateAll((elements) =>
          elements
            .filter((el) => el.scrollWidth > el.clientWidth + 1)
            .map((el) => ({
              className: el.className,
              text: el.textContent,
              width: el.clientWidth,
              scrollWidth: el.scrollWidth,
            })),
        );
      expect(overflow).toEqual([]);
      await inspector.locator(".inspector-path-copy").click({ trial: true });
      await inspector.locator(".inspector-dates").scrollIntoViewIfNeeded();
      await expect(inspector.locator(".inspector-heading button")).toBeInViewport();
      await expect(inspector.getByRole("tab").first()).toBeInViewport();
      const box = (await inspector.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    });
  }
}

test.describe("inspector touch controls", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  for (const sidebarSide of ["left", "right"] as const) {
    test(`copy stays reachable with safe areas and ${sidebarSide} navigation`, async ({ page }) => {
      await installVisualFixture(page, { theme: "light", sidebarSide });
      await page.route("http://127.0.0.1:4310/**", (route) => route.abort());
      await page.goto("/threads/session-main");
      await page.addStyleTag({
        content:
          ":root { --app-safe-area-left: 16px; --app-safe-area-right: 12px; --app-safe-area-bottom: 24px; }",
      });
      await page.getByRole("button", { name: "Показать сведения", exact: true }).click();
      const inspector = page.locator(".session-inspector");
      const copy = inspector.locator(".inspector-path-copy");
      await expect(copy).toHaveCSS("width", "44px");
      await expect(copy).toHaveCSS("height", "44px");
      await copy.click({ trial: true });
      const box = (await inspector.boundingBox())!;
      expect(box.x).toBe(24);
      expect(box.x + box.width).toBe(370);
      expect(box.y + box.height).toBe(812);
    });
  }
});
