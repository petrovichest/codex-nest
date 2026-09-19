import { expect, test, type Locator, type Page } from "@playwright/test";
import type {
  QueueMessageRequest,
  ThreadDetail,
  UpdateThreadDraftRequest,
} from "@codexnest/protocol";
import { installVisualFixture, mainThread, snapshot, waitForVisualReady } from "./fixtures";

const text = "Проверь FATCOINUSDT и объясни причину пропущенного входа.";
const inlinePastes = [{ id: "symbol", start: 8, end: 19 }];
const pasteBlocks = [
  {
    id: "log",
    text: "## Пропущенные входы\n\n| Пара | Причина |\n| --- | --- |\n| FATCOINUSDT | Прибыль ниже порога |\n\n**Проверь расчёт** и исходные значения.\n\n```text\n[12:39:02] mexc sell FATCOINUSDT\nexpected_profit=0.024\nmin_profit=0.030\n```",
  },
];

async function setup(page: Page, theme: "light" | "dark", withContent = false) {
  const summary = {
    ...mainThread,
    settings: { ...mainThread.settings, collaborationMode: "default" as const },
  };
  const seeded = structuredClone(snapshot);
  seeded.threads = [summary];
  seeded.attention = [];
  await installVisualFixture(page, { theme, snapshot: seeded });
  await page.route("http://127.0.0.1:4310/**", (route) => route.abort());
  const detail: ThreadDetail = {
    summary,
    olderTurnsCursor: null,
    queuedMessages: [],
    draft: withContent
      ? {
          input: text,
          inlinePastes,
          pasteBlocks,
          images: [],
          goalMode: false,
          annotations: [],
          updatedAt: 1,
        }
      : null,
    turns: withContent
      ? [
          {
            id: "turn-paste",
            status: "completed",
            error: null,
            items: [
              {
                type: "userMessage",
                id: "sent-paste",
                text,
                inlinePastes,
                pasteBlocks,
                images: [],
                status: "completed",
                phase: null,
                timestamp: Date.now(),
              },
            ],
          },
        ]
      : [],
  };
  let submitted: QueueMessageRequest | null = null;
  let draft: UpdateThreadDraftRequest | null = detail.draft;
  await page.route("**/api/v1/threads/session-main{,/**}", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const headers = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "Authorization, Content-Type",
      "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (path.endsWith("/draft")) {
      if (request.method() === "PUT") draft = request.postDataJSON();
      return route.fulfill({ json: draft ? { ...draft, updatedAt: Date.now() } : null, headers });
    }
    if (path.endsWith("/queue") && request.method() === "POST") {
      submitted = request.postDataJSON() as QueueMessageRequest;
      const message = {
        id: submitted.clientMessageId!,
        threadId: summary.id,
        text: submitted.input,
        inlinePastes: submitted.inlinePastes,
        pasteBlocks: submitted.pasteBlocks,
        status: "queued" as const,
        createdAt: Date.now(),
      };
      detail.queuedMessages.push(message);
      detail.draft = null;
      draft = null;
      return route.fulfill({ status: 202, json: message, headers });
    }
    if (path === "/api/v1/threads/session-main")
      return route.fulfill({
        json: { ...detail, draft: draft ? { ...draft, updatedAt: 1 } : null },
        headers,
      });
    return route.fallback();
  });
  await page.goto("/threads/session-main");
  await waitForVisualReady(page);
  return { submitted: () => submitted, draft: () => draft };
}

async function paste(field: Locator, text: string, html = "") {
  await field.evaluate(
    (element, content) => {
      const data = new DataTransfer();
      data.setData("text/plain", content.text);
      if (content.html) data.setData("text/html", content.html);
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    },
    { text, html },
  );
}

for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390]) {
    test(`pasted cards and inline marks use the chat kit at ${width}px in ${theme}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await setup(page, theme, true);
      const sent = page.locator('[data-message-id="sent-paste"]');
      const card = sent.locator(".paste-card");
      const bubble = sent.locator(".message-body");
      const surface = theme === "light" ? "rgb(248, 249, 246)" : "rgb(36, 39, 34)";
      await expect(page.locator(".composer-box")).toHaveCSS("background-color", surface);
      await expect(page.locator(".composer .paste-card")).toHaveCSS("background-color", surface);
      await expect(card).toHaveCSS("background-color", surface);
      for (const pasteCard of [card, page.locator(".composer .paste-card")]) {
        await expect(pasteCard).toHaveCSS("border-radius", "20px");
        await expect(pasteCard.locator(".paste-card-toggle")).toHaveCSS("border-radius", "16px");
        await pasteCard.getByRole("button", { expanded: false }).click();
        await expect(pasteCard.getByRole("table")).toHaveCSS("font-size", "14px");
        await expect(pasteCard.locator("pre code")).toHaveCSS("font-size", "14px");
        await pasteCard.getByRole("button", { expanded: true }).click();
      }
      expect(await card.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
        await bubble.evaluate((el) => getComputedStyle(el).backgroundColor),
      );
      await expect(sent.locator("mark")).toHaveText("FATCOINUSDT");
      await expect(card.getByRole("button", { expanded: false })).toBeVisible();
      await card.getByRole("button", { expanded: false }).click();
      await expect(card.getByRole("table")).toBeVisible();
      expect(
        await card.locator(".paste-card-preview").evaluate((el) => el.clientHeight),
      ).toBeLessThanOrEqual(240);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      expect(overflow).toBe(false);
      await page.screenshot({ path: info.outputPath(`pasted-${theme}-${width}.png`) });
      const composer = page.locator(".composer-box");
      await composer.locator("textarea").focus();
      const focusedShadow = await composer.evaluate((el) => getComputedStyle(el).boxShadow);
      const editableCard = page.locator(".composer .paste-card");
      await editableCard.getByRole("button", { expanded: false }).click();
      await editableCard.getByRole("button", { name: "Редактировать вставленный текст" }).click();
      const source = editableCard.getByRole("textbox");
      await source.click();
      await expect(source).toHaveCSS("box-shadow", "none");
      await expect(source).toHaveCSS("outline-style", "none");
      await expect(editableCard).toHaveCSS("box-shadow", focusedShadow);
      await expect(composer).not.toHaveCSS("box-shadow", focusedShadow);
      await page.emulateMedia({ forcedColors: "active" });
      await expect(source).toHaveCSS("outline-style", "none");
      await expect(editableCard).toHaveCSS("outline-style", "solid");
    });
  }

test("paste events survive typing, undo, draft reload, send and queue editing", async ({
  page,
}) => {
  const fixture = await setup(page, "light");
  const field = page.getByRole("textbox", { name: "Сообщение для Codex" });
  await field.fill("Проверь ");
  await paste(field, "FATCOINUSDT");
  await expect(field).toHaveValue("Проверь FATCOINUSDT");
  await field.press("End");
  await field.pressSequentially(" и ");
  await paste(field, "HOOKRUSDT");
  await expect(page.locator(".composer mark")).toHaveCount(2);
  await paste(field, pasteBlocks[0]!.text);
  await expect(page.locator(".composer .paste-card")).toHaveCount(1);
  await field.press("ControlOrMeta+z");
  await expect(page.locator(".composer .paste-card")).toHaveCount(0);
  await field.press("ControlOrMeta+Shift+z");
  await expect(page.locator(".composer .paste-card")).toHaveCount(1);
  await expect.poll(() => fixture.draft()?.pasteBlocks?.length).toBe(1);
  await page.reload();
  await expect(field).toHaveValue("Проверь FATCOINUSDT и HOOKRUSDT");
  await expect(page.locator(".composer .paste-card")).toHaveCount(1);
  await expect(page.locator(".composer mark")).toHaveCount(2);
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect.poll(() => fixture.submitted()?.inlinePastes?.length).toBe(2);
  expect(fixture.submitted()?.pasteBlocks?.[0]?.text).toBe(pasteBlocks[0]!.text);
  await expect(field).toHaveValue("");
  await page.reload();
  const queued = page.locator(".queued-message");
  await expect(queued.locator(".paste-card")).toHaveCount(1);
  await queued.getByRole("button", { name: "Изменить сообщение в очереди" }).click();
  const queueField = queued.getByRole("textbox", { name: "Текст сообщения в очереди" });
  await queueField.press("End");
  await paste(queueField, " plus");
  await expect(queued.locator("mark")).toHaveCount(3);
});

test("a pasted SSH repository address never becomes an email link", async ({ page }) => {
  const address = "git@github.com:petrovichest/3d_cad_models.git";
  const fixture = await setup(page, "light");
  const field = page.getByRole("textbox", { name: "Сообщение для Codex" });
  await field.fill("Клонируй ");
  await paste(field, address);
  await expect(page.locator(".composer mark")).toHaveText(address);
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect.poll(() => fixture.submitted()?.input).toBe(`Клонируй ${address}`);
  await page.reload();
  const queued = page.locator(".queued-message-text");
  await expect(queued).toHaveText(`Клонируй ${address}`);
  await expect(queued.locator("a")).toHaveCount(0);
  expect((await queued.locator("mark").allTextContents()).join("")).toBe(address);
});
