import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import type { ActivityItem, ServerEvent, ThreadDetail } from "@codexnest/protocol";
import { installVisualFixture, snapshot, waitForVisualReady } from "./fixtures";

for (const theme of ["light", "dark"] as const) {
  for (const width of [390, 1440]) {
    test(`tool screenshots remain visible after streaming and reload at ${width}px ${theme}`, async ({
      page,
      browserName,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      const seed = structuredClone(snapshot);
      seed.attention = [];
      const summary = seed.threads.find((item) => item.id === "session-main")!;
      summary.title = "Три варианта интерфейса";
      summary.settings.collaborationMode = "default";
      summary.browserStatus = "disabled";
      summary.state = "running";
      summary.currentTurnId = "screenshots";
      const detail: ThreadDetail = {
        summary,
        queuedMessages: [],
        olderTurnsCursor: null,
        draft: null,
        turns: [
          {
            id: "screenshots",
            status: "inProgress",
            startedAt: summary.updatedAt,
            completedAt: null,
            durationMs: null,
            itemsLoaded: false,
            progress: {
              startedAt: summary.updatedAt,
              explanation: null,
              steps: [],
              filesChanged: 0,
              additions: 0,
              deletions: 0,
            },
            items: [
              {
                type: "agentMessage",
                id: "explanation",
                text: "Покажу три скриншота для сравнения.",
                images: [],
                status: "completed",
                timestamp: summary.updatedAt,
                phase: "commentary",
              },
            ],
          },
        ],
      };
      const shots: ActivityItem[] = [1, 2, 3].map((index) => ({
        type: "tool",
        id: `shot-${index}`,
        status: "completed",
        title: "imageView",
        detail: "",
        images: [`/tmp/variant-${index}.png`],
      }));
      const png = await readFile(
        resolve(import.meta.dirname, "../../../../docs/assets/desktop-session.png"),
      );
      await installVisualFixture(page, { theme, snapshot: seed });
      await page.route("**/api/v1/threads/session-main", (route) =>
        route.fulfill({ json: detail, headers: { "access-control-allow-origin": "*" } }),
      );
      const requestedPaths: string[] = [];
      await page.route("**/api/v1/threads/session-main/downloads", (route) => {
        if (route.request().method() === "OPTIONS") return route.fallback();
        const { path } = route.request().postDataJSON() as { path: string };
        requestedPaths.push(path);
        return route.fulfill({
          json: {
            downloadUrl: `/downloads/${path.split("/").at(-1)}`,
            fileName: path.split("/").at(-1),
            size: png.length,
            expiresAt: Date.now() + 60000,
          },
          headers: { "access-control-allow-origin": "*" },
        });
      });
      await page.route("**/downloads/variant-*.png", (route) =>
        route.fulfill({
          body: png,
          contentType: "image/png",
          headers: {
            "access-control-allow-origin": "*",
            "content-disposition": `attachment; filename="${new URL(route.request().url()).pathname.split("/").at(-1)}"`,
          },
        }),
      );
      let sequence = seed.sequence;
      let send!: (event: ServerEvent) => void;
      await page.routeWebSocket("wss://codexnest.visual/api/v1/events", (socket) => {
        send = (event) =>
          socket.send(JSON.stringify({ type: "event", sequence: ++sequence, event }));
        socket.onMessage((message) => {
          const frame = JSON.parse(message.toString());
          if (frame.type === "authenticate")
            socket.send(JSON.stringify({ type: "snapshot", snapshot: { ...seed, sequence } }));
          if (frame.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
        });
      });
      await page.goto("/threads/session-main");
      await expect(
        page.getByText("Покажу три скриншота для сравнения.", { exact: true }),
      ).toBeVisible();
      const turn = detail.turns[0]!;
      for (const item of [...shots, shots[2]!]) {
        send({ type: "activity.upserted", threadId: summary.id, turnId: turn.id, item });
      }
      await expect(page.locator(".tool-images .gallery-thumbnail.is-ready")).toHaveCount(3);
      expect(requestedPaths).toEqual([
        "/tmp/variant-1.png",
        "/tmp/variant-2.png",
        "/tmp/variant-3.png",
      ]);
      turn.status = "completed";
      turn.completedAt = summary.updatedAt + 1000;
      turn.durationMs = 1000;
      turn.items.push(...shots, {
        type: "agentMessage",
        id: "answer",
        text: "Вывел три скриншота. Выберите вариант.",
        images: [],
        status: "completed",
        timestamp: turn.completedAt,
        phase: "final_answer",
      });
      summary.state = "completed";
      summary.currentTurnId = null;
      send({ type: "turn.replaced", threadId: summary.id, turn });
      send({ type: "thread.upserted", thread: summary });
      await expect(
        page.getByText("Вывел три скриншота. Выберите вариант.", { exact: true }),
      ).toBeVisible();
      await expect(page.locator(".tool-images .gallery-thumbnail.is-ready")).toHaveCount(3);
      await page.reload();
      await expect(page.locator(".tool-images .gallery-thumbnail.is-ready")).toHaveCount(3);
      expect(
        await page
          .locator(".tool-images")
          .evaluateAll((elements) => elements.every((element) => !element.closest("details"))),
      ).toBe(true);
      expect(
        await page
          .locator(".conversation-scroll")
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      await waitForVisualReady(page);
      await page.screenshot({ path: testInfo.outputPath(`tool-images-${width}-${theme}.png`) });
      await page.getByRole("button", { name: "Открыть изображение variant-2.png" }).click();
      await expect(page.getByRole("dialog", { name: "Просмотр изображений" })).toBeVisible();
      const navigation = page.waitForRequest(
        (request) =>
          request.isNavigationRequest() && request.url().endsWith("/downloads/variant-2.png"),
      );
      // WebKit's intercepted navigation does not emit a download event.
      const download = browserName === "chromium" ? page.waitForEvent("download") : null;
      await page.getByRole("button", { name: "Скачать variant-2.png" }).click();
      await navigation;
      expect(requestedPaths.at(-1)).toBe("/tmp/variant-2.png");
      if (download) expect((await download).suggestedFilename()).toBe("variant-2.png");
    });
  }
}
