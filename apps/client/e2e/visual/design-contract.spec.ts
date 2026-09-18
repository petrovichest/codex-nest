import { expect, test } from "@playwright/test";

import { installVisualFixture, snapshot, waitForVisualReady } from "./fixtures";

for (const width of [320, 390, 610, 1440]) {
  for (const language of ["ru", "en"] as const) {
    for (const theme of ["light", "dark"] as const) {
      test(`fork at ${width}px, ${language}, ${theme}: readable metrics and anchored actions`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: width < 610 ? 640 : 1000 });
        const seed = structuredClone(snapshot);
        seed.uiLanguage = language;
        const sourceTitle = "Длинное название / A long source title ".repeat(5).trim();
        seed.threads.find((thread) => thread.id === "session-main")!.title = sourceTitle;
        // Cover a failed estimate as well as the ready result in each theme and locale.
        await installVisualFixture(page, {
          theme,
          snapshot: seed,
          forkEstimate: width === 390 ? "failure" : "ready",
        });
        let release!: () => void;
        const pending = new Promise<void>((resolve) => {
          release = resolve;
        });
        await page.route("**/fork-estimate", async (route) => {
          if (route.request().method() === "OPTIONS") return route.fallback();
          await pending;
          return route.fallback();
        });
        await page.goto("/threads/session-main");
        await page
          .getByRole("button", {
            name: language === "ru" ? "Создать ответвление отсюда" : "Fork from here",
            exact: true,
          })
          .click();
        const dialog = page.locator(".fork-dialog");
        await expect(dialog.locator(".fork-source-copy strong")).toHaveText(sourceTitle);
        const loading = dialog.getByText(language === "ru" ? "Считаем…" : "Calculating…", {
          exact: true,
        });
        await expect(loading.first()).toBeVisible();
        await waitForVisualReady(page);
        const chrome = dialog.locator(".dialog-header,.fork-dialog-actions");
        const geometry = () =>
          chrome.evaluateAll((elements) =>
            elements.map((element) => {
              const { x, y, width, height } = element.getBoundingClientRect();
              return { x, y, width, height };
            }),
          );
        const before = await geometry();
        const expectCompact = async () => {
          const body = (await dialog.locator(".fork-dialog-body").boundingBox())!;
          const choices = (await dialog.locator(".fork-mode-options").boundingBox())!;
          const actions = (await dialog.locator(".fork-dialog-actions").boundingBox())!;
          expect(actions.y - (body.y + body.height)).toBeCloseTo(16, 0);
          if (choices.y + choices.height <= body.y + body.height) {
            // Breathing room keeps the last card's shadow inside the scroll viewport.
            expect(body.y + body.height - (choices.y + choices.height)).toBeCloseTo(12, 0);
          }
        };
        await expectCompact();
        release();
        await expect(loading).toHaveCount(0);
        expect(await geometry()).toEqual(before);
        await expectCompact();
        await expect(dialog.locator(".fork-dialog-actions .primary")).toBeEnabled();
        await expect(dialog.locator(".fork-mode-metrics small").first()).toHaveCSS(
          "font-size",
          "12px",
        );
        const metrics = dialog.locator(".fork-mode-metrics");
        await expect(metrics.first()).toHaveCSS("font-size", "14px");
        for (const card of await dialog.locator(".fork-mode-card").all()) {
          const description = (await card.locator(".fork-mode-description").boundingBox())!;
          const values = card.locator(".fork-mode-metrics");
          const bounds = (await values.boundingBox())!;
          expect(bounds.y).toBeGreaterThanOrEqual(description.y + description.height);
          expect(await values.locator(":scope > span").count()).toBe(2);
        }
        expect(
          await dialog
            .locator(".fork-dialog-body,.fork-mode-metrics > span")
            .evaluateAll((items) => items.every((item) => item.scrollWidth <= item.clientWidth)),
        ).toBe(true);
        const actions = (await dialog.locator(".fork-dialog-actions").boundingBox())!;
        expect(actions.y + actions.height).toBeLessThanOrEqual(page.viewportSize()!.height);
        if (width === 320 || width === 1440) {
          await page.setViewportSize({ width, height: 360 });
          await expectCompact();
          const header = (await dialog.locator(".dialog-header").boundingBox())!;
          const footer = (await dialog.locator(".fork-dialog-actions").boundingBox())!;
          expect(header.y).toBeGreaterThanOrEqual(0);
          expect(footer.y + footer.height).toBeLessThanOrEqual(360);
          expect(
            await dialog
              .locator(".fork-dialog-body")
              .evaluate((body) => body.scrollHeight > body.clientHeight),
          ).toBe(true);
          await dialog.locator(".fork-mode-card").last().click();
          await expect(dialog.locator('input[value="exact"]')).toBeChecked();
        }
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
      });
    }
  }
}

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: floating chat fits narrow screens and respects display insets`, async ({
    page,
  }) => {
    await installVisualFixture(page, { theme });
    for (const width of [320, 359, 390, 768, 820, 821, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/threads/session-attention");
      await waitForVisualReady(page);
      const mobile = width <= 820;
      const header = page.locator(".workspace-header");
      const expectAligned = async () => {
        const panel = (await header.boundingBox())!;
        const composer = (await page.locator(".composer-box").boundingBox())!;
        expect(panel.x).toBeCloseTo(composer.x, 1);
        expect(panel.width).toBeCloseTo(composer.width, 1);
      };
      await expectAligned();
      if (!mobile) {
        await page.getByRole("button", { name: "Показать сведения", exact: true }).click();
        await expectAligned();
        await page
          .getByRole("complementary", { name: "Сведения о задаче", exact: true })
          .getByRole("button", { name: "Закрыть сведения", exact: true })
          .click();
      }
      if (mobile) {
        await page.addStyleTag({
          content:
            ":root { --app-safe-area-top: 34px !important; --app-safe-area-left: 16px !important; --app-safe-area-right: 12px !important; }",
        });
      }
      const bounds = (await header.boundingBox())!;
      expect(bounds.height).toBe(44);
      for (const text of await header.locator("h1, p").all()) {
        await expect(text).toHaveCSS("font-weight", "400");
      }
      await expect(header.locator("h1")).toHaveCSS("font-size", "14px");
      await expect(header.locator("h1")).toHaveCSS("line-height", "20px");
      await expect(header.locator("p")).toHaveCSS("font-size", "14px");
      await expect(header.locator("p")).toHaveCSS("line-height", mobile ? "18px" : "20px");
      const browser = header.locator(".browser-session-status");
      const refresh = header.locator(".session-refresh");
      const buttonBounds = (await browser.boundingBox())!;
      const refreshBounds = (await refresh.boundingBox())!;
      expect(buttonBounds.width).toBe(refreshBounds.width);
      expect(buttonBounds.height).toBe(refreshBounds.height);
      expect((await browser.locator("svg").boundingBox())!.width).toBe(
        (await refresh.locator("svg").boundingBox())!.width,
      );
      await expect(browser).toHaveText("");
      if (mobile) {
        expect(bounds.y).toBe(34);
        expect(bounds.x).toBe(24);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 20);
        await expectAligned();
        await expect(page.locator(".timeline")).toHaveCSS("padding-left", "32px");
        await expect(page.locator(".timeline")).toHaveCSS("padding-right", "28px");
      }
      const actions = await header
        .locator(
          ".workspace-title > button, .workspace-actions > button, .workspace-actions > details > summary",
        )
        .evaluateAll((elements) =>
          elements
            .filter((element) => element.getClientRects().length)
            .map((element) => {
              const { left, right, top, bottom } = element.getBoundingClientRect();
              return { left, right, top, bottom };
            }),
        );
      for (const action of actions) {
        expect(action.left).toBeGreaterThanOrEqual(bounds.x);
        expect(action.right).toBeLessThanOrEqual(bounds.x + bounds.width);
        expect(action.top).toBeGreaterThanOrEqual(bounds.y);
        expect(action.bottom).toBeLessThanOrEqual(bounds.y + bounds.height);
      }
      expect(
        await page
          .locator(".conversation-scroll")
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      await expect(page.locator(".user-input-freeform-label")).toHaveCSS("font-weight", "400");
      await expect(page.locator(".attention-card button.primary")).toHaveCSS("font-weight", "400");
      if (mobile) {
        await page.goto("/new?projectId=project-nest");
        await waitForVisualReady(page);
        for (const inset of [0, 34]) {
          await page.addStyleTag({
            content: `:root { --safe-area-inset-top: ${inset}px; --safe-area-inset-bottom: ${inset}px; }`,
          });
          expect((await header.boundingBox())!.y).toBe(inset);
          const composer = (await page.locator(".composer-box").boundingBox())!;
          expect(composer.y + composer.height).toBe(900 - inset);
        }
      }
    }
  });

  test(`${theme}: settings keep native controls and chat uses soft checkboxes`, async ({
    page,
  }) => {
    await installVisualFixture(page, { theme });
    await page.goto("/settings?section=application");
    const checkbox = page.getByRole("checkbox").first();
    await expect(checkbox).toBeVisible();
    await expect(checkbox).toHaveCSS(
      "accent-color",
      theme === "light" ? "rgb(32, 33, 31)" : "rgb(241, 242, 239)",
    );
    await checkbox.focus();
    await expect(checkbox).toHaveCSS("outline-style", "solid");
    await page.goto("/threads/session-main");
    const completedStep = page.locator('.plan-checklist input[type="checkbox"]:checked').first();
    await expect(completedStep).toHaveCSS("appearance", "none");
    await expect(completedStep).toHaveCSS("border-radius", "7px");
    await expect(completedStep).toHaveCSS(
      "background-color",
      theme === "light" ? "rgb(225, 230, 218)" : "rgb(59, 69, 53)",
    );
    await page.emulateMedia({ forcedColors: "active" });
    await expect(completedStep).toHaveCSS("appearance", "auto");
  });
}
