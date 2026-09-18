import { expect, test } from "@playwright/test";
import { installVisualFixture, snapshot, waitForVisualReady } from "./fixtures";

const defaults = {
  ui: 14,
  message: 15,
  description: 14,
  technical: 14,
  caption: 12,
  micro: 12,
  section: 14,
  dialog: 14,
  display: 22,
};
const profiles = {
  minimum: Object.fromEntries(Object.keys(defaults).map((key) => [key, 10])),
  maximum: Object.fromEntries(Object.keys(defaults).map((key) => [key, 32])),
  mixed: {
    ui: 24,
    message: 28,
    description: 10,
    technical: 20,
    caption: 22,
    micro: 18,
    section: 32,
    dialog: 16,
    display: 30,
  },
};

for (const theme of ["light", "dark"] as const) {
  for (const language of ["ru", "en"] as const) {
    for (const width of [320, 390, 820, 821, 1440]) {
      for (const [profile, sizes] of Object.entries(profiles)) {
        test(`fonts ${profile} ${width} ${language} ${theme}: settings, chat, navigation and dialogs`, async ({
          page,
        }, testInfo) => {
          await page.setViewportSize({ width, height: 1000 });
          await installVisualFixture(page, {
            theme,
            snapshot: { ...snapshot, uiLanguage: language },
          });
          await page.route("http://127.0.0.1:4310/**", (route) => route.abort());
          await page.addInitScript(
            (value) => localStorage.setItem("codexnest.typography", JSON.stringify(value)),
            sizes,
          );
          await page.goto("/settings?section=application");
          const group = page.locator(".typography-settings");
          await expect(group.locator('input[type="number"]')).toHaveCount(9);
          for (const [role, size] of Object.entries(sizes)) {
            await expect(page.locator(`#font-size-${role}`)).toHaveValue(String(size));
            await expect(group.locator(`[data-font-role="${role}"]`)).toHaveCSS(
              "font-size",
              `${size}px`,
            );
          }
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
          for (const tab of await page.locator(".settings-section-tab").all()) {
            await tab.scrollIntoViewIfNeeded();
            await expect(tab).toBeInViewport();
            expect(await tab.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
          }
          expect(
            await page.locator(".settings-row").evaluateAll((els) =>
              els
                .filter((el) => el.scrollWidth > el.clientWidth)
                .map((el) => ({
                  text: el.textContent,
                  width: el.clientWidth,
                  scrollWidth: el.scrollWidth,
                  children: Array.from(el.querySelectorAll("*"), (child) => ({
                    tag: child.tagName,
                    cls: child.className,
                    width: child.clientWidth,
                    scrollWidth: child.scrollWidth,
                  })).filter((child) => child.scrollWidth > child.width),
                })),
            ),
          ).toEqual([]);
          await group.locator(".typography-reset button").scrollIntoViewIfNeeded();
          await expect(group.locator(".typography-reset button")).toBeInViewport();
          if (width === 390 && language === "ru" && profile === "maximum") {
            await page.locator("#font-size-ui").scrollIntoViewIfNeeded();
            await page.screenshot({ path: testInfo.outputPath(`settings-${theme}.png`) });
          }
          await page.goto("/threads/session-main");
          await waitForVisualReady(page);
          const input = page.locator(".composer-box textarea");
          await expect(input).toHaveValue("Добавить короткую подпись к итоговой проверке");
          await expect(input).toHaveCSS("font-size", `${sizes.message}px`);
          await expect(page.locator(".message.userMessage").first()).toHaveCSS(
            "font-size",
            `${sizes.message}px`,
          );
          await expect(page.locator(".workspace-title h1")).toHaveCSS("font-size", `${sizes.ui}px`);
          const header = page.locator(".thread-workspace .workspace-header");
          const bounds = (await header.boundingBox())!;
          for (const text of await header.locator("h1,p").all()) {
            const box = (await text.boundingBox())!;
            expect(box.y).toBeGreaterThanOrEqual(bounds.y - 1);
            expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
          }
          await input.fill("Текст\n".repeat(10));
          const tall = (await page.locator(".composer-box").boundingBox())!.height;
          await input.fill("");
          await expect
            .poll(async () => (await page.locator(".composer-box").boundingBox())!.height)
            .toBeLessThan(tall);
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
          await page.locator(".model-toggle").click();
          const dialog = page.getByRole("dialog");
          await expect(dialog.locator("h2")).toHaveCSS("font-size", `${sizes.dialog}px`);
          expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
          await dialog.locator(".model-settings-option").last().scrollIntoViewIfNeeded();
          await expect(dialog.locator(".model-settings-option").last()).toBeInViewport();
          await page.keyboard.press("Escape");
          if (width <= 820)
            await page
              .getByRole("button", {
                name: language === "ru" ? "Открыть список задач" : "Open task list",
              })
              .click();
          const sidebar = page.locator(".sidebar");
          await expect(sidebar.locator(".thread-link-title").first()).toHaveCSS(
            "font-size",
            `${sizes.ui}px`,
          );
          const mode = sidebar.locator(".session-list-mode");
          for (const button of await mode.locator("button").all()) {
            await button.scrollIntoViewIfNeeded();
            await expect(button).toBeInViewport();
            expect(await button.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
          }
          if (width === 390 && language === "ru" && profile === "maximum")
            await page.screenshot({ path: testInfo.outputPath(`sidebar-${theme}.png`) });
        });
      }
    }
  }
}

test("font controls apply independently, persist, and reset", async ({ page }) => {
  await installVisualFixture(page, { theme: "light", preserveLocalStorage: true });
  await page.route("http://127.0.0.1:4310/**", (route) => route.abort());
  await page.goto("/settings?section=application");
  await page.locator("#font-size-ui").fill("20");
  await expect(page.locator("body")).toHaveCSS("font-size", "20px");
  await page.locator("#font-size-technical").fill("24");
  await expect(page.locator('[data-font-role="description"]')).toHaveCSS("font-size", "14px");
  await page.reload();
  await expect(page.locator("#font-size-ui")).toHaveValue("20");
  await expect(page.locator("#font-size-technical")).toHaveValue("24");
  await page.locator("#font-size-ui").fill("99");
  await page.locator("#font-size-ui").blur();
  await expect(page.locator("#font-size-ui")).toHaveValue("20");
  await page.getByRole("button", { name: "Сбросить размер: Основной интерфейс" }).click();
  await expect(page.locator("body")).toHaveCSS("font-size", "14px");
  await expect(page.locator("#font-size-technical")).toHaveValue("24");
  await page.getByRole("button", { name: "Вернуть стандартные размеры" }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-custom-typography");
  await page.reload();
  for (const [role, size] of Object.entries(defaults))
    await expect(page.locator(`#font-size-${role}`)).toHaveValue(String(size));
});
