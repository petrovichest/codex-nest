import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import type { ThreadDetail } from "@codexnest/protocol";
import { installVisualFixture, snapshot, waitForVisualReady } from "./fixtures";

const comment = "Стена из ОСБ в несколько листов, около 7 см. Плинтуса нет.";
const quote = "Из чего сделана стена?";

async function openChat(
  page: Page,
  theme: "light" | "dark",
  text: string,
  images: string[] = [],
  type: "agentMessage" | "userMessage" = "agentMessage",
) {
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
            type,
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
  await expect(page.locator(`.message.${type}`)).toBeVisible();
  await waitForVisualReady(page);
}

function imageSource(width: number, height: number) {
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#697760"/><path d="M0 0L${width} ${height}M0 ${height}L${width} 0" stroke="#ced8c7" stroke-width="4"/></svg>`)}`;
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [320, 390, 820, 821, 1440]) {
    test(`image gallery at ${width}px in ${theme}: links, wrapping and shared viewer`, async ({
      page,
      browserName,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      const titles = ["Узкая панель", "Широкая панель", "Горизонтальная панель"];
      await page.route("https://image.test/*.png", (route) => {
        const i = Number(new URL(route.request().url()).pathname[1]);
        const panel = [
          { x: 120, y: 80, w: 64, h: 260 },
          { x: 68, y: 180, w: 180, h: 150 },
          { x: 60, y: 200, w: 200, h: 110 },
        ][i]!;
        return route.fulfill({
          contentType: "image/svg+xml",
          headers: { "access-control-allow-origin": "*" },
          body: `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="500"><rect width="300" height="500" fill="#eeede7"/><path d="M0 390h300v110H0z" fill="#b9ad98"/><rect x="${panel.x}" y="${panel.y}" width="${panel.w}" height="${panel.h}" rx="3" fill="#b79f7e"/><path d="M95 244h104m-88 44h90" stroke="#e8dfcb" stroke-width="9"/><rect x="53" y="346" width="199" height="12" rx="3" fill="#424840"/><path d="M66 358v89m174-89v89" stroke="#424840" stroke-width="6"/><rect x="112" y="304" width="90" height="40" rx="3" fill="#616c60"/><circle cx="88" cy="224" r="12" fill="#798969"/></svg>`,
        });
      });
      await openChat(
        page,
        theme,
        "Подготовил три варианта размещения панели:\n\n" +
          titles.map((title, i) => `- [${title}](https://image.test/${i}.png)`).join("\n") +
          "\n\nВсе варианты можно рассмотреть крупнее.\n\n![Широкая панель](https://image.test/1.png)",
        ["https://image.test/0.png"],
      );
      const gallery = page.locator(".message-image-gallery");
      await expect(gallery.locator(".is-ready")).toHaveCount(3);
      await expect(page.locator(".message-markdown img")).toHaveCount(0);
      expect((await gallery.boundingBox())!.y).toBeGreaterThan(
        (await page.locator(".message-markdown").boundingBox())!.y,
      );
      expect(
        await page
          .locator(".conversation-scroll")
          .evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      const tiles = await gallery.locator("button").evaluateAll((elements) =>
        elements.map((el) => ({
          x: el.getBoundingClientRect().x,
          y: el.getBoundingClientRect().y,
          height: el.getBoundingClientRect().height,
        })),
      );
      expect(tiles[0]!.height).toBe(width <= 820 ? 160 : 200);
      if (width === 320) expect(tiles[2]!.y).toBeGreaterThan(tiles[0]!.y);
      if (browserName === "chromium" && [390, 1440].includes(width)) {
        await expect(page).toHaveScreenshot(`image-gallery-${width}-${theme}.png`);
        if (process.env.UPDATE_GALLERY_DOCS)
          await page.screenshot({
            path: resolve(
              import.meta.dirname,
              `../../../../docs/assets/chat-gallery-${width}-${theme}.png`,
            ),
            animations: "disabled",
          });
      }
      const opener = page
        .locator(".message-markdown")
        .getByRole("button", { name: "Открыть изображение Широкая панель", exact: true })
        .first();
      await opener.click();
      const viewer = page.getByRole("dialog", { name: "Просмотр изображений" });
      await expect(viewer.getByText("Изображение 2 из 3")).toBeVisible();
      await page.keyboard.press("ArrowRight");
      await expect(viewer.getByAltText(titles[2]!)).toBeVisible();
      await expect(viewer.getByRole("button", { name: "Следующее изображение" })).toBeDisabled();
      const download = page.waitForEvent("download");
      await viewer.getByRole("button", { name: `Скачать ${titles[2]}` }).click();
      expect(await (await download).failure()).toBeNull();
      await page.keyboard.press("Escape");
      await expect(opener).toBeFocused();
      const thumbnail = gallery.getByRole("button", {
        name: "Открыть изображение Широкая панель",
        exact: true,
      });
      await thumbnail.click();
      await expect(viewer.getByText("Изображение 2 из 3")).toBeVisible();
      await viewer.getByRole("button", { name: "Закрыть", exact: true }).click();
      await expect(thumbnail).toBeFocused();
    });
  }
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
      await expect(input).toHaveCSS("font-size", "15px");
      await expect(input).toHaveCSS("font-weight", "400");
      await expect(input).toHaveCSS("resize", "none");
      await expect(input).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(input).toHaveCSS("outline-style", "none");
      await expect(input).toHaveCSS("box-shadow", "none");
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
      await expect(page.locator(".gallery-thumbnail.is-loading")).toHaveCount(0);
      const frames = page.locator(".gallery-thumbnail");
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
        expect(image.height).toBeLessThanOrEqual(width <= 820 ? 160 : 200);
        expect(image.width).toBeLessThanOrEqual(natural.width);
        expect(image.height).toBeLessThanOrEqual(natural.height);
      }
      expect(
        await page
          .locator(".conversation-scroll")
          .evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      const opener = page.locator(".message-markdown").getByRole("button", {
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
    await expect(page.locator(".gallery-thumbnail.is-loading")).toHaveCount(0);
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

for (const theme of ["light", "dark"] as const) {
  for (const text of [
    "",
    "Давай подумаем ещё над вариантами левой панели. На телефоне она сильно выбивается.",
  ]) {
    test(`user images stay inside the message after loading and resizing, ${theme}, ${text ? "with text" : "images only"}`, async ({
      page,
    }) => {
      const sizes = [
        [712, 1796],
        [300, 4000],
        [1600, 480],
        [80, 40],
      ];
      const sources = sizes.map((_, i) => `https://image.test/user-${i}.png`);
      let releaseImage!: () => void;
      const imageGate = new Promise<void>((resolve) => {
        releaseImage = resolve;
      });
      const png = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 712;
        canvas.height = 1796;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "#697760";
        context.fillRect(0, 0, canvas.width, canvas.height);
        return canvas.toDataURL().split(",")[1]!;
      });
      await page.route("https://image.test/user-*.png", async (route) => {
        const index = Number(new URL(route.request().url()).pathname.match(/user-(\d+)/)![1]);
        if (index === 0) {
          await imageGate;
          await route.fulfill({ contentType: "image/png", body: Buffer.from(png, "base64") });
        } else {
          const [w, h] = sizes[index]!;
          await route.fulfill({
            contentType: "image/svg+xml",
            body: decodeURIComponent(imageSource(w!, h!).split(",")[1]!),
          });
        }
      });
      await page.setViewportSize({ width: 1440, height: 900 });
      // Opening the transcript must not wait for the deferred attachment.
      const opening = openChat(page, theme, text, [sources[0]!], "userMessage");
      await page.locator(".message-images img").waitFor({ state: "attached" });
      await page.setViewportSize({ width: 390, height: 844 });
      releaseImage();
      await opening;
      const expectContained = async () => {
        await page
          .locator(".message-images img")
          .evaluateAll((images) =>
            Promise.all(images.map((image) => (image as HTMLImageElement).decode())),
          );
        await waitForVisualReady(page);
        const measurements = await page.locator(".message-images img").evaluateAll((images) =>
          images.map((node) => {
            const image = node as HTMLImageElement;
            const frame = image.closest("button")!.getBoundingClientRect();
            const grid = image.closest(".message-images")!.getBoundingClientRect();
            const body = image.closest(".message-body")!;
            const box = body.getBoundingClientRect();
            const style = getComputedStyle(body);
            const rect = image.getBoundingClientRect();
            return {
              bottom: rect.bottom,
              frameBottom: frame.bottom,
              gridBottom: grid.bottom,
              contentBottom: box.bottom - parseFloat(style.paddingBottom),
              left: rect.left,
              right: rect.right,
              contentLeft: box.left + parseFloat(style.paddingLeft),
              contentRight: box.right - parseFloat(style.paddingRight),
              ratio: rect.width / rect.height,
              naturalRatio: image.naturalWidth / image.naturalHeight,
              height: rect.height,
              maxHeight: Math.min(480, innerHeight * 0.65),
              enlarged:
                rect.width > image.naturalWidth + 1 || rect.height > image.naturalHeight + 1,
            };
          }),
        );
        for (const m of measurements) {
          expect(m.bottom).toBeLessThanOrEqual(m.frameBottom + 1);
          expect(m.frameBottom).toBeLessThanOrEqual(m.gridBottom + 1);
          expect(m.gridBottom).toBeLessThanOrEqual(m.contentBottom + 1);
          expect(m.left).toBeGreaterThanOrEqual(m.contentLeft - 1);
          expect(m.right).toBeLessThanOrEqual(m.contentRight + 1);
          expect(m.ratio).toBeCloseTo(m.naturalRatio, 2);
          expect(m.height).toBeLessThanOrEqual(m.maxHeight + 1);
          expect(m.enlarged).toBe(false);
        }
        expect(
          await page
            .locator(".conversation-scroll")
            .evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
      };
      await expectContained();
      await page.setViewportSize({ width: 1440, height: 900 });
      await expectContained();
      await page.locator(".message-image-preview").click();
      const viewer = page.getByRole("dialog", { name: "Просмотр изображений" });
      await expect(viewer).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(viewer).toHaveCount(0);
      await expect(page.locator(".message-image-preview")).toBeFocused();

      await openChat(page, theme, text, sources, "userMessage");
      for (const width of [1440, 320, 390, 820, 821, 1920, 1440]) {
        await page.setViewportSize({ width, height: width <= 820 ? 844 : 900 });
        await expectContained();
      }
    });
  }
}
