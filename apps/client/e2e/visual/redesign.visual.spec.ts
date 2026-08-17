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
    expect(typography.fontFamilies.map((family) => family.replaceAll('"', ""))).toEqual([
      "Onest, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
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

  test.describe("compact activity disclosure", () => {
    test.skip(
      ({ browserName }) => browserName !== "chromium",
      "The focused pixel contract is Chromium-only.",
    );

    test("11 desktop dark closed and expanded states", async ({ page }) => {
      await openVisualPage(page, "/threads/session-main", "dark", DESKTOP_VIEWPORT);
      const disclosure = page.locator(".turn-activity-disclosure");

      await expect(disclosure).toBeVisible();
      await expect(disclosure).toHaveScreenshot("11-desktop-dark-activity-closed.png");

      await disclosure.locator("summary").click();
      await expect(disclosure.getByText("Рассуждение")).toBeVisible();
      await expect(disclosure.getByText("npm test -- --runInBand")).toBeVisible();
      await expect(disclosure).toHaveScreenshot("12-desktop-dark-activity-open.png");

      await expectA11yClean(page, "expanded activity disclosure", ".turn-activity-disclosure");
    });
  });

  test.describe("fork lineage", () => {
    test.skip(
      ({ browserName }) => browserName !== "chromium",
      "The focused fork-navigation pixel contract is Chromium-only.",
    );

    test("13 desktop dark parent and fork popover", async ({ browserName, page }) => {
      await openVisualPage(page, "/threads/session-main", "dark", DESKTOP_VIEWPORT, {
        forkLineage: true,
      });

      const trigger = page.getByLabel("Показать ответвления: 3");
      await trigger.click();
      const popover = page.locator(".fork-children-popover");
      await expect(popover).toBeVisible();
      await expect(popover.locator(".fork-child-title")).toHaveText([
        "Проверка активной ветки",
        "Очередь альтернативы",
        "Архивная гипотеза",
      ]);
      await expect(popover.getByText("Архив", { exact: true })).toBeVisible();
      await expect(page).toHaveScreenshot("13-desktop-dark-forks.png", { fullPage: true });
      if (browserName === "chromium") {
        await expectA11yClean(page, "desktop fork navigation", ".workspace-header");
      }
    });

    test("14 mobile light middle fork navigation", async ({ browserName, page }) => {
      await openVisualPage(page, "/threads/session-fork-active", "light", PHONE_VIEWPORT, {
        forkLineage: true,
      });

      await expect(
        page.getByRole("link", { name: "Ответвление от Полировка мастерской" }),
      ).toBeVisible();
      const trigger = page.getByLabel("Показать ответвления: 1");
      await assertCompactTouchTarget(trigger);
      await trigger.click();
      const popover = page.locator(".fork-children-popover");
      await expect(popover.getByText("Уточнение активной ветки")).toBeVisible();
      await expect(popover).toHaveCSS("position", "fixed");
      const popoverBox = await popover.boundingBox();
      expect(popoverBox, "mobile fork popover must have a rendered box").not.toBeNull();
      expect(
        popoverBox!.x,
        "mobile fork popover stays inside the left edge",
      ).toBeGreaterThanOrEqual(9);
      expect(
        popoverBox!.x + popoverBox!.width,
        "mobile fork popover stays inside the right edge",
      ).toBeLessThanOrEqual(PHONE_VIEWPORT.width - 9);
      expect(
        await page
          .locator(".workspace-header")
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
        "mobile fork header fits without horizontal scrolling",
      ).toBe(true);
      await expect(page).toHaveScreenshot("14-mobile-light-forks.png", { fullPage: true });
      if (browserName === "chromium") {
        await expectA11yClean(page, "mobile fork navigation", ".workspace-header");
      }
    });
  });

  test.describe("reliable fork dialog", () => {
    test.skip(
      ({ browserName }) => browserName !== "chromium",
      "The fork dialog and mobile sheet pixel contract is Chromium-only.",
    );

    test("15 desktop light estimated choices", async ({ page }) => {
      await openVisualPage(page, "/threads/session-main", "light", DESKTOP_VIEWPORT, {
        forkEstimate: "ready",
      });
      await page.getByRole("button", { name: "Создать ответвление отсюда" }).click();
      const dialog = page.getByRole("dialog", { name: "Создать ветку" });
      await expect(dialog.getByRole("radio", { name: /Компактная/ })).toBeChecked();
      expect(
        await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth),
        "desktop fork dialog has no horizontal overflow",
      ).toBe(true);
      await expect(page).toHaveScreenshot("15-desktop-light-fork-dialog.png", { fullPage: true });
      await expectA11yClean(page, "desktop light fork dialog", ".fork-dialog");
    });

    test("16 desktop dark estimate failure", async ({ page }) => {
      await openVisualPage(page, "/threads/session-main", "dark", DESKTOP_VIEWPORT, {
        forkEstimate: "failure",
      });
      await page.getByRole("button", { name: "Создать ответвление отсюда" }).click();
      const dialog = page.getByRole("dialog", { name: "Создать ветку" });
      await expect(dialog.getByRole("radio", { name: /^Полная история/u })).toBeChecked();
      await expect(dialog.getByRole("radio", { name: /^Компактная/u })).toBeDisabled();
      await expect(page).toHaveScreenshot("16-desktop-dark-fork-dialog-failure.png", {
        fullPage: true,
      });
      await expectA11yClean(page, "desktop dark failed fork estimate", ".fork-dialog");
    });

    test("17 mobile light loading sheet", async ({ page }) => {
      await openVisualPage(page, "/threads/session-main", "light", PHONE_VIEWPORT, {
        forkEstimate: "loading",
      });
      await page.getByRole("button", { name: "Создать ответвление отсюда" }).click();
      const dialog = page.getByRole("dialog", { name: "Создать ветку" });
      await expect(dialog.getByText("Считаем…").first()).toBeVisible();
      await expect(dialog).toHaveCSS("border-bottom-left-radius", "0px");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
        "mobile fork sheet has no horizontal overflow",
      ).toBe(true);
      await expect(page).toHaveScreenshot("17-mobile-light-fork-sheet-loading.png", {
        fullPage: true,
      });
      await expectA11yClean(page, "mobile loading fork sheet", ".fork-dialog");
    });
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

  test("10 mobile dark Markdown artifact", async ({ browserName, page }) => {
    await openVisualPage(page, "/threads/session-main", "dark", PHONE_VIEWPORT);
    await page.getByRole("button", { name: "Показать сведения" }).click();
    const inspector = page.getByRole("complementary", { name: "Сведения о задаче" });
    await inspector.getByRole("tab", { name: /^Артефакты/u }).click();
    await inspector.getByRole("button", { name: "Открыть visual-audit.md" }).click();

    const viewer = page.getByRole("complementary", {
      name: "Просмотр файла visual-audit.md",
    });
    const report = viewer.locator(".artifact-markdown");
    await expect(report).toBeVisible();
    await expect(report).toHaveCSS("background-color", "rgb(31, 32, 31)");
    await expect(report).toHaveCSS("color", "rgb(233, 234, 231)");
    await expect(report.getByRole("heading", { level: 1 })).toHaveCSS(
      "color",
      "rgb(247, 248, 245)",
    );
    await expect(report.locator("code")).toHaveCSS("background-color", "rgb(37, 39, 37)");
    await expect(report.locator("table")).toHaveCSS("color", "rgb(233, 234, 231)");
    expect(
      await report.evaluate((element) => element.scrollWidth <= element.clientWidth),
      "mobile Markdown report fits without horizontal scrolling",
    ).toBe(true);

    await expect(page).toHaveScreenshot("10-mobile-dark-markdown-artifact.png", {
      fullPage: true,
    });
    if (browserName === "chromium") {
      await expectA11yClean(page, "mobile Markdown artifact", ".artifact-viewer");
    }
  });

  test("18 mobile dark voice failure remains actionable", async ({
    browserName,
    page,
  }, testInfo) => {
    test.skip(browserName !== "chromium", "The focused voice-failure audit is Chromium-only.");
    await openVisualPage(page, "/threads/session-main", "dark", PHONE_VIEWPORT, {
      voiceFailure: true,
    });

    const alert = page.getByRole("alert");
    await expect(alert).toHaveText(
      "В записи не обнаружена речь. Проверьте микрофон и запишите ещё раз.",
    );
    await expect(alert).toHaveCSS("border-top-width", "1px");
    expect(
      await alert.evaluate((element) => element.scrollWidth <= element.clientWidth),
      "voice failure fits without horizontal scrolling",
    ).toBe(true);
    const alertBox = await alert.boundingBox();
    expect(alertBox, "voice failure must have a rendered box").not.toBeNull();
    expect(alertBox!.x).toBeGreaterThanOrEqual(0);
    expect(alertBox!.x + alertBox!.width).toBeLessThanOrEqual(PHONE_VIEWPORT.width);

    const microphone = page.getByRole("button", { name: "Начать запись" });
    await expect(microphone).toBeEnabled();
    await assertCompactTouchTarget(microphone);
    await expectA11yClean(page, "mobile voice failure", ".composer");
    await page.screenshot({
      path: testInfo.outputPath("mobile-dark-voice-failure.png"),
      fullPage: true,
    });
  });
});

async function openVisualPage(
  page: Page,
  path: string,
  theme: "light" | "dark",
  viewport: { width: number; height: number },
  options: {
    connected?: boolean;
    forkEstimate?: "ready" | "loading" | "failure" | "unavailable";
    forkLineage?: boolean;
    notificationPrompt?: boolean;
    voiceFailure?: boolean;
  } = {},
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
