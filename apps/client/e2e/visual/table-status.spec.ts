import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import type { ActivityItem, ServerEvent, ThreadDetail, TurnView } from "@codexnest/protocol";
import { installVisualFixture, snapshot, waitForVisualReady } from "./fixtures";

const compactTable =
  "| Файл | Статус |\n| --- | ---: |\n| AGENTS.md | Готово |\n| README.md | Проверен |";
const wideTable =
  "| Файл проекта | Что в нём | Проверка | Изменения |\n| --- | --- | --- | ---: |\n" +
  "| [project_configuration_and_deployment/AGENTS.md](https://example.test/AGENTS.md) | Правила проекта и **важные ограничения** | `verify_deployment_configuration` | 12 |\n" +
  "| codex-nest/AGENTS.md | После push проверить GitHub Actions | Пройдено | 3 |";
const text =
  "Проверил файлы проекта:\n\n" + compactTable + "\n\nПодробности проверки:\n\n" + wideTable;

function turn(id: string, status: TurnView["status"], body: string, journal = true): TurnView {
  return {
    id,
    status,
    startedAt: 1,
    completedAt: 14001,
    durationMs: 14000,
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
        id: `${id}-message`,
        status: "completed",
        text: body,
        images: [],
        timestamp: null,
        phase: null,
      },
      ...(journal
        ? [
            {
              type: "command",
              id: `${id}-command`,
              status: "completed",
              kind: "command",
              command: "npm test",
              cwd: "/work",
              output: "Tests passed",
              exitCode: 0,
            } satisfies ActivityItem,
          ]
        : []),
    ],
  };
}

async function openChat(
  page: Page,
  theme: "light" | "dark",
  language: "ru" | "en",
  turns: TurnView[],
) {
  const seed = structuredClone(snapshot);
  seed.uiLanguage = language;
  seed.attention = [];
  const summary = seed.threads.find((item) => item.id === "session-main")!;
  summary.title = "Проверка файлов проекта";
  summary.settings.collaborationMode = "default";
  summary.browserStatus = "disabled";
  summary.currentTurnId = turns.find((item) => item.status === "inProgress")?.id ?? null;
  summary.state = summary.currentTurnId ? "running" : "completed";
  const detail: ThreadDetail = {
    summary,
    turns,
    olderTurnsCursor: null,
    queuedMessages: [],
    draft: null,
  };
  await installVisualFixture(page, { theme, snapshot: seed });
  await page.addInitScript(
    (language) => localStorage.setItem("codexnest.uiLanguage", language),
    language,
  );
  await page.route("**/api/v1/threads/session-main", (route) =>
    route.fulfill({ json: detail, headers: { "access-control-allow-origin": "*" } }),
  );
  let sequence = seed.sequence;
  let send!: (event: ServerEvent) => void;
  await page.routeWebSocket("wss://codexnest.visual/api/v1/events", (socket) => {
    send = (event) => socket.send(JSON.stringify({ type: "event", sequence: ++sequence, event }));
    socket.onMessage((message) => {
      const frame = JSON.parse(message.toString());
      if (frame.type === "authenticate")
        socket.send(JSON.stringify({ type: "snapshot", snapshot: seed }));
      if (frame.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
    });
  });
  await page.goto("/threads/session-main");
  await expect(page.locator(".turn-activity-copy")).toHaveCount(turns.length);
  await waitForVisualReady(page);
  return { send };
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [320, 390, 820, 1440]) {
    for (const language of ["ru", "en"] as const) {
      test(`soft tables ${width}px ${theme} ${language}: sizing, keyboard and streaming`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 1000 });
        const current = turn("tables", "completed", text);
        const { send } = await openChat(page, theme, language, [current]);
        const tables = page.getByRole("region", {
          name: language === "ru" ? "Таблица" : "Table",
          exact: true,
        });
        await expect(tables).toHaveCount(2);
        const compact = tables.first();
        const wide = tables.nth(1);
        expect(await compact.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        expect(
          await page
            .locator(".conversation-scroll")
            .evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
        await expect(compact).toHaveCSS("border-radius", "20px");
        await expect(compact.locator("th").first()).toHaveCSS("font-weight", "400");
        await expect(compact.locator("th").last()).toHaveCSS("text-align", "right");
        await expect(wide.locator("strong")).toHaveText("важные ограничения");
        await expect(wide.getByRole("link")).toHaveAttribute(
          "href",
          "https://example.test/AGENTS.md",
        );
        await expect(wide.locator("td").first()).toHaveCSS(
          "padding-left",
          width <= 820 ? "12px" : "16px",
        );
        await expect(wide.locator("td").first()).toHaveCSS("border-right-width", "0px");
        const status = page.locator(".turn-activity-toggle");
        await expect(status).toHaveCSS("height", "32px");
        await expect(status).toHaveCSS("padding-left", "12px");
        await expect(status).toHaveCSS("padding-right", "12px");
        await expect(status).toHaveCSS("column-gap", "8px");
        await expect(status).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        if (language === "ru" && [390, 1440].includes(width)) {
          await expect(page.locator(".turn")).toHaveScreenshot(`soft-tables-${width}-${theme}.png`);
          if (process.env.UPDATE_TABLE_DOCS)
            await page.locator(".turn").screenshot({
              path: resolve(
                import.meta.dirname,
                `../../../../docs/assets/chat-tables-${width}-${theme}.png`,
              ),
            });
        }
        await status.hover();
        await expect(status).toHaveCSS(
          "background-color",
          theme === "light" ? "rgb(248, 249, 246)" : "rgb(36, 39, 34)",
        );
        await expect(status).not.toHaveCSS("box-shadow", "none");
        const hovered = await status.evaluate((el) => getComputedStyle(el).backgroundColor);
        await page.mouse.down();
        await expect(status).not.toHaveCSS("background-color", hovered);
        await expect(status).toHaveCSS("box-shadow", /inset/);
        await page.mouse.up();
        await expect(status).toHaveAttribute("aria-expanded", "true");
        await expect(page.locator(".turn-activity-journal")).toBeVisible();
        await status.press("Enter");
        await expect(page.locator(".turn-activity-journal")).toBeHidden();
        await page.mouse.move(0, 0);
        await status.press("Tab");
        await status.focus();
        await expect(status).toBeFocused();
        await expect(status).toHaveCSS("outline-style", "solid");
        await expect(status).not.toHaveCSS("box-shadow", "none");
        await wide.focus();
        await expect(wide).toHaveCSS("outline-style", "solid");
        const overflows = await wide.evaluate((el) => el.scrollWidth > el.clientWidth);
        if (width <= 390) expect(overflows).toBe(true);
        if (overflows) {
          await wide.press("ArrowRight");
          await expect.poll(() => wide.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
          // Native keyboard scrolling finishes asynchronously, even with reduced motion.
          await wide.evaluate(
            (el) =>
              new Promise<void>((resolve) => {
                let previous = el.scrollLeft;
                let stableFrames = 0;
                function settled() {
                  stableFrames = el.scrollLeft === previous ? stableFrames + 1 : 0;
                  previous = el.scrollLeft;
                  if (stableFrames >= 3) resolve();
                  else requestAnimationFrame(settled);
                }
                requestAnimationFrame(settled);
              }),
          );
        }
        const left = await wide.evaluate((el) => el.scrollLeft);
        const message = current.items[0]!;
        if (message.type !== "agentMessage") throw new Error("Missing agent message");
        send({
          type: "activity.upserted",
          threadId: "session-main",
          turnId: current.id,
          item: {
            ...message,
            text: text + "\n\nДополнение к ответу.\n\n| Заметка |\n| --- |\n| Без изменений |",
          },
        });
        await expect(page.getByText("Дополнение к ответу.", { exact: true })).toBeVisible();
        expect(await wide.evaluate((el) => el.scrollLeft)).toBe(left);
        await expect(wide).toBeFocused();
        await expect(tables).toHaveCount(3);
        expect(await tables.nth(2).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      });
    }
  }
  test(`activity status ${theme}: consistent geometry across outcomes and long labels`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 1000 });
    const turns = [
      turn("completed", "completed", "Завершено"),
      turn("failed", "failed", "Ошибка"),
      turn("interrupted", "interrupted", "Прервано"),
      turn("static", "completed", "Без журнала", false),
      turn("running", "inProgress", "Работаем"),
    ];
    turns[4]!.progress.explanation =
      "Длинная подпись текущей операции, которая не помещается в строку";
    await openChat(page, theme, "ru", turns);
    for (const status of await page.locator(".turn-activity-copy").all()) {
      await expect(status).toHaveCSS("height", "32px");
      await expect(status).toHaveCSS("padding-left", "12px");
      await expect(status).toHaveCSS("padding-right", "12px");
    }
    const phase = page.locator(".turn-activity-row").last().locator(".turn-activity-phase");
    expect(await phase.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    expect(
      await page.locator(".conversation-scroll").evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
  });
}
