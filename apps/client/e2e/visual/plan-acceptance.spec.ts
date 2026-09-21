import { expect, test, type Page } from "@playwright/test";
import type { QueueMessageRequest, ThreadDetail } from "@codexnest/protocol";

import { installVisualFixture, mainThread, snapshot } from "./fixtures";

const labels = {
  default: "Да, реализуй этот план",
  goal: "Запустить в режиме цели",
  team: "Запустить в режиме оркестратора",
} as const;

async function installPlan(page: Page, legacy = false) {
  const seed = structuredClone(snapshot);
  seed.instanceId = "plan-acceptance";
  seed.attention = [];
  const summary = {
    ...mainThread,
    state: "needsAttention" as const,
    awaitingPlanResponse: true,
    settings: {
      ...mainThread.settings,
      collaborationMode: legacy ? ("default" as const) : ("plan" as const),
    },
  };
  seed.threads = [summary];
  const detail: ThreadDetail = {
    version: { instanceId: seed.instanceId, sequence: seed.sequence },
    summary,
    turns: [
      {
        id: "turn-plan",
        status: "completed",
        error: null,
        items: [
          {
            id: "turn-plan-plan",
            type: "plan",
            status: "completed",
            text: "Исправить выполнение плана и проверить повторную отправку.",
            images: [],
            timestamp: 100,
            phase: null,
          },
        ],
      },
    ],
    queuedMessages: [],
    olderTurnsCursor: null,
    draft: null,
  };
  await installVisualFixture(page, { theme: "light", snapshot: seed });
  const settingsPatches: unknown[] = [];
  await page.route("**/api/v1/threads/session-main", (route) =>
    route.fulfill({
      json: detail,
      headers: { "access-control-allow-origin": "*" },
    }),
  );
  await page.route("**/api/v1/threads/session-main/settings", (route) => {
    if (route.request().method() === "OPTIONS") return route.fallback();
    settingsPatches.push(route.request().postDataJSON());
    return route.abort();
  });
  return { detail, settingsPatches };
}

for (const mode of ["default", "goal", "team"] as const) {
  test(`${mode}: retries the same plan command after a lost response and reload`, async ({
    page,
  }) => {
    const { settingsPatches } = await installPlan(page);
    const commands: QueueMessageRequest[] = [];
    let loseResponse = true;
    await page.route("**/api/v1/threads/session-main/queue", async (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback();
      const command = route.request().postDataJSON() as QueueMessageRequest;
      commands.push(command);
      if (loseResponse) return route.abort();
      return route.fulfill({
        json: {
          id: command.clientMessageId,
          threadId: "session-main",
          text: command.input,
          planImplementationMode: command.planImplementationMode,
          status: "queued",
          createdAt: Date.now(),
        },
        headers: { "access-control-allow-origin": "*" },
      });
    });
    await page.goto("/threads/session-main");
    const accept = page.getByRole("button", { name: labels[mode], exact: true });
    await expect(accept).toBeEnabled();
    // Two events in the same render must still produce only one operation.
    await accept.evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await expect.poll(() => commands.length).toBeGreaterThan(0);
    await expect(
      page.getByText("Нет связи — повторим отправку", { exact: true }).first(),
    ).toBeVisible();
    const first = commands[0]!;
    expect(first.planImplementationMode).toBe(mode);
    expect(first.goal ?? false).toBe(mode === "goal");
    expect(settingsPatches).toEqual([]);
    const beforeReload = commands.length;
    loseResponse = false;
    await page.reload();
    await expect.poll(() => commands.length).toBeGreaterThan(beforeReload);
    expect(
      commands.every(
        (command) =>
          command.clientMessageId === first.clientMessageId &&
          command.planImplementationMode === mode,
      ),
    ).toBe(true);
    await expect(page.getByText("Нет связи — повторим отправку", { exact: true })).toHaveCount(0);
    expect(settingsPatches).toEqual([]);
  });
}

test("failed local persistence leaves a legacy stuck session recoverable", async ({ page }) => {
  const { settingsPatches } = await installPlan(page, true);
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "outbox") throw new DOMException("Storage is full", "QuotaExceededError");
      return put.apply(this, args);
    };
  });
  const commands: unknown[] = [];
  await page.route("**/api/v1/threads/session-main/queue", (route) => {
    if (route.request().method() === "OPTIONS") return route.fallback();
    commands.push(route.request().postDataJSON());
    return route.abort();
  });
  await page.goto("/threads/session-main");
  const accept = page.getByRole("button", { name: labels.default, exact: true });
  await expect(accept).toBeEnabled();
  await accept.click();
  await expect(
    page.getByText("Не удалось сохранить сообщение на устройстве. Повторите отправку.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(accept).toBeEnabled();
  expect(commands).toEqual([]);
  expect(settingsPatches).toEqual([]);
  await page.reload();
  await expect(accept).toBeEnabled();
});

test("a clarified plan becomes actionable when corrected history places its reused ID last", async ({
  page,
}) => {
  const { detail } = await installPlan(page);
  const turn = detail.turns[0]!;
  const plan = turn.items[0]!;
  turn.items.push({
    id: "clarification",
    type: "userMessage",
    status: "completed",
    text: "Применить ко всем четырём ботам",
    images: [],
    timestamp: 200,
    phase: null,
  });
  await page.goto("/threads/session-main");
  const accept = page.getByRole("button", { name: labels.default, exact: true });
  await expect(accept).toBeDisabled();
  await expect(
    page.getByText("План ещё не обновлён после уточнений", { exact: true }),
  ).toBeVisible();
  plan.text = "Применить исправление ко всем четырём ботам и проверить каждое направление.";
  turn.items = [turn.items[1]!, plan];
  await page.reload();
  await expect(page.getByText(plan.text, { exact: true })).toBeVisible();
  await expect(accept).toBeEnabled();
  await expect(page.getByText("План ещё не обновлён после уточнений", { exact: true })).toHaveCount(
    0,
  );
});
