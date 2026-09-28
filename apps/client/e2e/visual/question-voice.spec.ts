import { expect, test } from "@playwright/test";
import type { AttentionRequest, ThreadDetail, VoiceTranscriptionJob } from "@codexnest/protocol";
import { attentionThread, installVisualFixture, snapshot, waitForVisualReady } from "./fixtures";

for (const theme of ["light", "dark"] as const) {
  for (const width of [320, 390, 1440]) {
    test(`question voice queue ${theme} ${width}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      const draftKey = "a".repeat(64);
      const now = Date.UTC(2026, 7, 3, 12);
      const recordings: VoiceTranscriptionJob[] = [
        {
          id: "first",
          threadId: attentionThread.id,
          mode: "draft",
          userInput: { draftKey, questionId: "background", order: 1 },
          status: "completed",
          transcript: "Да, продолжать обработку на сервере, даже если я закрою приложение.",
          createdAt: now - 30_000,
          startedAt: now - 25_000,
          audioDurationMs: 7_000,
          estimatedTotalSeconds: 8,
          error: null,
        },
        {
          id: "second",
          threadId: attentionThread.id,
          mode: "draft",
          userInput: { draftKey, questionId: "sending", order: 1 },
          status: "completed",
          transcript: "Дождаться всех записей и отправить ответы вместе.",
          createdAt: now - 20_000,
          startedAt: now - 15_000,
          audioDurationMs: 7_000,
          estimatedTotalSeconds: 8,
          error: null,
        },
        {
          id: "third",
          threadId: attentionThread.id,
          mode: "draft",
          userInput: { draftKey, questionId: "sending", order: 2 },
          status: "transcribing",
          createdAt: now - 10_000,
          startedAt: now - 4_000,
          audioDurationMs: 7_000,
          estimatedTotalSeconds: 12,
          error: null,
        },
        {
          id: "fourth",
          threadId: attentionThread.id,
          mode: "draft",
          userInput: { draftKey, questionId: "navigation", order: 1 },
          status: "queued",
          createdAt: now - 5_000,
          startedAt: null,
          audioDurationMs: 7_000,
          estimatedTotalSeconds: 8,
          error: null,
        },
      ];
      const request: Extract<AttentionRequest, { kind: "userInput" }> = {
        id: "voice-questions",
        kind: "userInput",
        threadId: attentionThread.id,
        turnId: "turn-attention",
        itemId: "questions",
        createdAt: now - 60_000,
        autoResolutionMs: null,
        draftKey,
        questions: [
          {
            id: "background",
            header: "Обработка в фоне",
            question: "Продолжать ли обработку голосовых после закрытия приложения?",
            options: null,
            isOther: true,
            isSecret: false,
          },
          {
            id: "sending",
            header: "Отправка ответов",
            question: "Что делать, если нажать «Отправить ответы», пока записи ещё распознаются?",
            options: null,
            isOther: true,
            isSecret: false,
          },
          {
            id: "navigation",
            header: "Переход между вопросами",
            question: "Можно ли переключиться на другой вопрос во время записи голосового?",
            options: null,
            isOther: true,
            isSecret: false,
          },
        ],
        draft: {
          answers: {
            background: [recordings[0]!.transcript!],
            sending: [recordings[1]!.transcript!],
          },
          currentQuestionId: "navigation",
          revision: 3,
          updatedAt: now,
          appliedRecordingIds: ["first", "second"],
          recordings,
          submission: {
            recordingIds: recordings.map((recording) => recording.id),
            clientMessageId: "reply",
            status: "waiting",
          },
        },
      };
      const seed = structuredClone(snapshot);
      seed.attention = [request];
      seed.voiceTranscriptions = recordings;
      const detail: ThreadDetail = {
        summary: attentionThread,
        turns: [],
        olderTurnsCursor: null,
        queuedMessages: [],
        draft: null,
      };
      await installVisualFixture(page, { theme, snapshot: seed });
      await page.route("**/api/v1/threads/session-attention", (route) =>
        route.fulfill({ json: detail, headers: { "access-control-allow-origin": "*" } }),
      );
      await page.goto("/threads/session-attention");
      await waitForVisualReady(page);
      const card = page.locator(".timeline .user-input-card");
      await expect(card.getByText("Ответы подтверждены")).toBeVisible();
      await expect(card.locator(".user-input-voice-question-text")).toHaveText(
        request.questions.map((question) => question.question),
      );
      await expect(card.locator(".user-input-voice-recording")).toHaveCount(4);
      await expect(card.locator(".user-input-voice-transcript")).toHaveText([
        recordings[0]!.transcript!,
        recordings[1]!.transcript!,
      ]);
      await expect(card.locator(".completed .user-input-voice-recording-title")).toHaveText([
        "Запись 1",
        "Запись 1",
      ]);
      await expect(card.locator(".transcribing time")).toHaveText("≈8 с");
      await expect(card.locator(".queued time")).toHaveText("5 с");
      await expect(card.locator("textarea, input")).toHaveCount(0);
      await expect(page.locator(".voice-transcription-message")).toHaveCount(0);
      expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await card.screenshot({ path: testInfo.outputPath(`question-voice-${theme}-${width}.png`) });
      await page.reload();
      await expect(card.locator(".user-input-voice-recording")).toHaveCount(4);
    });
  }
}
