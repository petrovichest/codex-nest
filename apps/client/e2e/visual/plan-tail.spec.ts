import { expect, test } from "@playwright/test";
import type { ActivityItem, ThreadDetail, TurnView } from "@codexnest/protocol";
import {
  DESKTOP_VIEWPORT,
  PHONE_VIEWPORT,
  installVisualFixture,
  mainThread,
  snapshot,
  waitForVisualReady,
} from "./fixtures";

function message(
  type: "userMessage" | "agentMessage" | "plan",
  id: string,
  text: string,
): ActivityItem {
  return { type, id, text, status: "completed", timestamp: 2, images: [], phase: null };
}

function turn(id: string, items: ActivityItem[]): TurnView {
  return {
    id,
    items,
    status: "completed",
    startedAt: 1,
    completedAt: 2,
    durationMs: 1_000,
    progress: {
      startedAt: 1,
      explanation: null,
      steps: [],
      filesChanged: 0,
      additions: 0,
      deletions: 0,
    },
  };
}

for (const viewport of [DESKTOP_VIEWPORT, PHONE_VIEWPORT]) {
  test(`latest plan stays below the discussion and above the composer at ${viewport.width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const summary = {
      ...mainThread,
      settings: { ...mainThread.settings, collaborationMode: "plan" as const },
    };
    await installVisualFixture(page, {
      theme: "light",
      snapshot: { ...snapshot, threads: [summary], attention: [] },
    });
    const original = turn("original", [
      message("userMessage", "request", "Составь план ускорения запросов"),
      message("plan", "old-plan", "## Исходный план\n\nПроверить время подключения."),
    ]);
    const discussion = turn("discussion", [
      message("userMessage", "clarification", "Добавь прогрев соединений"),
      message("agentMessage", "explanation", "Учту прогрев соединений в плане."),
    ]);
    const detail: ThreadDetail = {
      summary,
      turns: [original, discussion],
      queuedMessages: [],
      olderTurnsCursor: null,
      draft: null,
    };
    await page.route("https://codexnest.visual/api/v1/threads/session-main", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify(detail),
      });
    });
    await page.goto("/threads/session-main");
    const tail = page.locator(".timeline > .latest-plan:last-child");
    await expect(tail.getByText("План ещё не обновлён после уточнений")).toBeVisible();
    await expect(page.locator(".message.plan")).toHaveCount(1);
    await expect(tail.getByRole("button", { name: "Да, реализуй этот план" })).toBeDisabled();

    detail.turns = [
      original,
      {
        ...discussion,
        items: [
          ...discussion.items,
          message(
            "plan",
            "updated-plan",
            "## Обновлённый план\n\n1. Прогреть соединения.\n2. Измерить время запроса.",
          ),
          message("agentMessage", "closing", "Проверим результат замерами."),
        ],
      },
    ];
    await page.reload();
    await expect(tail.getByRole("heading", { name: "Обновлённый план" })).toBeVisible();
    await expect(page.getByText("План ещё не обновлён после уточнений")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Обновлённый план" })).toHaveCount(1);
    await expect(page.locator('[data-turn-id="original"] .message.plan')).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Да, реализуй этот план" })).toHaveCount(1);
    for (const button of await tail.locator(".implement-plan").all()) {
      await expect(button).toBeEnabled();
      await expect(button).toBeInViewport();
    }
    await waitForVisualReady(page);
    const actions = (await tail.locator(".implement-plan-actions").boundingBox())!;
    const composer = (await page.locator(".composer").boundingBox())!;
    expect(actions.y + actions.height).toBeLessThanOrEqual(composer.y);
    expect(actions.x).toBeGreaterThanOrEqual(0);
    expect(actions.x + actions.width).toBeLessThanOrEqual(viewport.width);
    await page.screenshot({ path: testInfo.outputPath("plan-tail.png") });
  });
}
