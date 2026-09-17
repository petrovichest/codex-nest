import { expect, test, type Page } from "@playwright/test";
import type { ThreadDetail } from "@codexnest/protocol";
import { installVisualFixture, snapshot, waitForVisualReady } from "./fixtures";

const comment = "Стена из ОСБ в несколько листов, около 7 см. Плинтуса нет.";
const quote = "Из чего сделана стена?";

async function openChat(page: Page, theme: "light" | "dark", text: string, images: string[] = []) {
  const seed = structuredClone(snapshot);
  seed.attention = [];
  const summary = seed.threads.find((item) => item.id === "session-main")!;
  summary.title = "Уточнения по стене";
  summary.browserStatus = "disabled";
  summary.settings.collaborationMode = "default";
  const detail: ThreadDetail = {
    summary,
    olderTurnsCursor: null,
    queuedMessages: [],
    draft: {
      input: "",
      images: [],
      goalMode: false,
      updatedAt: summary.updatedAt,
      annotations: text.includes(quote)
        ? [
            {
              id: "note",
              messageId: "message",
              source: "agentMessage",
              quote,
              startOffset: text.indexOf(quote),
              endOffset: text.indexOf(quote) + quote.length,
              comment,
              createdAt: summary.updatedAt,
            },
          ]
        : [],
    },
    turns: [
      {
        id: "turn",
        status: "completed",
        startedAt: summary.updatedAt - 34000,
        completedAt: summary.updatedAt,
        durationMs: 34000,
        items: [
          {
            id: "message",
            type: "agentMessage",
            text,
            images,
            status: "completed",
            timestamp: summary.updatedAt,
            phase: "final_answer",
          },
        ],
      },
    ],
  };
  await installVisualFixture(page, { theme, snapshot: seed });
  await page.route("**/api/v1/threads/session-main", (route) =>
    route.fulfill({
      json: detail,
      headers: { "access-control-allow-origin": "*" },
    }),
  );
  await page.goto("/threads/session-main");
  await expect(page.locator(".message.agentMessage")).toBeVisible();
  await waitForVisualReady(page);
}

function imageSource(width: number, height: number) {
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#697760"/><path d="M0 0L${width} ${height}M0 ${height}L${width} 0" stroke="#ced8c7" stroke-width="4"/></svg>`)}`;
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [320, 1440]) {
    test(`annotation B at ${width}px in ${theme}: sizing, focus, saving and keyboard viewport`, async ({
      page,
      browserName,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await openChat(page, theme, `Уточню несколько деталей.\n\n${quote}`);
      const composer = await page.locator(".composer-box").boundingBox();
      await page.getByRole("button", { name: "Аннотация 1", exact: true }).click();
      const form = page.locator(".annotation-editor");
      const input = form.getByRole("textbox");
      const remove = form.getByRole("button", { name: "Удалить аннотацию" });
      const save = form.getByRole("button", { name: "Сохранить аннотацию" });
      await expect(input).toHaveValue(comment);
      await expect(input).toHaveCSS("font-size", "16px");
      await expect(input).toHaveCSS("font-weight", "400");
      await expect(input).toHaveCSS("resize", "none");
      await expect(input).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      for (const button of [remove, save]) {
        await expect(button).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        const bounds = (await button.boundingBox())!;
        expect(bounds.width).toBe(36);
        expect(bounds.height).toBe(36);
      }
      const first = (await remove.boundingBox())!,
        second = (await save.boundingBox())!;
      expect(first.x).toBe(second.x);
      expect(second.y - first.y - first.height).toBe(4);
      const bounds = (await form.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(16);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 16);
      expect(await page.locator(".composer-box").boundingBox()).toEqual(composer);
      await page.mouse.move(0, 0);
      if (browserName === "chromium")
        await expect(form).toHaveScreenshot(`annotation-b-${width}-${theme}.png`);
      await save.hover();
      await expect(save).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await remove.hover();
      await expect(remove).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await input.focus();
      await page.keyboard.press("Tab");
      await expect(remove).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(save).toBeFocused();
      await expect(save).toHaveCSS("outline-style", "solid");

      await input.fill(`${comment}\n`.repeat(25));
      expect(await input.evaluate((el) => el.scrollHeight)).toBeGreaterThan(176);
      expect((await input.boundingBox())!.height).toBe(176);
      await input.evaluate((el) => {
        el.scrollTop = 80;
      });
      await expect.poll(() => input.evaluate((el) => el.scrollTop)).toBe(80);
      await page.evaluate(() => {
        const viewport = window.visualViewport!;
        Object.defineProperty(viewport, "height", { configurable: true, value: 280 });
        Object.defineProperty(viewport, "offsetTop", { configurable: true, value: 60 });
        viewport.dispatchEvent(new Event("resize"));
      });
      const keyboardBounds = (await form.boundingBox())!;
      expect(keyboardBounds.y).toBeGreaterThanOrEqual(76);
      expect(keyboardBounds.y + keyboardBounds.height).toBeLessThanOrEqual(324);
      await input.fill("");
      await expect(save).toBeDisabled();
      await input.fill("Уточнённый комментарий");
      await save.click();
      await expect(form).toHaveCount(0);
      await page.getByRole("button", { name: "Аннотация 1", exact: true }).click();
      await expect(input).toHaveValue("Уточнённый комментарий");
      await remove.click();
      await expect(form).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Аннотация 1", exact: true })).toHaveCount(0);
    });

    test(`image content fits its clickable frame at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const sources = [
        [1600, 480],
        [400, 1200],
        [800, 800],
        [80, 40],
      ].map(([w, h]) => imageSource(w!, h!));
      await page.route("https://image.test/*.svg", (route) => {
        const index = Number(new URL(route.request().url()).pathname.slice(1, 2));
        return route.fulfill({
          contentType: "image/svg+xml",
          body: decodeURIComponent(sources[index]!.split(",")[1]!),
        });
      });
      await openChat(
        page,
        theme,
        sources
          .map((_, index) => `![Превью ${index}](https://image.test/${index}.svg)`)
          .join("\n\n"),
        sources,
      );
      await expect(page.locator(".markdown-image-preview.is-loading")).toHaveCount(0);
      const frames = page.locator(".markdown-image-preview,.message-image-preview");
      await expect(frames).toHaveCount(8);
      const dimensions = await frames.evaluateAll((elements) =>
        elements.map((el) => {
          const img = el.querySelector("img")!;
          const frame = el.getBoundingClientRect(),
            image = img.getBoundingClientRect();
          return {
            frame: { width: frame.width, height: frame.height },
            image: { width: image.width, height: image.height },
            natural: { width: img.naturalWidth, height: img.naturalHeight },
          };
        }),
      );
      for (const { frame, image, natural } of dimensions) {
        expect(Math.abs(frame.width - image.width)).toBeLessThan(1);
        expect(Math.abs(frame.height - image.height)).toBeLessThan(1);
        expect(image.width / image.height).toBeCloseTo(natural.width / natural.height, 2);
        expect(image.height).toBeLessThanOrEqual(480);
        expect(image.width).toBeLessThanOrEqual(natural.width);
        expect(image.height).toBeLessThanOrEqual(natural.height);
      }
      expect(
        await page
          .locator(".conversation-scroll")
          .evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      const opener = page.getByRole("button", {
        name: "Открыть изображение Превью 0",
        exact: true,
      });
      await opener.click();
      await expect(page.getByRole("dialog", { name: "Просмотр изображений" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(opener).toBeFocused();
    });
  }
}

for (const readingAbove of [false, true]) {
  test(`late image load preserves ${readingAbove ? "reading position" : "tail following"}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    await page.route("https://image.test/delayed.svg", async (route) => {
      await pending;
      await route.fulfill({
        contentType: "image/svg+xml",
        body: decodeURIComponent(imageSource(400, 1200).split(",")[1]!),
      });
    });
    const paragraphs = Array.from(
      { length: 28 },
      (_, i) => `Абзац ${i}. Продолжение сообщения для проверки положения при чтении.`,
    ).join("\n\n");
    await openChat(page, "dark", `![Схема](https://image.test/delayed.svg)\n\n${paragraphs}`);
    const scroll = page.locator(".conversation-scroll");
    const distance = () =>
      scroll.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
    await expect.poll(distance).toBeLessThan(2);
    const anchor = page.getByText(
      "Абзац 12. Продолжение сообщения для проверки положения при чтении.",
      { exact: true },
    );
    if (readingAbove) {
      await anchor.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await expect(
        page.getByRole("button", { name: "Прокрутить к последнему сообщению" }),
      ).toBeVisible();
    }
    const before = (await anchor.boundingBox())!.y;
    finish();
    await expect(page.locator(".markdown-image-preview.is-loading")).toHaveCount(0);
    if (readingAbove) {
      await expect
        .poll(async () => Math.abs((await anchor.boundingBox())!.y - before))
        .toBeLessThan(2);
      expect(await distance()).toBeGreaterThan(300);
    } else {
      await expect.poll(distance).toBeLessThan(2);
    }
  });
}
