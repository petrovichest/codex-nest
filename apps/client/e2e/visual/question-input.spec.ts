import { expect, test, type Page, type Locator } from "@playwright/test";
import type { AttentionRequest, ServerEvent, VoiceTranscriptionJob } from "@codexnest/protocol";
import { installVisualFixture, snapshot, waitForVisualReady } from "./fixtures";

async function openQuestions(page: Page, theme: "light" | "dark", fallback = false) {
  if (fallback) {
    await page.addInitScript(() => {
      const supports = CSS.supports.bind(CSS);
      CSS.supports = (property: string, value?: string) =>
        property === "field-sizing"
          ? false
          : value === undefined
            ? supports(property)
            : supports(property, value);
    });
  }
  const request: Extract<AttentionRequest, { kind: "userInput" }> = {
    ...(snapshot.attention[0] as Extract<AttentionRequest, { kind: "userInput" }>),
    draftKey: "a".repeat(64),
    itemId: "questions",
    questions: [
      {
        id: "background",
        header: "Фоновая обработка",
        question: "Как должны обрабатываться голосовые ответы на вопросы?",
        options: null,
        isOther: true,
        isSecret: false,
      },
      {
        id: "sending",
        header: "Отправка",
        question: "Когда отправлять готовые ответы?",
        options: null,
        isOther: true,
        isSecret: false,
      },
      {
        id: "secret",
        header: "Секрет",
        question: "Введите секретный ответ",
        options: null,
        isOther: true,
        isSecret: true,
      },
    ],
    draft: { answers: {}, currentQuestionId: "background", revision: 1, updatedAt: 1 },
  };
  const seed = structuredClone(snapshot);
  seed.attention = [request];
  await installVisualFixture(page, { theme, snapshot: seed });
  await page.route(`**/api/v1/attention/${request.id}/draft`, async (route) => {
    if (route.request().method() === "OPTIONS") return route.fallback();
    request.draft = {
      ...request.draft,
      ...route.request().postDataJSON(),
      revision: request.draft!.revision + 1,
      updatedAt: request.draft!.updatedAt + 1,
    };
    await route.fulfill({
      json: request.draft,
      headers: { "access-control-allow-origin": "*" },
    });
  });
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
  await page.goto("/threads/session-attention");
  if (fallback)
    await page.addStyleTag({
      content: ".user-input-freeform textarea { field-sizing: fixed !important; }",
    });
  await waitForVisualReady(page);
  const card = page.locator(".timeline .user-input-card");
  const field = card.getByRole("textbox", { name: "Свой ответ" });
  return {
    card,
    field,
    surface: card.locator(".user-input-freeform"),
    request,
    completeRecording(text: string) {
      const job: VoiceTranscriptionJob = {
        id: "voice-answer",
        threadId: request.threadId!,
        mode: "draft",
        status: "completed",
        userInput: { draftKey: request.draftKey!, questionId: "background", order: 1 },
        transcript: text,
        createdAt: 1,
        startedAt: 1,
        audioDurationMs: 1000,
        estimatedTotalSeconds: 1,
        error: null,
      };
      const draft = request.draft!;
      request.draft = {
        ...draft,
        answers: {
          ...draft.answers,
          background: [[draft.answers.background?.[0], text].filter(Boolean).join(" ")],
        },
        revision: draft.revision + 1,
        appliedRecordingIds: [job.id],
        recordings: [job],
      };
      send({ type: "voiceTranscription.upserted", job });
      send({ type: "attention.upserted", attention: request });
    },
  };
}

const height = (field: Locator) =>
  field.evaluate((element) => Math.round(element.getBoundingClientRect().height));

for (const theme of ["light", "dark"] as const) {
  for (const width of [320, 390, 1440]) {
    test(`question input ${theme} ${width}: one line, growth and navigation`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      const { card, field, surface } = await openQuestions(page, theme);
      await expect(field).toHaveAttribute("rows", "1");
      await expect(field).toHaveCSS("resize", "none");
      const textLeftEdges = await card
        .locator("legend, fieldset > p, .user-input-freeform-label")
        .evaluateAll((elements) =>
          elements.map((element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            return Math.round(range.getBoundingClientRect().left);
          }),
        );
      expect(new Set(textLeftEdges).size).toBe(1);
      const singleLine = await field.evaluate((element) => {
        const style = getComputedStyle(element);
        return Math.round(
          parseFloat(style.lineHeight) +
            parseFloat(style.paddingTop) +
            parseFloat(style.paddingBottom),
        );
      });
      await expect.poll(() => height(field)).toBe(singleLine);
      if (width === 390)
        await card.screenshot({ path: testInfo.outputPath(`question-empty-${theme}.png`) });
      await field.fill("Да, в фоне.");
      await expect.poll(() => height(field)).toBe(singleLine);
      await field.fill(
        "Распознавать каждую запись в фоне.\nДобавлять текст в нужный вопрос.\nСохранять мои ручные правки.",
      );
      await expect.poll(() => height(field)).toBeGreaterThan(singleLine);
      if (width === 390)
        await card.screenshot({ path: testInfo.outputPath(`question-expanded-${theme}.png`) });
      const longAnswer = "Длинный ответ без ручного переноса строк. ".repeat(80);
      await field.fill(longAnswer);
      await expect.poll(() => height(surface)).toBe(190);
      expect(await field.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
        true,
      );
      if (width === 390)
        await card.screenshot({ path: testInfo.outputPath(`question-scrolled-${theme}.png`) });
      await card.getByRole("button", { name: "Далее", exact: true }).click();
      await expect(field).toHaveValue("");
      await expect.poll(() => height(field)).toBe(singleLine);
      await card.getByRole("button", { name: "Назад", exact: true }).click();
      await expect(field).toHaveValue(longAnswer);
      await expect.poll(() => height(surface)).toBe(190);
      await field.fill("");
      await expect.poll(() => height(field)).toBe(singleLine);
      await card.getByRole("button", { name: "Далее", exact: true }).click();
      await card.getByRole("button", { name: "Далее", exact: true }).click();
      await expect(card.locator('input[type="password"]')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    });
  }

  test(`question input ${theme}: fallback follows width and background transcription`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const { card, field, surface, request, completeRecording } = await openQuestions(
      page,
      theme,
      true,
    );
    const compact = await height(field);
    const text = "Мой ответ. ".repeat(12);
    await field.fill(text);
    const desktopHeight = await height(field);
    await page.setViewportSize({ width: 320, height: 1000 });
    await expect.poll(() => height(field)).toBeGreaterThan(desktopHeight);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect.poll(() => height(field)).toBe(desktopHeight);
    await field.fill("Короткий ответ.");
    await expect.poll(() => height(field)).toBe(compact);
    await expect.poll(() => request.draft?.answers.background?.[0]).toBe("Короткий ответ.");
    completeRecording("Распознанная часть ответа. ".repeat(80).trim());
    await expect(field).toHaveValue(/^Короткий ответ\. Распознанная часть ответа\./);
    await expect.poll(() => height(surface)).toBe(190);
    await card.getByRole("button", { name: "Далее", exact: true }).click();
    await expect.poll(() => height(field)).toBe(compact);
    await card.getByRole("button", { name: "Назад", exact: true }).click();
    await expect.poll(() => height(surface)).toBe(190);
    await field.fill("");
    await expect.poll(() => height(field)).toBe(compact);
  });
}
