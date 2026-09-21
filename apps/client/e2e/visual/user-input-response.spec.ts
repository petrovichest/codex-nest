import { expect, test } from "@playwright/test";
import type { ActivityItem, ThreadDetail } from "@codexnest/protocol";
import { TYPOGRAPHY_DEFAULTS } from "../../src/typography";
import { installVisualFixture, snapshot, waitForVisualReady } from "./fixtures";

for (const theme of ["light", "dark"] as const) {
  for (const width of [320, 390, 1440]) {
    for (const language of ["ru", "en"] as const) {
      test(`submitted answers ${theme} ${width} ${language}: context, typography and history`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 1000 });
        const seed = structuredClone(snapshot);
        seed.uiLanguage = language;
        seed.attention = [];
        const summary = seed.threads.find((thread) => thread.id === "session-main")!;
        summary.settings.collaborationMode = "default";
        summary.browserStatus = "disabled";
        const response: Extract<ActivityItem, { type: "userInputResponse" }> = {
          type: "userInputResponse",
          id: "submitted-answers",
          status: "completed",
          timestamp: Date.UTC(2026, 7, 3, 12, 0),
          afterItemId: null,
          entries:
            language === "ru"
              ? [
                  {
                    header: "Тейк-профит",
                    question:
                      "Как фиксировать TP +200% в лайве, где итог зависит от реальной цены продажи?",
                    answers: ["По сумме продажи (Recommended)"],
                  },
                  {
                    header: "Открытые",
                    question:
                      "Сколько позиций по 0,1 SOL разрешить держать одновременно при балансе 2 SOL?",
                    answers: ["В пределах баланса"],
                  },
                ]
              : [
                  {
                    header: "Take profit",
                    question:
                      "How should we measure +200% take profit when the result depends on the actual sale price?",
                    answers: ["By sale proceeds (Recommended)"],
                  },
                  {
                    header: "Open positions",
                    question: "How many 0.1 SOL positions can remain open with a balance of 2 SOL?",
                    answers: ["Within the available balance"],
                  },
                ],
        };
        const detail: ThreadDetail = {
          summary,
          olderTurnsCursor: null,
          queuedMessages: [],
          draft: null,
          turns: [
            {
              id: "answer-turn",
              status: "completed",
              startedAt: response.timestamp - 1000,
              completedAt: response.timestamp,
              durationMs: 1000,
              progress: null,
              items: [response],
            },
          ],
        };
        await installVisualFixture(page, { theme, snapshot: seed });
        await page.addInitScript(
          (value) => localStorage.setItem("codexnest.uiLanguage", value),
          language,
        );
        await page.route("**/api/v1/threads/session-main", (route) =>
          route.fulfill({ json: detail, headers: { "access-control-allow-origin": "*" } }),
        );
        await page.goto("/threads/session-main");
        const card = page.locator(".user-input-response");
        await expect(card).toHaveCount(1);
        await expect(card.locator("section")).toHaveCount(2);
        await waitForVisualReady(page);
        const body = card.locator(".message-body");
        await expect(body).toHaveCSS("padding", width <= 820 ? "16px" : "22px");
        await expect(body).toHaveCSS("border-radius", width <= 820 ? "24px" : "28px");
        await expect(body).toHaveCSS("row-gap", "24px");
        await expect(body).toHaveCSS(
          "background-color",
          theme === "dark" ? "rgb(36, 39, 34)" : "rgb(248, 249, 246)",
        );
        await expect(card.locator("section").last()).toHaveCSS("border-top-width", "0px");
        await expect(card.locator(".user-input-topic").first()).toHaveCSS(
          "font-size",
          `${TYPOGRAPHY_DEFAULTS.description}px`,
        );
        await expect(card.locator(".user-input-question").first()).toHaveCSS(
          "font-size",
          `${TYPOGRAPHY_DEFAULTS.message}px`,
        );
        await expect(card.locator(".user-input-answer").first()).toHaveCSS(
          "font-size",
          `${TYPOGRAPHY_DEFAULTS.message}px`,
        );
        await expect(card.locator(".user-input-answer").first()).toHaveCSS("font-weight", "500");
        await expect(card.locator(".user-input-question")).toHaveText(
          response.entries.map((entry) => entry.question),
        );
        await expect(card).not.toContainText("(Recommended)");
        expect(await body.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );
        if (language === "ru" && width !== 320)
          await expect(card).toHaveScreenshot(`submitted-answers-${width}-${theme}.png`);

        await page.reload();
        await expect(card).toHaveCount(1);
        await expect(card.locator(".user-input-question")).toHaveText(
          response.entries.map((entry) => entry.question),
        );

        response.entries = [
          {
            header: "Long answer",
            question: "Explain the decision\nwith its full context.",
            answers: ["First paragraph\n\nSecond paragraph", "address".repeat(45)],
          },
        ];
        await page.reload();
        await expect(card.locator("section")).toHaveCount(1);
        await expect(card.locator(".user-input-answer")).toHaveCount(2);
        await expect(card.locator(".user-input-answer").first()).toHaveCSS(
          "white-space",
          "pre-wrap",
        );
        expect(await card.locator(".user-input-answer").first().textContent()).toBe(
          response.entries[0]!.answers[0],
        );
        expect(await body.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );
        expect(
          await page
            .locator(".conversation-scroll")
            .evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
      });
    }
  }
}
