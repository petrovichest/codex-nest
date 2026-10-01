import { expect, test } from "@playwright/test";
import type { ThreadDetail, ThreadSummary } from "@codexnest/protocol";

import { installVisualFixture, mainThread, snapshot, waitForVisualReady } from "./fixtures";

const parent: ThreadSummary = {
  ...mainThread,
  title: "Исследование сигналов входа",
  settings: { collaborationMode: "default", model: "gpt-5.6-codex", reasoningEffort: "ultra" },
};
const children: ThreadSummary[] = [
  "Нелинейные входы",
  "Последовательности сделок",
  "Повторяющиеся ошибки",
].map((title, index) => ({
  ...parent,
  id: `native-${index}`,
  title,
  pinned: false,
  state: index === 2 ? "completed" : "running",
  currentTurnId: index === 2 ? null : `child-turn-${index}`,
  relation: {
    kind: "subagent",
    sessionId: `native-${index}`,
    parentThreadId: parent.id,
    nickname: ["Hubble", "Mencius", "Carson"][index]!,
    role: "worker",
  },
  codexSettings: { model: "gpt-6.1-sol", reasoningEffort: "ultra" },
}));
const detail: ThreadDetail = {
  summary: parent,
  olderTurnsCursor: null,
  queuedMessages: [],
  draft: null,
  turns: [
    {
      id: "native-turn",
      status: "completed",
      startedAt: Date.UTC(2026, 7, 3, 11, 41),
      completedAt: Date.UTC(2026, 7, 3, 11, 44),
      durationMs: 180_000,
      progress: {
        startedAt: null,
        explanation: null,
        steps: [],
        filesChanged: 0,
        additions: 0,
        deletions: 0,
      },
      items: [
        {
          type: "userMessage",
          id: "input",
          status: "completed",
          text: "Посмотри, какие сигналы повторяются перед входом в сделку.",
          images: [],
          timestamp: Date.UTC(2026, 7, 3, 11, 41),
          phase: null,
        },
        {
          type: "agentMessage",
          id: "intro",
          status: "completed",
          text: "Разделю исследование на три направления. Сопоставлю выводы и соберу общий ответ.",
          images: [],
          timestamp: null,
          phase: "commentary",
        },
        ...children.map((child, index) => ({
          type: "subagentLaunch" as const,
          id: `launch-${index}`,
          source: "codex" as const,
          status: "completed" as const,
          title: child.title,
          threadId: child.id,
          agentPath: `/root/task_${index}`,
          timestamp: Date.UTC(2026, 7, 3, 11, 42),
        })),
        {
          type: "agentMessage",
          id: "outro",
          status: "completed",
          text: "Пока агенты исследуют свои части, сверяю общие условия и исходные данные.",
          images: [],
          timestamp: Date.UTC(2026, 7, 3, 11, 44),
          phase: "final_answer",
        },
      ],
    },
  ],
};

for (const theme of ["light", "dark"] as const) {
  for (const width of [320, 390, 820, 821, 1440]) {
    for (const enlarged of [false, true]) {
      test(`native agents: ${theme}, ${width}px, ${enlarged ? "large" : "default"} type`, async ({
        page,
        browserName,
      }, testInfo) => {
        await page.setViewportSize({ width, height: width <= 820 ? 844 : 1000 });
        await installVisualFixture(page, {
          theme,
          snapshot: {
            ...snapshot,
            attention: [],
            threads: [
              parent,
              ...children.map((child) =>
                enlarged && child.id === "native-2"
                  ? {
                      ...child,
                      title: "ПроверитьПовторяющиесяОшибкиБезПробеловИОченьДлинноеНазваниеЗадачи",
                    }
                  : child,
              ),
            ],
          },
        });
        if (enlarged)
          await page.addInitScript(() => {
            localStorage.setItem("codexnest.typography", JSON.stringify({ ui: 24, caption: 20 }));
          });
        const requests: string[] = [];
        page.on("request", (request) => requests.push(request.url()));
        await page.route("https://codexnest.visual/api/v1/threads/session-main", (route) => {
          if (route.request().method() !== "GET") return route.fallback();
          return route.fulfill({ json: detail, headers: { "access-control-allow-origin": "*" } });
        });
        await page.route("http://127.0.0.1:4310/**", (route) => route.abort());
        await page.goto("/threads/session-main");
        await waitForVisualReady(page);
        const card = page.locator(".native-subagent-launches");
        await expect(card).toHaveCount(1);
        await expect(card.getByRole("link")).toHaveCount(3);
        await expect(card.getByText("2 работают", { exact: true })).toBeVisible();
        await expect(card.getByText("1 готов", { exact: true })).toBeVisible();
        await expect(card.getByText(/Нажмите на задачу/)).toHaveCount(0);
        await expect(card.locator(".native-subagent-top strong").first()).toHaveCSS(
          "font-size",
          enlarged ? "24px" : "14px",
        );
        await expect(card.locator(".native-subagent-meta").first()).toHaveCSS(
          "font-size",
          enlarged ? "20px" : "12px",
        );
        await expect(card).toHaveCSS("padding", width <= 820 ? "16px" : "22px");
        await expect(card).toHaveCSS("border-radius", width <= 820 ? "24px" : "28px");
        const surface = await card.evaluate((element) => {
          const reference = document.createElement("article");
          reference.className = "message orchestration-notice";
          element.parentElement!.append(reference);
          const actual = getComputedStyle(element);
          const expected = getComputedStyle(reference);
          const matches = [
            "backgroundColor",
            "boxShadow",
            "borderWidth",
            "padding",
            "borderRadius",
          ].every(
            (key) =>
              actual[key as keyof CSSStyleDeclaration] ===
              expected[key as keyof CSSStyleDeclaration],
          );
          reference.remove();
          return { matches, overflows: element.scrollWidth > element.clientWidth };
        });
        expect(surface).toEqual({ matches: true, overflows: false });
        const link = card.getByRole("link").first();
        await link.focus();
        await expect(link).toBeFocused();
        await expect(link).toHaveCSS("outline-style", "solid");
        expect(requests.some((url) => /\/threads\/native-\d/.test(url))).toBe(false);

        if (
          browserName === "chromium" &&
          !enlarged &&
          ((width === 1440 && theme === "dark") || (width === 390 && theme === "light"))
        ) {
          await link.evaluate((element) => {
            element.blur();
          });
          await page.locator(".timeline").evaluate((element) => {
            element.scrollTop = 0;
          });
          await page
            .locator(".thread-workspace")
            .screenshot({ path: testInfo.outputPath("native-subagents.png") });
        }
        if (width === 390 && theme === "light" && !enlarged) {
          await page.route("https://codexnest.visual/api/v1/threads/native-0", (route) =>
            route.fulfill({
              json: {
                ...detail,
                summary: children[0],
                turns: [
                  {
                    ...detail.turns[0],
                    items: [
                      {
                        type: "agentMessage",
                        id: "own-answer",
                        status: "completed",
                        text: "Собственный ответ субагента",
                        images: [],
                        timestamp: null,
                        phase: "final_answer",
                      },
                    ],
                  },
                ],
              },
              headers: { "access-control-allow-origin": "*" },
            }),
          );
          await link.focus();
          await page.keyboard.press("Enter");
          await expect(page).toHaveURL(/\/threads\/native-0$/);
          await expect(page.getByText("Собственный ответ субагента")).toBeVisible();
          await expect(page.locator(".subagent-readonly")).toBeVisible();
          await expect(page.locator(".composer-box textarea")).toHaveCount(0);
        }
      });
    }
  }
}
