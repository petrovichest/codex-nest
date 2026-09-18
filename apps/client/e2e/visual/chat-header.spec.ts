import { expect, test, type Page } from "@playwright/test";
import type { ActivityItem, ThreadDetail } from "@codexnest/protocol";

import { installVisualFixture, snapshot, waitForVisualReady } from "./fixtures";

async function openLongPlan(page: Page, theme: "light" | "dark") {
  const seed = structuredClone(snapshot);
  const summary = seed.threads.find((thread) => thread.id === "session-main")!;
  summary.title = "Сузить область лога и выровнять текст";
  summary.settings.collaborationMode = "plan";
  summary.browserStatus = "disabled";
  seed.threads.push({
    ...summary,
    id: "header-fork",
    title: "Проверка мобильной версии",
    relation: { kind: "session", sessionId: "header-fork", forkedFromId: summary.id },
  });
  const message = (
    id: string,
    type: "plan" | "agentMessage" | "userMessage",
    text: string,
  ): ActivityItem => ({
    id,
    type,
    text,
    status: "completed",
    images: [],
    timestamp: summary.updatedAt,
    phase: null,
  });
  const detail: ThreadDetail = {
    summary,
    olderTurnsCursor: null,
    queuedMessages: [],
    draft: null,
    turns: [
      {
        id: "header-turn",
        status: "completed",
        startedAt: summary.updatedAt - 2000,
        completedAt: summary.updatedAt,
        durationMs: 2000,
        items: [
          message("header-user", "userMessage", "Сделай шапку компактнее, сохрани все кнопки."),
          message(
            "header-plan",
            "plan",
            "# Компактная шапка чата\n\n" +
              "- Уменьшить высоту панели за счёт отступов, сохранив размеры текста и кнопок.\n" +
              "- На телефоне расположить непрозрачную шапку поверх области прокрутки.\n" +
              "- Длинные карточки должны непрерывно проходить за закруглениями панели.\n" +
              "- Сохранить все действия: браузер, ответвления, меню, обновление и сведения.\n" +
              "- Учесть безопасную область экрана и место для первого сообщения.\n" +
              "- Проверить потоковые ответы, подгрузку истории и сохранение прокрутки.\n" +
              "\n[Проверить отступы](https://example.test)\n\n" +
              "- Вопросы и подтверждения: выбор, собственный ответ и голосовой ввод.\n" +
              "- Переход к ссылке или полю ответа должен оставлять их ниже шапки.\n" +
              "- Меню ответвлений открывается рядом с панелью и поверх текста.\n" +
              "- Сведения и диалоги сохраняют доступные действия и клавиатурный фокус.\n" +
              "- Проверить длинный текст, код, таблицы и вложения в обеих темах.\n" +
              "- Сохранить текущую геометрию композера и боковой колонки.\n" +
              // Keep the plan taller than the viewport so its card can pass
              // behind the header while remaining in chronological order.
              "\n## Проверка результата\n\n" +
              "- Проверить край карточки под обоими закруглениями верхней панели.\n" +
              "- Убедиться, что панель остаётся неподвижной при прокрутке длинного плана.\n" +
              "- Повторить проверку с открытыми сведениями и узкой областью переписки.\n" +
              "- Проверить ссылку внутри карточки при переходе с клавиатуры.\n" +
              "- Проверить расположение первого сообщения под безопасной областью.\n" +
              "- Проверить последнюю строку плана над кнопками запуска.\n" +
              "- Повторить сценарий с открытой клавиатурой на телефоне.\n" +
              "- Проверить контраст текста и поверхности в светлой и тёмной теме.",
          ),
          message("header-outro", "agentMessage", "Размеры текста и кнопок сохраняются."),
        ],
      },
    ],
  };
  await installVisualFixture(page, { theme, snapshot: seed });
  await page.route("**/api/v1/threads/session-main", (route) =>
    route.fulfill({ json: detail, headers: { "access-control-allow-origin": "*" } }),
  );
  await page.goto("/threads/session-main");
  await expect(page.locator(".message.plan")).toBeVisible();
  await waitForVisualReady(page);
}

for (const width of [320, 390, 820, 821, 1100, 1440, 1920]) {
  for (const theme of ["light", "dark"] as const) {
    test(`${width}px ${theme}: cards scroll behind the rounded header without a straight cut`, async ({
      page,
      browserName,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await openLongPlan(page, theme);
      const mobile = width <= 820;
      const safeTop = width === 390 ? 34 : 0;
      const safeBottom = width === 390 ? 24 : 0;
      // Exercise the same inset variables supplied by Android's SystemBars bridge.
      await page.addStyleTag({
        content: `:root { --safe-area-inset-top: ${safeTop}px; --safe-area-inset-bottom: ${safeBottom}px; }`,
      });
      const header = page.locator(".workspace-header");
      const scroll = page.locator(".conversation-scroll");
      const plan = page.locator(".message.plan");
      const bounds = (await header.boundingBox())!;
      expect(bounds.height).toBe(44);
      expect(bounds.y).toBe(safeTop + (mobile ? 0 : 8));
      expect((await scroll.boundingBox())!.y).toBe(0);
      const expectPanelGeometry = async () => {
        const panel = (await header.boundingBox())!;
        const composer = (await page.locator(".composer-box").boundingBox())!;
        const message = (await plan.boundingBox())!;
        expect(message.x - composer.x).toBeCloseTo(8, 1);
        expect(composer.x + composer.width - message.x - message.width).toBeCloseTo(8, 1);
        if (mobile) {
          expect(composer.x).toBeCloseTo(panel.x, 1);
          expect(composer.width).toBeCloseTo(panel.width, 1);
        } else {
          const pane = (await page.locator(".conversation-pane").boundingBox())!;
          expect(panel.x).toBeCloseTo(pane.x + 20, 1);
          expect(panel.width).toBeCloseTo(pane.width - 40, 1);
          const title = (await page.locator(".workspace-title").boundingBox())!;
          const actions = (await page.locator(".workspace-actions").boundingBox())!;
          expect(title.x).toBeCloseTo(panel.x, 1);
          expect(actions.x + actions.width).toBeCloseTo(panel.x + panel.width, 1);
          expect(actions.x - title.x - title.width).toBeGreaterThanOrEqual(15.9);
          expect(message.width).toBeCloseTo(Math.min(880, pane.width) - 56, 1);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      };
      await expectPanelGeometry();
      if (mobile) {
        const composer = (await page.locator(".composer-box").boundingBox())!;
        expect(composer.y + composer.height).toBeCloseTo(844 - safeBottom, 1);
        expect(bounds.x).toBe(8);
        expect(bounds.width).toBe(width - 16);
        const protection = await page.locator(".conversation-pane").evaluate((element) => {
          const top = getComputedStyle(element, "::before");
          const bottom = getComputedStyle(element, "::after");
          return {
            topHeight: parseFloat(top.height),
            bottomHeight: parseFloat(bottom.height),
            topPointerEvents: top.pointerEvents,
            bottomPointerEvents: bottom.pointerEvents,
          };
        });
        expect(protection).toEqual({
          topHeight: safeTop ? safeTop + 12 : 0,
          bottomHeight: safeBottom ? safeBottom + 16 : 0,
          topPointerEvents: "none",
          bottomPointerEvents: "none",
        });
      }

      await scroll.evaluate((element) => {
        element.dispatchEvent(new WheelEvent("wheel", { deltaY: -500, bubbles: true }));
        element.scrollTop = 0;
      });
      const firstMessage = (await page.locator('[data-message-id="header-user"]').boundingBox())!;
      expect(firstMessage.y).toBeCloseTo(bounds.y + bounds.height + (mobile ? 22 : 28), 0);

      await scroll.evaluate((element) => {
        const card = element.querySelector(".message.plan")!;
        element.scrollTop += card.getBoundingClientRect().top + 200;
      });
      const card = (await plan.boundingBox())!;
      expect(card.y).toBeLessThan(bounds.y);
      expect(card.y + card.height).toBeGreaterThan(bounds.y + bounds.height + 100);
      expect(await header.boundingBox()).toEqual(bounds);
      const checkLayers = async () =>
        page.evaluate(
          ({ headerBounds, cardBounds, safeTop, mobile }) => {
            const at = (x: number, y: number) => document.elementFromPoint(x, y);
            if (!mobile) {
              const title = document.querySelector(".workspace-title")!.getBoundingClientRect();
              const actions = document.querySelector(".workspace-actions")!.getBoundingClientRect();
              return {
                gap: !!at((title.right + actions.left) / 2, title.top + 22)?.closest(
                  ".conversation-scroll",
                ),
                title: !!at(title.left + title.width / 2, title.top + 22)?.closest(
                  ".workspace-title",
                ),
                actions: !!at(actions.left + actions.width / 2, actions.top + 22)?.closest(
                  ".workspace-actions",
                ),
                titleCorner: !!at(title.left + 1, title.bottom - 1)?.closest(
                  ".conversation-scroll",
                ),
                actionsCorner: !!at(actions.right - 1, actions.bottom - 1)?.closest(
                  ".conversation-scroll",
                ),
              };
            }
            const left = Math.max(cardBounds.x, headerBounds.x) + 1;
            const right =
              Math.min(cardBounds.x + cardBounds.width, headerBounds.x + headerBounds.width) - 1;
            return {
              // Both curves reveal the card; an in-flow header fails these checks.
              leftCorner: !!at(left, headerBounds.y + headerBounds.height - 2)?.closest(
                ".message.plan",
              ),
              rightCorner: !!at(right, headerBounds.y + headerBounds.height - 2)?.closest(
                ".message.plan",
              ),
              center: !!at(headerBounds.x + headerBounds.width / 2, headerBounds.y + 22)?.closest(
                ".workspace-header",
              ),
              statusBar: safeTop > 0 && !!at(left, safeTop - 1)?.closest(".conversation-scroll"),
            };
          },
          {
            headerBounds: (await header.boundingBox())!,
            cardBounds: (await plan.boundingBox())!,
            safeTop,
            mobile,
          },
        );
      const expectedLayers = mobile
        ? {
            leftCorner: true,
            rightCorner: true,
            center: true,
            statusBar: safeTop > 0,
          }
        : { gap: true, title: true, actions: true, titleCorner: true, actionsCorner: true };
      expect(await checkLayers()).toEqual(expectedLayers);
      if (browserName === "chromium" && [320, 390, 821, 1440].includes(width)) {
        await expect(page).toHaveScreenshot(`chat-header-scrolled-${width}-${theme}.png`);
      }

      // Capsules follow the conversation edges when the inspector narrows it;
      // the composer and transcript keep their independent centered widths.
      if (!mobile) {
        await page.getByRole("button", { name: "Показать сведения", exact: true }).click();
        await expectPanelGeometry();
        if (width >= 1280) {
          await scroll.evaluate((element) => {
            element.scrollTop +=
              element.querySelector(".message.plan")!.getBoundingClientRect().top + 200;
          });
          expect(await checkLayers()).toEqual(expectedLayers);
        }
        await page
          .getByRole("complementary", { name: "Сведения о задаче", exact: true })
          .getByRole("button", { name: "Закрыть сведения", exact: true })
          .click();
        expect(await header.boundingBox()).toEqual(bounds);
        await expectPanelGeometry();
      }

      // Native scrollIntoView and keyboard focus must reveal a target below the overlay.
      const link = plan.getByRole("link", { name: "Проверить отступы" });
      const targetY = (await link.boundingBox())!.y;
      await scroll.evaluate(
        (element, distance) => {
          element.scrollTop += distance;
        },
        targetY - bounds.y - 10,
      );
      await link.focus();
      await expect(link).toBeFocused();
      expect((await link.boundingBox())!.y).toBeGreaterThan(bounds.y + bounds.height);
      // A wide layout may reach the end of the history before the link reaches
      // the top inset. Account for that clamp and integer scroll offsets.
      const remainingScroll = await scroll.evaluate(
        (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
      );
      const expectedLinkTop = Math.max(
        bounds.y + bounds.height + 8,
        (await link.boundingBox())!.y - remainingScroll,
      );
      await link.evaluate((element) => element.scrollIntoView({ block: "start" }));
      expect(Math.abs((await link.boundingBox())!.y - expectedLinkTop)).toBeLessThan(1);

      const forkTrigger = page.getByLabel("Показать ответвления: 1");
      await forkTrigger.click();
      const popover = page.locator(".fork-children-popover");
      await expect(popover).toBeVisible();
      const popoverBounds = (await popover.boundingBox())!;
      if (mobile) expect(popoverBounds.y).toBe(bounds.y + bounds.height + 8);
      else expect(popoverBounds.y).toBeGreaterThanOrEqual(bounds.y + bounds.height);
      expect(
        await popover.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return element.contains(document.elementFromPoint(rect.x + 12, rect.y + 12));
        }),
      ).toBe(true);
      await expect(popover.getByRole("link")).toBeInViewport();
      await forkTrigger.click();
      await page.getByRole("button", { name: "Показать сведения", exact: true }).click();
      await page
        .getByRole("complementary", { name: "Сведения о задаче", exact: true })
        .getByRole("button", { name: "Закрыть сведения", exact: true })
        .click();
      await page.getByLabel("Действия с задачей", { exact: true }).click();
      await page.getByRole("button", { name: "Переименовать", exact: true }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);

      // A keyboard-sized viewport keeps the header fixed and leaves the composer reachable.
      await page.locator(".composer textarea").focus();
      await page.setViewportSize({ width, height: 460 });
      await expect(page.locator(".composer")).toHaveClass(/keyboard-open/);
      expect(await header.boundingBox()).toEqual(bounds);
      const composer = (await page.locator(".composer-box").boundingBox())!;
      expect(composer.y).toBeGreaterThan(bounds.y + bounds.height);
      expect(composer.y + composer.height).toBeLessThanOrEqual(460);
      if (mobile) {
        expect(composer.y + composer.height).toBeCloseTo(460, 1);
        expect(
          await page
            .locator(".conversation-pane")
            .evaluate((element) => getComputedStyle(element, "::after").display),
        ).toBe("none");
        await page.setViewportSize({ width, height: 844 });
        await expect(page.locator(".composer")).not.toHaveClass(/keyboard-open/);
        const restored = (await page.locator(".composer-box").boundingBox())!;
        expect(restored.y + restored.height).toBeCloseTo(844 - safeBottom, 1);
        expect(
          await page
            .locator(".conversation-pane")
            .evaluate((element) => getComputedStyle(element, "::after").display),
        ).not.toBe("none");
      }
    });
  }
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [821, 1440, 1920]) {
    test(`${width}px ${theme}: title capsule grows before truncating and keeps actions reachable`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await openLongPlan(page, theme);
      const title = page.locator(".workspace-title");
      const heading = title.locator("h1");
      const project = title.locator(".workspace-context");
      const actions = page.locator(".workspace-actions");
      const originalActions = (await actions.boundingBox())!;
      const originalComposer = await page.locator(".composer-box").boundingBox();
      const setTitle = async (text: string) => {
        await heading.evaluate((element, value) => {
          element.textContent = value;
        }, text);
        await waitForVisualReady(page);
        return (await title.boundingBox())!;
      };
      const short = await setTitle("Панель");
      expect(await heading.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
        false,
      );
      const long = await setTitle(
        "Исправление отображения скриншотов в сообщениях и оформление верхней панели на компьютере",
      );
      expect(long.width).toBeGreaterThan(short.width);
      if (width >= 1440)
        expect(await heading.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
          false,
        );
      const longest = await setTitle("Очень длинное название задачи ".repeat(30));
      expect(longest.width).toBeCloseTo(originalActions.x - longest.x - 16, 1);
      expect(await heading.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
        true,
      );
      await expect(heading).toHaveCSS("text-overflow", "ellipsis");
      expect(await actions.boundingBox()).toEqual(originalActions);
      expect(await page.locator(".composer-box").boundingBox()).toEqual(originalComposer);
      expect((await setTitle("Панель")).width).toBeCloseTo(short.width, 1);

      await project.evaluate((element) => {
        element.textContent = "Очень длинное имя проекта ".repeat(30);
      });
      await setTitle("Очень длинное название задачи ".repeat(30));
      const expectContained = async () => {
        const capsule = (await title.boundingBox())!;
        const buttons = (await actions.boundingBox())!;
        expect(buttons.x - capsule.x - capsule.width).toBeGreaterThanOrEqual(15.9);
        for (const text of await title.locator("h1, p").all()) {
          const bounds = (await text.boundingBox())!;
          expect(bounds.x).toBeGreaterThanOrEqual(capsule.x);
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(capsule.x + capsule.width + 1);
          expect(bounds.y + bounds.height).toBeLessThanOrEqual(capsule.y + capsule.height + 1);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await expect(
          page.getByRole("button", { name: "Показать сведения", exact: true }),
        ).toBeInViewport();
      };
      await expectContained();
      await page.getByRole("button", { name: "Показать сведения", exact: true }).click();
      await expectContained();
      await page
        .getByRole("complementary", { name: "Сведения о задаче", exact: true })
        .getByRole("button", { name: "Закрыть сведения", exact: true })
        .click();
      await page.evaluate(() => {
        document.documentElement.dataset.customTypography = "true";
        document.documentElement.style.setProperty("--text-ui", "32px");
        document.documentElement.style.setProperty("--text-small", "32px");
      });
      await expectContained();
      expect((await title.boundingBox())!.height).toBeGreaterThan(44);
    });
  }
}
