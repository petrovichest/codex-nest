import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { AppUpdateStatus } from "@codexnest/protocol";

import { installVisualFixture, snapshot, waitForVisualReady } from "./fixtures";

for (const theme of ["light", "dark"] as const) {
  for (const language of ["ru", "en"] as const) {
    for (const width of [320, 390, 1440]) {
      test(`application actions ${width} ${language} ${theme}: grouped controls fit and keep keyboard order`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 1000 });
        await installVisualFixture(page, {
          theme,
          snapshot: { ...snapshot, uiLanguage: language },
        });
        await page.route("http://127.0.0.1:4310/**", (route) => route.abort());
        await page.goto("/settings?section=maintenance");
        const card = page.locator(".application-settings-card");
        const actions = card.locator(".application-settings-actions");
        const controls = actions.locator("button, a");
        await expect(controls).toHaveCount(5);
        await expect(card.locator(".settings-group-body")).not.toHaveAttribute("aria-busy");
        await waitForVisualReady(page);

        const update = card.getByRole("group", {
          name: language === "ru" ? "Обновление" : "Update",
          exact: true,
        });
        const downloads = card.getByRole("group", {
          name: language === "ru" ? "Загрузки и ссылки" : "Downloads and links",
          exact: true,
        });
        const check = update.getByRole("button").first();
        await expect(check).toBeEnabled();
        await expect(update.getByRole("button").last()).toBeDisabled();
        await check.focus();
        for (const control of await downloads.locator("a, button").all()) {
          await page.keyboard.press("Tab");
          await expect(control).toBeFocused();
        }
        await controls.last().blur();
        await page.mouse.move(0, 0);

        for (const group of [update, downloads]) {
          const row = group.locator(".settings-actions");
          await expect(row).toHaveCSS("flex-direction", width <= 520 ? "column" : "row");
        }
        expect(
          await actions.evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
        expect(
          await controls.evaluateAll((elements) =>
            elements.every((element) => element.scrollWidth <= element.clientWidth),
          ),
        ).toBe(true);
        for (const control of await controls.all()) {
          expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(
            width <= 520 ? 44 : 40,
          );
        }
        expect(
          (await new AxeBuilder({ page }).include(".application-settings-card").analyze())
            .violations,
        ).toEqual([]);
        if (language === "ru" && width !== 320) {
          await expect(actions).toHaveScreenshot(`application-actions-${width}-${theme}.png`);
        }

        await page.addInitScript(() =>
          localStorage.setItem("codexnest.typography", JSON.stringify({ ui: 32, caption: 22 })),
        );
        await page.reload();
        await expect(check).toBeEnabled();
        await waitForVisualReady(page);
        await expect(check).toHaveCSS("font-size", "32px");
        expect(
          await actions.evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
        expect(
          await controls.evaluateAll((elements) =>
            elements.every((element) => element.scrollWidth <= element.clientWidth),
          ),
        ).toBe(true);
        expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );
      });
    }
  }
}

for (const width of [320, 390, 1440]) {
  test(`application feedback ${width}: multiple notices expand without clipping`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await installVisualFixture(page, { theme: "light" });
    await page.route("http://127.0.0.1:4310/**", (route) => route.abort());
    const status: AppUpdateStatus = {
      supported: true,
      canUpdateWithActiveTurns: true,
      currentVersion: "0.1.9",
      latestVersion: "0.1.9",
      updateAvailable: false,
      operation: "idle",
      result: "updated",
      message: "CodexNest was updated successfully",
      checkedAt: null,
      updatedAt: null,
    };
    await page.route("**/api/v1/settings/app", (route) =>
      route.request().method() === "OPTIONS"
        ? route.fallback()
        : route.fulfill({
            json: status,
            headers: { "access-control-allow-origin": "*" },
          }),
    );
    await page.route("**/api/v1/settings/app/check", (route) =>
      route.request().method() === "OPTIONS"
        ? route.fallback()
        : route.fulfill({
            status: 503,
            json: {
              error: { code: "unavailable", message: "CodexNest is failed; retry after recovery" },
            },
            headers: { "access-control-allow-origin": "*" },
          }),
    );
    await page.goto("/settings?section=maintenance");
    const card = page.locator(".application-settings-card");
    const feedback = card.locator(".settings-feedback-slot");
    const check = card.getByRole("button", { name: "Проверить обновления", exact: true });
    await expect(feedback.getByText(status.message!, { exact: true })).toBeVisible();
    await check.click();
    await expect(card.getByRole("alert")).toContainText("CodexNest is failed");
    await expect(feedback.locator(".settings-notice")).toHaveCount(2);

    for (const uiSize of [17, 32]) {
      await page.evaluate(
        (size) => document.documentElement.style.setProperty("--text-ui", `${size}px`),
        uiSize,
      );
      await waitForVisualReady(page);
      await expect(feedback.locator(".settings-notice").first()).toHaveCSS(
        "font-size",
        `${uiSize}px`,
      );
      const geometry = await feedback.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          noticesFit: Array.from(element.children).every((notice) => {
            const rect = notice.getBoundingClientRect();
            return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
          }),
          bottom: bounds.bottom,
          actionsTop: element.nextElementSibling!.getBoundingClientRect().top,
        };
      });
      expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight + 1);
      expect(geometry.noticesFit).toBe(true);
      expect(geometry.actionsTop).toBeGreaterThanOrEqual(geometry.bottom);
    }
  });
}
