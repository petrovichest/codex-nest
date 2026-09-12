import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Route } from "@playwright/test";
import type { ThreadDetail, ThreadSearchOccurrence, TurnView } from "@codexnest/protocol";
import {
  installVisualFixture,
  mainThread,
  snapshot,
  PHONE_VIEWPORT,
  DESKTOP_VIEWPORT,
} from "./fixtures";

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

for (const mobile of [false, true]) {
  test(`global history search and rich copy on ${mobile ? "mobile" : "desktop"}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(mobile ? PHONE_VIEWPORT : DESKTOP_VIEWPORT);
    const searchSnapshot = { ...snapshot, instanceId: "search-fixture" };
    await installVisualFixture(page, {
      theme: mobile ? "dark" : "light",
      snapshot: searchSnapshot,
    });
    const found = {
      ...mainThread,
      id: "outside",
      title: "Архивный диалог о поиске",
      archived: true,
      relation: { kind: "session" as const, sessionId: "outside" },
      canAcceptDirectInput: false,
      codexSettings: { model: "native-model", reasoningEffort: "high" },
    };
    const occurrence: ThreadSearchOccurrence = {
      turnId: "old",
      itemId: "match",
      snippet: "Помню редкий фрагмент из диалога",
      snippetMatchRange: { start: 6, end: 20 },
      turnCursor: "exact-cursor",
    };
    const oldTurn: TurnView = {
      id: "old",
      status: "completed",
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
      progress: {
        startedAt: 1,
        explanation: null,
        steps: [],
        filesChanged: 0,
        additions: 0,
        deletions: 0,
      },
      items: [
        {
          type: "agentMessage",
          id: "match",
          text: "## Редкий фрагмент\n\n**Форматирование** сохраняется.\n\n| Поле | Значение |\n| --- | --- |\n| Режим | Архив |",
          images: [],
          timestamp: 2,
          phase: "final_answer",
          status: "completed",
        },
      ],
    };
    const detail: ThreadDetail = {
      version: { instanceId: searchSnapshot.instanceId, sequence: searchSnapshot.sequence },
      summary: found,
      olderTurnsCursor: "canonical-older",
      queuedMessages: [],
      turns: [
        {
          ...oldTurn,
          id: "latest",
          items: [
            {
              ...oldTurn.items[0]!,
              id: "latest-item",
              text: "Текущий ответ",
            } as TurnView["items"][number],
          ],
        },
      ],
    };
    const searches: string[] = [];
    const historyReads: string[] = [];
    let mutations = 0;
    await page.route("https://codexnest.visual/api/v1/**", async (route) => {
      const request = route.request();
      if (request.method() === "OPTIONS") return route.fallback();
      const url = new URL(request.url());
      if (
        request.method() !== "GET" &&
        /outside$|outside\/queue|outside\/turns$/.test(url.pathname)
      )
        mutations++;
      if (url.pathname === "/api/v1/threads/search") {
        searches.push(url.search);
        return json(route, {
          data:
            url.searchParams.get("archived") === "true"
              ? [{ thread: found, snippet: occurrence.snippet }]
              : [],
          nextCursor: null,
        });
      }
      if (url.pathname === "/api/v1/threads/outside/search")
        return json(route, { data: [occurrence], nextCursor: null });
      if (url.pathname === "/api/v1/threads/outside/turns/old") {
        historyReads.push(url.searchParams.get("cursor")!);
        return json(route, { instanceId: searchSnapshot.instanceId, turn: oldTurn });
      }
      if (url.pathname === "/api/v1/threads/outside") return json(route, detail);
      if (url.pathname === "/api/v1/threads/outside/draft" && request.method() === "PUT") {
        detail.draft = { ...request.postDataJSON(), updatedAt: Date.now() };
        return json(route, detail.draft);
      }
      return route.fallback();
    });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          write: async (items: ClipboardItem[]) => {
            const entry = items[0]!;
            const plain = await (await entry.getType("text/plain")).text();
            const html = await (await entry.getType("text/html")).text();
            Object.assign(window, { copiedMessage: { plain, html } });
          },
        },
      });
    });
    await page.goto("/threads/session-main");
    if (mobile) await page.getByRole("button", { name: "Открыть список задач" }).click();
    await page.getByRole("button", { name: "Поиск по диалогам", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Поиск по диалогам" });
    await dialog.getByRole("textbox").fill("редкий фрагмент");
    expect(searches).toHaveLength(0);
    await dialog.getByRole("button", { name: "Найти", exact: true }).click();
    await expect(dialog.getByText("Архивный диалог о поиске")).toBeVisible();
    expect(searches).toHaveLength(2);
    await page.screenshot({ path: testInfo.outputPath("history-search.png") });
    expect(
      (await new AxeBuilder({ page }).include(".thread-search-dialog").analyze()).violations,
    ).toEqual([]);
    await dialog.getByRole("button", { name: /Помню редкий фрагмент/ }).click();
    await dialog.getByRole("button", { name: occurrence.snippet }).click();
    await expect(page.locator(".search-history-match")).toContainText("Форматирование");
    // The development fixture uses React StrictMode, which replays mount effects.
    expect(new Set(historyReads)).toEqual(new Set(["exact-cursor"]));
    expect(historyReads.length).toBeLessThanOrEqual(2);
    await expect(page.getByText("Текущий ответ", { exact: true })).toHaveCount(0);
    const composer = page.getByRole("textbox", { name: "Сообщение для Codex" });
    await composer.fill("Черновик остаётся доступным");
    await expect(page.getByRole("button", { name: "Отправить", exact: true })).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath("history-target.png") });
    await page
      .locator(".search-history-match")
      .getByRole("button", { name: "Копировать сообщение" })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { copiedMessage?: { html: string } }).copiedMessage?.html,
        ),
      )
      .toContain("<table>");
    await page.getByRole("button", { name: "К текущему диалогу" }).click();
    await expect(page.getByText("Текущий ответ", { exact: true })).toBeVisible();
    await expect(composer).toHaveValue("Черновик остаётся доступным");
    expect(mutations).toBe(0);
    if (mobile) await page.getByRole("button", { name: "Открыть список задач" }).click();
    await page.getByRole("button", { name: "Поиск по диалогам", exact: true }).click();
    await expect(dialog.getByRole("textbox")).toHaveValue("редкий фрагмент");
    expect(searches).toHaveLength(2);
  });
}

test("quota dialog retains explicit restrictions and stale data after refresh failure", async ({
  page,
}, testInfo) => {
  await installVisualFixture(page, { theme: "light" });
  let reads = 0;
  await page.route("https://codexnest.visual/api/v1/codex/rate-limits", async (route) => {
    if (route.request().method() === "OPTIONS") return route.fallback();
    reads++;
    return reads === 1
      ? json(route, {
          primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: Date.UTC(2026, 8, 13) },
          secondary: null,
          ordinaryUsageAllowed: false,
          spendControlReached: true,
          rateLimitReachedType: "spend_control",
        })
      : json(route, { error: { code: "app_server_unavailable", message: "Unavailable" } }, 503);
  });
  await page.goto("/threads/session-main");
  await expect(page.getByRole("heading", { name: "Полировка мастерской" })).toBeVisible();
  expect(reads).toBe(0);
  await page.getByRole("button", { name: "Показать лимиты Codex" }).click();
  const dialog = page.getByRole("dialog", { name: "Лимиты Codex" });
  await expect(dialog.getByText("100%", { exact: true })).toBeVisible();
  await expect(dialog.getByText("spend_control")).toBeVisible();
  await dialog.getByRole("button", { name: "Обновить", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("последние полученные данные");
  await expect(dialog.getByText("100%", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("quota-details.png") });
  expect(
    (await new AxeBuilder({ page }).include(".rate-limits-dialog").analyze()).violations,
  ).toEqual([]);
});
