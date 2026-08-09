import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  DESKTOP_VIEWPORT,
  PHONE_VIEWPORT,
  installVisualFixture,
  waitForVisualReady,
} from "./fixtures";

test.describe("CodexNest redesign visual contract", () => {
  test("1 desktop light shell and notification dialog", async ({ browserName, page }) => {
    await openVisualPage(page, "/", "light", DESKTOP_VIEWPORT, { notificationPrompt: true });

    const notificationDialog = page.getByRole("dialog", { name: "Разрешить уведомления?" });
    await expect(page.getByRole("heading", { name: "Сверка токенов темы" })).toBeVisible();
    await expect(notificationDialog).toBeVisible();
    await expect(page.getByRole("button", { name: "Не сейчас" })).toBeFocused();
    await expect(page).toHaveScreenshot("01-desktop-light-shell-notification.png", {
      fullPage: true,
    });

    if (browserName === "chromium") {
      const declineNotifications = page.getByRole("button", { name: "Не сейчас" });
      const allowNotifications = page.getByRole("button", { name: "Разрешить уведомления" });
      await allowNotifications.focus();
      await page.keyboard.press("Tab");
      await expect(declineNotifications).toBeFocused();
      await declineNotifications.focus();
      await page.keyboard.press("Shift+Tab");
      await expect(allowNotifications).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(notificationDialog).toBeVisible();
      await declineNotifications.click();

      const projectOpener = page.getByRole("button", { name: "Добавить проект" });
      await projectOpener.focus();
      await projectOpener.click();
      const projectDialog = page.getByRole("dialog", { name: "Добавить проект" });
      await expect(projectDialog).toBeFocused();
      const closeDialog = page.getByRole("button", { name: "Закрыть", exact: true });
      const chooseDirectory = page.getByRole("button", { name: "Выбрать эту папку" });
      await expect(chooseDirectory).toBeEnabled();
      await chooseDirectory.focus();
      await page.keyboard.press("Tab");
      await expect(closeDialog).toBeFocused();
      await closeDialog.focus();
      await page.keyboard.press("Shift+Tab");
      await expect(chooseDirectory).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(projectDialog).toBeHidden();
      await expect(projectOpener).toBeFocused();
      await expectA11yClean(page, "desktop shell");
    }
  });

  test("2 desktop dark session transcript and composer", async ({ browserName, page }) => {
    await openVisualPage(page, "/threads/session-main", "dark", DESKTOP_VIEWPORT);
    await expect(page.getByRole("heading", { name: "Полировка мастерской" })).toBeVisible();
    await expect(page.getByText("Готово. Контраст выровнен", { exact: false })).toBeVisible();
    const typography = await page.locator("body, body *").evaluateAll((elements) => {
      const fontFamilies = new Set(elements.map((element) => getComputedStyle(element).fontFamily));
      const activeThread = elements.find((element) => element.matches(".thread-link.active"));
      const inactiveThread = elements.find((element) =>
        element.matches(".thread-link:not(.active)"),
      );
      return {
        activeThreadWeight: activeThread ? getComputedStyle(activeThread).fontWeight : null,
        fontFamilies: [...fontFamilies],
        inactiveThreadWeight: inactiveThread ? getComputedStyle(inactiveThread).fontWeight : null,
      };
    });
    expect(typography.fontFamilies).toEqual([
      'Onest, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    ]);
    expect(typography.activeThreadWeight).toBe(typography.inactiveThreadWeight);
    const checklistMarker = await page
      .locator(".plan-checklist li")
      .first()
      .evaluate((row) => {
        const checkbox = row.querySelector("input")!.getBoundingClientRect();
        const label = row.querySelector("span")!.getBoundingClientRect();
        return {
          centerOffset: checkbox.top + checkbox.height / 2 - (label.top + label.height / 2),
          height: checkbox.height,
          width: checkbox.width,
        };
      });
    expect(checklistMarker.width).toBe(16);
    expect(checklistMarker.height).toBe(16);
    expect(Math.abs(checklistMarker.centerOffset)).toBeLessThanOrEqual(2);
    await expect(page).toHaveScreenshot("02-desktop-dark-session.png", { fullPage: true });
    if (browserName === "chromium") await expectA11yClean(page, "desktop session");
  });

  test("9 desktop light message queue", async ({ browserName, page }) => {
    await openVisualPage(page, "/threads/session-attention", "light", DESKTOP_VIEWPORT);
    const queue = page.getByRole("region", { name: "Очередь сообщений" });
    await expect(queue).toBeVisible();
    await expect(queue.locator(".queued-messages-count")).toHaveText("·1");
    expect(
      await queue.evaluate((element) => element.scrollWidth <= element.clientWidth),
      "desktop queue fits without horizontal scrolling",
    ).toBe(true);
    await expect(page).toHaveScreenshot("09-desktop-light-queue.png", { fullPage: true });
    if (browserName === "chromium") {
      await expectA11yClean(page, "desktop message queue", ".queued-messages");
    }
  });

  test("3 desktop light settings", async ({ browserName, page }) => {
    await openVisualPage(page, "/settings?section=application", "light", DESKTOP_VIEWPORT);
    await expect(page.getByRole("heading", { name: "Интерфейс" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Язык интерфейса" })).toHaveValue("ru");
    await expect(page).toHaveScreenshot("03-desktop-light-settings.png", { fullPage: true });
    if (browserName === "chromium") await expectA11yClean(page, "desktop settings");
  });

  test("4 desktop dark inspector", async ({ page }) => {
    await openVisualPage(page, "/threads/session-main", "dark", DESKTOP_VIEWPORT);
    await page.getByRole("button", { name: "Показать сведения" }).click();
    const inspector = page.getByRole("complementary", { name: "Сведения о задаче" });
    await expect(inspector).toBeVisible();
    await expect(inspector.getByText("3 файла")).toBeVisible();
    await expect(page).toHaveScreenshot("04-desktop-dark-inspector.png", { fullPage: true });
  });

  test("5 mobile light drawer", async ({ page }) => {
    await openVisualPage(page, "/", "light", PHONE_VIEWPORT);
    const drawerToggle = page.getByRole("button", { name: "Открыть список задач" });
    await assertCompactTouchTarget(drawerToggle);
    await drawerToggle.click();
    await expect(page.getByRole("link", { name: "Настройки" })).toBeVisible();
    await assertCompactTouchTarget(page.getByRole("link", { name: "Настройки" }));
    await expect(
      page.getByRole("link", { name: "Сверка токенов темы" }).locator(".status"),
    ).toHaveCSS("background-color", "rgb(75, 156, 232)");
    await expect(
      page.getByRole("link", { name: "Выбор материала панели" }).locator(".status"),
    ).toHaveCSS("background-color", "rgb(229, 166, 43)");
    await expect(
      page.getByRole("link", { name: "Очередь мобильных правок" }).locator(".status"),
    ).toHaveCSS("background-color", "rgb(134, 183, 217)");
    await expect(page).toHaveScreenshot("05-mobile-light-drawer.png", { fullPage: true });
  });

  test("6 mobile dark session composer and attention", async ({ page }) => {
    await openVisualPage(page, "/threads/session-attention", "dark", PHONE_VIEWPORT);
    await expect(page.getByRole("region", { name: "Требуется внимание" })).toBeVisible();
    await expect(page.getByText("Какую поверхность использовать", { exact: false })).toBeVisible();
    const queue = page.getByRole("region", { name: "Очередь сообщений" });
    await expect(queue).toBeVisible();
    await expect(queue.locator(".queued-messages-count")).toHaveText("·1");
    await expect(queue.locator(".queued-message-order")).toHaveText("01");
    expect(
      await queue.evaluate((element) => element.scrollWidth <= element.clientWidth),
      "mobile queue fits without horizontal scrolling",
    ).toBe(true);
    await assertCompactTouchTarget(
      queue.getByRole("button", { name: "Изменить сообщение в очереди" }),
    );
    await assertCompactTouchTarget(
      queue.getByRole("button", { name: "Удалить сообщение из очереди" }),
    );
    await assertCompactTouchTarget(queue.getByRole("button", { name: "Отправить сейчас" }));
    await assertCompactTouchTarget(page.getByRole("button", { name: "Открыть список задач" }));
    await assertCompactTouchTarget(page.getByRole("button", { name: "Показать сведения" }));
    const composerOptions = page.locator(".composer-options");
    expect(
      await composerOptions.evaluate((element) => element.scrollWidth <= element.clientWidth),
      "mobile composer options fit without horizontal scrolling",
    ).toBe(true);
    await expect(page).toHaveScreenshot("06-mobile-dark-attention.png", { fullPage: true });
  });

  test("7 mobile light settings", async ({ page }) => {
    await openVisualPage(page, "/settings?section=application", "light", PHONE_VIEWPORT);
    await expect(page.getByRole("heading", { name: "Интерфейс" })).toBeVisible();
    await assertCompactTouchTarget(page.getByRole("button", { name: "Открыть список задач" }));
    await expect(page).toHaveScreenshot("07-mobile-light-settings.png", { fullPage: true });
  });

  test("8 mobile dark setup", async ({ page }) => {
    await openVisualPage(page, "/", "dark", PHONE_VIEWPORT, { connected: false });
    await expect(page.getByRole("heading", { name: "Подключение к CodexNest" })).toBeVisible();
    await expect(page.getByLabel("Адрес сервера")).toHaveValue("http://");
    await expect(page).toHaveScreenshot("08-mobile-dark-setup.png", { fullPage: true });
  });
});

async function openVisualPage(
  page: Page,
  path: string,
  theme: "light" | "dark",
  viewport: { width: number; height: number },
  options: { connected?: boolean; notificationPrompt?: boolean } = {},
): Promise<void> {
  await page.setViewportSize(viewport);
  await installVisualFixture(page, { theme, ...options });
  await page.goto(path);
  await waitForVisualReady(page);
}

async function expectA11yClean(page: Page, surface: string, include?: string): Promise<void> {
  const builder = new AxeBuilder({ page });
  if (include) builder.include(include);
  const { violations } = await builder.analyze();
  const report = violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    targets: violation.nodes.map((node) => node.target.join(" ")),
  }));
  expect(report, `${surface} has axe violations`).toEqual([]);
}

async function assertCompactTouchTarget(locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, "mobile action must have a rendered box").not.toBeNull();
  expect(box!.width, "mobile action width").toBeGreaterThanOrEqual(32);
  expect(box!.height, "mobile action height").toBeGreaterThanOrEqual(32);
  expect(box!.height, "mobile action stays compact").toBeLessThanOrEqual(34);
}
