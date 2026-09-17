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
              "- Сохранить текущую геометрию композера и боковой колонки.",
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
      await page.addStyleTag({ content: `:root { --app-safe-area-top: ${safeTop}px; }` });
      const header = page.locator(".workspace-header");
      const scroll = page.locator(".conversation-scroll");
      const plan = page.locator(".message.plan");
      const bounds = (await header.boundingBox())!;
      expect(bounds.height).toBe(44);
      expect(bounds.y).toBe(safeTop + 8);
      expect((await scroll.boundingBox())!.y).toBe(safeTop);

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
          ({ headerBounds, cardBounds, safeTop }) => {
            const at = (x: number, y: number) => document.elementFromPoint(x, y);
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
          },
        );
      const expectedLayers = {
        leftCorner: true,
        rightCorner: true,
        center: true,
        statusBar: false,
      };
      expect(await checkLayers()).toEqual(expectedLayers);
      if (browserName === "chromium" && [320, 390, 821, 1440].includes(width)) {
        await expect(page).toHaveScreenshot(`chat-header-scrolled-${width}-${theme}.png`);
      }

      // A desktop inspector can narrow the conversation without changing the
      // viewport breakpoint. The overlay must still match the composer and card.
      if (!mobile) {
        await page.getByRole("button", { name: "Показать сведения", exact: true }).click();
        const narrowed = (await header.boundingBox())!;
        const composer = (await page.locator(".composer-box").boundingBox())!;
        expect(narrowed.x).toBeCloseTo(composer.x, 1);
        expect(narrowed.width).toBeCloseTo(composer.width, 1);
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
      await page.setViewportSize({ width, height: 460 });
      await page.locator(".composer textarea").focus();
      expect(await header.boundingBox()).toEqual(bounds);
      const composer = (await page.locator(".composer-box").boundingBox())!;
      expect(composer.y).toBeGreaterThan(bounds.y + bounds.height);
      expect(composer.y + composer.height).toBeLessThanOrEqual(460);
    });
  }
}
