import { expect, test, type Page } from "@playwright/test";
import { installVisualFixture, waitForVisualReady } from "./fixtures";

async function setup(page: Page, theme: "light" | "dark", fallback = false) {
  await installVisualFixture(page, { theme });
  await page.route("http://127.0.0.1:4310/**", (route) => route.abort());
  if (fallback) {
    await page.addInitScript(() => {
      const supports = CSS.supports.bind(CSS);
      CSS.supports = (property: string, value?: string) =>
        property === "field-sizing"
          ? false
          : value === undefined
            ? supports(property)
            : supports(property, value);
    });
  }
  await page.goto("/threads/session-main");
  if (fallback)
    await page.addStyleTag({ content: ".composer-box textarea { field-sizing: fixed; }" });
  await waitForVisualReady(page);
  await page.locator(".composer-box textarea").fill("");
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [320, 390, 820, 821, 1440]) {
    test(`compact composer at ${width}px in ${theme}: one line, wrapping, growth and clear`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await setup(page, theme);
      const field = page.locator(".composer-box textarea");
      const bubble = page.locator(".composer-box");
      const compactHeight = width <= 820 ? 85 : 93;
      const height = async () => Math.round((await bubble.boundingBox())!.height);
      await expect.poll(height).toBe(compactHeight);
      await expect(field).toHaveCSS("font-size", "15px");
      await expect(field).toHaveCSS("line-height", "22.5px");
      await expect(bubble).toHaveCSS("border-radius", width <= 820 ? "24px" : "28px");
      await field.evaluate((el) => {
        el.placeholder =
          "A long description of the goal that must not reserve more input rows. ".repeat(4);
      });
      await expect.poll(height).toBe(compactHeight);
      await field.fill("Проверь изменения");
      await expect.poll(height).toBe(compactHeight);
      await field.fill("Первая строка\nВторая строка");
      await expect.poll(height).toBe(compactHeight + 22);
      await field.fill("Длинная строка без ручного переноса. ".repeat(5));
      await expect.poll(height).toBeGreaterThan(compactHeight);
      await field.fill("Длинный ввод\n".repeat(30));
      await expect.poll(async () => (await field.boundingBox())!.height).toBe(190);
      expect(await field.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
      await field.fill("");
      await expect.poll(height).toBe(compactHeight);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      const surface = theme === "light" ? "rgb(248, 249, 246)" : "rgb(36, 39, 34)";
      await expect(bubble).toHaveCSS("background-color", surface);
      await expect(page.locator(".sidebar")).toHaveCSS("background-color", surface);
      await expect(page.locator(".message.userMessage > .message-body").first()).toHaveCSS(
        "background-color",
        surface,
      );
    });
  }

  test(`${theme} fallback composer resizes on edits and width changes`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await setup(page, theme, true);
    const field = page.locator(".composer-box textarea");
    const height = async () =>
      Math.round((await page.locator(".composer-box").boundingBox())!.height);
    await expect.poll(height).toBe(93);
    await field.fill("Проверь порядок кнопок и одинаковый тон подложек.");
    await expect.poll(height).toBe(93);
    await page.setViewportSize({ width: 320, height: 900 });
    await expect.poll(height).toBeGreaterThan(85);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(height).toBe(93);
    await field.fill("Много строк\n".repeat(30));
    await expect.poll(async () => (await field.boundingBox())!.height).toBe(190);
    await field.fill("");
    await expect.poll(height).toBe(93);
    await page.setViewportSize({ width: 390, height: 900 });
    await expect.poll(height).toBe(85);
  });

  test(`${theme} composer controls and model menu use floating states`, async ({ page }) => {
    await setup(page, theme);
    const surface = theme === "light" ? "rgb(248, 249, 246)" : "rgb(36, 39, 34)";
    const selected = page.locator(".composer .team-toggle");
    const action = page.locator(".composer-add-image");
    await expect(selected).toHaveCSS("background-color", surface);
    const shadow = await selected.evaluate((el) => getComputedStyle(el).boxShadow);
    expect(shadow).not.toBe("none");
    await expect(action).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await action.hover();
    await expect(action).toHaveCSS("background-color", surface);
    await expect(action).toHaveCSS("box-shadow", shadow);
    await page.mouse.move(1, 1);
    await action.focus();
    await expect(action).toHaveCSS("box-shadow", shadow);
    await action.hover();
    await page.mouse.down();
    expect(await action.evaluate((el) => getComputedStyle(el).boxShadow)).toContain("inset");
    await page.mouse.move(1, 1);
    await page.mouse.up();
    await page.locator(".composer .model-toggle").click();
    const popup = page.getByRole("dialog", { name: "Настройки модели" });
    await expect(popup).toHaveCSS("background-color", surface);
    await expect(popup.locator(".model-settings-option.active").first()).toHaveCSS(
      "background-color",
      surface,
    );
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    await expect(page.locator(".composer .model-toggle")).toBeFocused();
  });
}
