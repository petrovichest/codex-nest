import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import type { ActivityItem, ServerEvent, ThreadDetail } from "@codexnest/protocol";
import { installVisualFixture, snapshot, waitForVisualReady } from "./fixtures";

for (const theme of ["light", "dark"] as const) {
  for (const width of [390, 1440]) {
    test(`only explicitly shared images enter the conversation at ${width}px ${theme}`, async ({
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
                text: "Проверю изображения.",
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
        title: ["imageView", "functions:exec", "imageGeneration"][index - 1]!,
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
      let journalRequests = 0;
      await page.route("**/api/v1/threads/session-main/turns/screenshots/items", (route) => {
        journalRequests++;
        return route.fulfill({
          json: { threadId: summary.id, turnId: "screenshots", items: detail.turns[0]!.items },
          headers: { "access-control-allow-origin": "*" },
        });
      });
      const requestedPaths: string[] = [];
      let failGeneratedPreview = true;
      await page.route("**/api/v1/threads/session-main/downloads", (route) => {
        if (route.request().method() === "OPTIONS") return route.fallback();
        const { path } = route.request().postDataJSON() as { path: string };
        requestedPaths.push(path);
        if (path === "/tmp/variant-3.png" && failGeneratedPreview) {
          failGeneratedPreview = false;
          return route.fulfill({
            status: 404,
            json: { error: { code: "not_found", message: "Image unavailable" } },
            headers: { "access-control-allow-origin": "*" },
          });
        }
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
      await expect(page.getByText("Проверю изображения.", { exact: true })).toBeVisible();
      const turn = detail.turns[0]!;
      for (const item of [...shots, shots[2]!]) {
        send({ type: "activity.upserted", threadId: summary.id, turnId: turn.id, item });
      }
      const explanation = turn.items[0]!;
      if (explanation.type !== "agentMessage") throw new Error("Missing explanation");
      explanation.text = "Проверка изображений завершена.";
      send({ type: "activity.upserted", threadId: summary.id, turnId: turn.id, item: explanation });
      await expect(page.getByText(explanation.text, { exact: true })).toBeVisible();
      await expect(page.locator(".gallery-thumbnail")).toHaveCount(0);
      expect(requestedPaths).toEqual([]);
      expect(journalRequests).toBe(0);

      const shared: ActivityItem = {
        ...explanation,
        id: "shared",
        text: "Вот два выбранных варианта.\n\n![Вариант 1](/tmp/variant-1.png)\n\n[Вариант 2](/tmp/variant-2.png)",
      };
      for (const item of [shared, shared])
        send({ type: "activity.upserted", threadId: summary.id, turnId: turn.id, item });
      const sharedMessage = page
        .locator(".message.agentMessage")
        .filter({ hasText: "Вот два выбранных варианта." });
      await expect(sharedMessage.locator(".gallery-thumbnail.is-ready")).toHaveCount(2);
      expect(requestedPaths.toSorted()).toEqual(["/tmp/variant-1.png", "/tmp/variant-2.png"]);
      turn.status = "completed";
      turn.completedAt = summary.updatedAt + 1000;
      turn.durationMs = 1000;
      turn.items.push(...shots, shared, {
        type: "agentMessage",
        id: "answer",
        text: "Выберите один из двух вариантов выше.",
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
        page.getByText("Выберите один из двух вариантов выше.", { exact: true }),
      ).toBeVisible();
      await expect(page.locator(".gallery-thumbnail.is-ready")).toHaveCount(2);
      await page.reload();
      await expect(sharedMessage.locator(".gallery-thumbnail.is-ready")).toHaveCount(2);
      await expect(page.locator(".gallery-thumbnail")).toHaveCount(2);
      expect(requestedPaths).not.toContain("/tmp/variant-3.png");
      expect(journalRequests).toBe(0);
      expect(
        await page
          .locator(".conversation-scroll")
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      await waitForVisualReady(page);
      await page.screenshot({ path: testInfo.outputPath(`tool-images-${width}-${theme}.png`) });
      const thumbnail = sharedMessage.locator(".gallery-thumbnail").nth(1);
      await thumbnail.click();
      await expect(page.getByRole("dialog", { name: "Просмотр изображений" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(thumbnail).toBeFocused();

      const downloadsBeforeJournal = requestedPaths.length;
      await page.getByRole("button", { name: "Технические детали" }).click();
      const journal = page.locator(".turn-activity-journal");
      await expect(journal.locator(".activity-card")).toHaveCount(3);
      expect(journalRequests).toBe(1);
      expect(requestedPaths).toHaveLength(downloadsBeforeJournal);
      await journal.locator("summary").filter({ hasText: "imageGeneration" }).click();
      const retry = journal.getByRole("button", { name: /variant-3.png: Не удалось загрузить/ });
      await expect(retry).toBeVisible();
      await retry.click();
      await expect(journal.locator(".gallery-thumbnail.is-ready")).toHaveCount(1);
      expect(requestedPaths.slice(downloadsBeforeJournal)).toEqual([
        "/tmp/variant-3.png",
        "/tmp/variant-3.png",
      ]);
      await journal.getByRole("button", { name: "Открыть изображение variant-3.png" }).click();
      await expect(page.getByRole("dialog", { name: "Просмотр изображений" })).toBeVisible();
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Технические детали" }).click();
      await expect(page.locator(".gallery-thumbnail")).toHaveCount(2);

      await thumbnail.click();
      const navigation = page.waitForRequest(
        (request) =>
          request.isNavigationRequest() && request.url().endsWith("/downloads/variant-2.png"),
      );
      // WebKit displays intercepted downloads as a new document, so download last.
      const download = browserName === "chromium" ? page.waitForEvent("download") : null;
      await page.getByRole("button", { name: "Скачать Вариант 2" }).click();
      await navigation;
      expect(requestedPaths.at(-1)).toBe("/tmp/variant-2.png");
      if (download) expect((await download).suggestedFilename()).toBe("variant-2.png");
    });
  }
}
