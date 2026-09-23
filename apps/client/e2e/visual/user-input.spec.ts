import { expect, test } from "@playwright/test";
import type { AttentionRequest, ServerEvent, ThreadDetail } from "@codexnest/protocol";
import {
  attentionThread,
  installVisualFixture,
  mainThread,
  snapshot,
  waitForVisualReady,
} from "./fixtures";

test("mobile voice draft moves into the status bubble", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const seed = structuredClone(snapshot);
  seed.voiceTranscriptions = [
    {
      id: "voice-with-draft",
      threadId: mainThread.id,
      mode: "send",
      status: "transcribing",
      createdAt: Date.UTC(2026, 7, 3, 11, 59, 53),
      startedAt: Date.UTC(2026, 7, 3, 11, 59, 53),
      audioDurationMs: 7_000,
      estimatedTotalSeconds: 12,
      error: null,
    },
  ];
  const image = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" rx="12" fill="#252725"/></svg>')}`;
  const detail: ThreadDetail = {
    summary: mainThread,
    turns: [],
    queuedMessages: [],
    olderTurnsCursor: null,
    draft: {
      input: "Проверь, пожалуйста, этот скриншот.",
      images: [{ id: "screenshot", name: "screen.svg", url: image }],
      files: [
        {
          id: "notes",
          name: "notes.txt",
          path: "/work/codex-nest/notes.txt",
          size: 12,
          mediaType: "text/plain",
        },
      ],
      goalMode: false,
      annotations: [],
      updatedAt: 1,
    },
  };
  await installVisualFixture(page, { theme: "light", snapshot: seed });
  await page.route("**/api/v1/threads/session-main", (route) =>
    route.fulfill({ json: detail, headers: { "access-control-allow-origin": "*" } }),
  );
  await page.goto("/threads/session-main");
  await waitForVisualReady(page);

  const bubble = page.locator(".voice-transcription-message");
  await expect(bubble.locator(".voice-transcription-status")).toContainText("Распознаём");
  await expect(bubble).toContainText("Проверь, пожалуйста, этот скриншот.");
  await expect(bubble.locator(".message-image-preview")).toHaveCount(1);
  await expect(bubble.locator(".message-file")).toContainText("notes.txt");
  await expect(page.locator(".composer textarea")).toHaveValue("");
  await expect(page.locator(".composer-attachments")).toHaveCount(0);
  await expect(bubble.locator(".message-body")).toHaveCSS("display", "block");
  const status = (await bubble.locator(".voice-transcription-status").boundingBox())!;
  const content = (await bubble.locator(".voice-transcription-content").boundingBox())!;
  expect(content.y).toBeGreaterThanOrEqual(status.y + status.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await bubble.screenshot({ path: testInfo.outputPath("voice-draft-mobile.png") });
  await page.screenshot({ path: testInfo.outputPath("voice-draft-page.png") });
});

for (const theme of ["light", "dark"] as const) {
  for (const language of ["ru", "en"] as const) {
    for (const width of [320, 390, 1440]) {
      test(`${theme} ${language} ${width}: question circles, spacing and dismissal recovery`, async ({
        page,
      }, testInfo) => {
        await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
        const question: Extract<AttentionRequest, { kind: "userInput" }> = {
          ...(snapshot.attention[0] as Extract<AttentionRequest, { kind: "userInput" }>),
          itemId: "question",
          questions: [1, 2, 3].map((index) => ({
            id: `q${index}`,
            header: language === "ru" ? `Вариант ${index}` : `Option ${index}`,
            question:
              language === "ru"
                ? "Как фиксируем целевой SLA для начала продажи?"
                : "How should we define the target latency before starting the sale?",
            isOther: true,
            isSecret: false,
            options: [
              {
                label: "WS event → RPC (Recommended)",
                description:
                  language === "ru"
                    ? "Менее 1 мс от получения события процессом до начала отправки транзакции."
                    : "Less than 1 ms from receiving the event until the process starts sending the transaction.",
              },
              {
                label: "Arrival → RPC",
                description:
                  language === "ru"
                    ? "Учитывать задержку доставки события провайдером."
                    : "Include the delay before the provider delivers the event.",
              },
            ],
          })),
        };
        const seed = structuredClone(snapshot);
        seed.uiLanguage = language;
        seed.attention = [question];
        seed.voiceTranscriptions = [
          {
            id: "voice",
            threadId: attentionThread.id,
            mode: "queue",
            status: "transcribing",
            createdAt: question.createdAt + 100_000,
            startedAt: question.createdAt + 100_000,
            audioDurationMs: 1000,
            estimatedTotalSeconds: 19,
            error: null,
          },
        ];
        const detail: ThreadDetail = {
          summary: attentionThread,
          olderTurnsCursor: null,
          turns: [],
          draft: null,
          queuedMessages: [
            {
              id: "instruction",
              threadId: attentionThread.id,
              text: "Новое указание",
              status: "queued",
              createdAt: 2,
            },
          ],
        };
        await installVisualFixture(page, { theme, snapshot: seed });
        await page.route("**/api/v1/threads/session-attention", (route) =>
          route.fulfill({ json: detail, headers: { "access-control-allow-origin": "*" } }),
        );
        let sequence = seed.sequence;
        let send!: (event: ServerEvent) => void;
        await page.routeWebSocket("wss://codexnest.visual/api/v1/events", (socket) => {
          send = (event) =>
            socket.send(JSON.stringify({ type: "event", sequence: ++sequence, event }));
          socket.onMessage((message) => {
            const frame = JSON.parse(message.toString());
            if (frame.type === "authenticate")
              socket.send(JSON.stringify({ type: "snapshot", snapshot: seed }));
            if (frame.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
          });
        });
        await page.goto("/threads/session-attention");
        await waitForVisualReady(page);
        const voice = page.locator(".voice-transcription-message");
        for (const status of ["queued", "applying", "transcribing"] as const) {
          seed.voiceTranscriptions![0]!.status = status;
          await page.reload();
          const label =
            status === "queued"
              ? language === "ru"
                ? "На сервере · ожидание"
                : "On the server · waiting"
              : status === "applying"
                ? language === "ru"
                  ? "Готовим отправку"
                  : "Preparing to send"
                : language === "ru"
                  ? "Распознаём"
                  : "Transcribing";
          await expect(voice).toHaveAttribute("aria-label", label);
          const body = voice.locator(".message-body");
          const bounds = (await body.boundingBox())!;
          const caption = (await body.locator(":scope > span").nth(1).boundingBox())!;
          const timer = (await voice.locator(".voice-transcription-timer").boundingBox())!;
          expect(bounds.height).toBe(36);
          expect(timer.x - caption.x - caption.width).toBeCloseTo(8, 0);
          expect(timer.x + timer.width).toBeLessThanOrEqual(bounds.x + bounds.width);
          expect(bounds.width).toBeLessThan(280);
          expect(bounds.x).toBeGreaterThanOrEqual(0);
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        }
        if (language === "ru" && width === 390) {
          await voice.screenshot({ path: testInfo.outputPath(`voice-capsule-${theme}.png`) });
        }
        const panel = page.locator(".attention-stack");
        await expect(panel).toBeVisible();
        await expect(panel.locator("legend")).toHaveCSS("font-size", "14px");
        await expect(panel.locator("label:has(input[type=radio]) > span").first()).toHaveCSS(
          "font-size",
          "14px",
        );
        await expect(panel.locator("label:has(input[type=radio]) small").first()).toHaveCSS(
          "font-size",
          "14px",
        );
        const activity = page.locator(".turn-activity-row");
        const waitingLabel = language === "ru" ? "Ждёт вашего ответа" : "Waiting for your answer";
        await expect(activity).toContainText(waitingLabel);
        await expect(activity.locator(".spinner, .turn-activity-duration")).toHaveCount(0);
        await page.reload();
        await expect(panel).toBeVisible();
        await expect(activity).toContainText(waitingLabel);
        const steps = panel.locator(".user-input-steps button");
        await expect(steps).toHaveCount(3);
        const floating = theme === "light" ? "rgb(248, 249, 246)" : "rgb(36, 39, 34)";
        await expect(panel.locator(".user-input-card")).toHaveCSS("background-color", floating);
        await expect(panel.locator(".user-input-freeform")).toHaveCSS("background-color", floating);
        await expect(panel.locator(".user-input-freeform")).not.toHaveCSS("box-shadow", "none");
        await expect(steps.first()).toHaveCSS("background-color", floating);
        await expect(steps.first()).not.toHaveCSS("box-shadow", "none");
        await expect(steps.nth(1)).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        await expect(panel.locator(".user-input-steps")).toHaveCSS("overflow", "visible");
        const option = panel.locator(".check").nth(1);
        await option.scrollIntoViewIfNeeded();
        const bounds = await option.boundingBox();
        await option.hover();
        await expect(option).toHaveCSS("cursor", "pointer");
        await expect(option).toHaveCSS("background-color", floating);
        await expect(option).not.toHaveCSS("box-shadow", "none");
        expect(await option.boundingBox()).toEqual(bounds);
        await page.mouse.down();
        await expect(option).toHaveCSS("box-shadow", /inset/);
        await page.mouse.up();
        await expect(option.getByRole("radio")).toBeChecked();
        await page.mouse.move(0, 0);
        const selectedShadow = await option.evaluate((el) => getComputedStyle(el).boxShadow);
        await option.hover();
        await expect(option).not.toHaveCSS("box-shadow", selectedShadow);
        await page.mouse.move(0, 0);
        await panel.getByRole("radio").first().check();
        const selected = panel.locator(".check:has(input:checked)");
        await expect(selected).toHaveCSS("background-color", floating);
        await expect(selected).not.toHaveCSS("box-shadow", "none");
        await page.keyboard.press("Tab");
        await selected.getByRole("radio").focus();
        await expect(selected).toHaveCSS("outline-style", "solid");
        await expect(option).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        await option.getByRole("radio").evaluate((el: HTMLInputElement) => (el.disabled = true));
        await option.hover();
        await expect(option).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        await expect(option).toHaveCSS("box-shadow", "none");
        await option.getByRole("radio").evaluate((el: HTMLInputElement) => (el.disabled = false));
        for (const step of await steps.all()) {
          const box = (await step.boundingBox())!;
          expect(box.width).toBe(width <= 820 ? 32 : 34);
          expect(box.height).toBe(box.width);
          await expect(step).toHaveCSS("border-radius", "50%");
        }
        await steps.nth(1).click();
        await expect(steps.nth(1)).toHaveAttribute("aria-current", "step");
        await expect(steps.first()).toHaveClass(/answered/);
        await expect(steps.first()).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        await expect(steps.first()).toHaveCSS("box-shadow", "none");
        await expect(steps.nth(1)).not.toHaveCSS("box-shadow", "none");
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        await expect(steps.nth(1)).toHaveCSS("outline-style", "solid");
        const input = panel.locator(".user-input-freeform input");
        await input.fill("Сохранённый ответ");
        await expect(panel.locator(".user-input-freeform")).toHaveCSS("outline-style", "solid");
        await expect(input).toHaveAccessibleName(language === "ru" ? "Свой ответ" : "Your answer");
        const gap = async (before: string, after: string) => {
          const first = (await page.locator(before).boundingBox())!;
          const second = (await page.locator(after).boundingBox())!;
          return second.y - first.y - first.height;
        };
        expect(await gap(".voice-transcription-message", ".attention-stack")).toBeCloseTo(16, 0);
        expect(await gap(".attention-stack", ".outgoing-messages")).toBeCloseTo(16, 0);
        expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        if (theme === "dark" && language === "ru" && width === 390) {
          await page.screenshot({ path: testInfo.outputPath("questions-mobile.png") });
        }
        detail.queuedMessages[0]!.dismissUserInput = {
          turnId: question.turnId!,
          itemId: question.itemId!,
        };
        send({
          type: "queue.changed",
          threadId: attentionThread.id,
          messages: detail.queuedMessages,
        });
        await expect(panel).toBeHidden();
        await expect(activity).toContainText(waitingLabel);
        expect(await gap(".voice-transcription-message", ".outgoing-messages")).toBeCloseTo(16, 0);
        detail.queuedMessages[0]!.deliveryError = { message: "Delivery failed", retryable: false };
        send({
          type: "queue.changed",
          threadId: attentionThread.id,
          messages: detail.queuedMessages,
        });
        await expect(panel).toBeVisible();
        await expect(activity).toContainText(waitingLabel);
        await expect(input).toHaveValue("Сохранённый ответ");
        await expect(steps.nth(1)).toHaveAttribute("aria-current", "step");
        send({ type: "attention.removed", attentionId: question.id });
        await expect(panel).toHaveCount(0);
        await expect(activity).toContainText(
          language === "ru" ? "Codex работает" : "Codex is working",
        );
        await expect(activity.locator(".spinner")).toHaveCount(1);
        expect(await gap(".voice-transcription-message", ".outgoing-messages")).toBeCloseTo(16, 0);
      });
    }
  }
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [320, 1440]) {
    test(`${theme} ${width}: question recording timer stays round and uses seconds`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await installVisualFixture(page, { theme });
      await page.goto("/threads/session-attention");
      await page.evaluate(() => {
        class Recorder extends EventTarget {
          static isTypeSupported() {
            return true;
          }
          state = "inactive";
          mimeType = "audio/webm";
          start() {
            this.state = "recording";
          }
          stop() {
            this.state = "inactive";
            this.dispatchEvent(new Event("stop"));
          }
        }
        Object.defineProperty(window, "MediaRecorder", { configurable: true, value: Recorder });
        Object.defineProperty(navigator, "mediaDevices", {
          configurable: true,
          value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
        });
      });
      const panel = page.locator(".attention-stack");
      const input = panel.getByRole("textbox", { name: "Свой ответ" });
      await input.fill("Сохранённый ответ");
      const startedAt = await page.evaluate(() => Date.now());
      await panel.getByRole("button", { name: "Начать запись" }).click();
      const timer = panel.getByRole("button", { name: "Остановить запись" });
      await expect(timer).toHaveText("0");
      const before = (await timer.boundingBox())!;
      await page.evaluate((now) => {
        Date.now = () => now;
      }, startedAt + 125000);
      await expect(timer).toHaveText("125");
      const after = (await timer.boundingBox())!;
      expect(after.width).toBe(width <= 820 ? 32 : 34);
      expect(after.height).toBe(after.width);
      expect(after.width).toBe(before.width);
      expect(after.x).toBe(before.x);
      await expect(timer).toHaveCSS("border-radius", "50%");
      await panel.getByRole("button", { name: "Отменить запись" }).click();
      await expect(input).toHaveValue("Сохранённый ответ");
      await expect(panel.getByRole("button", { name: "Начать запись" })).toBeVisible();
    });
  }
}
