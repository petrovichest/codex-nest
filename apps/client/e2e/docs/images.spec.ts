import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { DESKTOP_VIEWPORT, PHONE_VIEWPORT, waitForVisualReady } from "../visual/fixtures";
import { installDocsFixture } from "./fixtures";

const root = resolve(import.meta.dirname, "../../../..");
const assets = resolve(root, "docs/assets");

test("capture the documentation gallery", async ({ browser }) => {
  await mkdir(assets, { recursive: true });
  const failures: string[] = [];

  async function screen(
    name: string,
    theme: "light" | "dark",
    mobile: boolean,
    thread: string,
    prepare?: (page: Page) => Promise<void>,
  ) {
    const page = await browser.newPage({
      viewport: mobile ? PHONE_VIEWPORT : DESKTOP_VIEWPORT,
      locale: "en-US",
      timezoneId: "UTC",
      deviceScaleFactor: 1,
      serviceWorkers: "block",
    });
    page.on("pageerror", (error) => failures.push(error.message));
    page.on("response", (response) => {
      if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
    });
    // A missed mock must never reach an owner's server or an external service.
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === "http://127.0.0.1:4173" && !url.pathname.startsWith("/api")) {
        return route.continue();
      }
      failures.push(`Unexpected request: ${url.origin}${url.pathname}`);
      return route.abort();
    });
    await installDocsFixture(
      page,
      theme,
      name === "desktop-activity"
        ? "activity"
        : name === "desktop-answers"
          ? "answers"
          : "conversation",
    );
    await page.goto(`http://127.0.0.1:4173/threads/${thread}`);
    await expect(
      page.getByRole("heading", { name: /Add project search|Choose search behavior/ }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Show details", exact: true })).toBeVisible();
    if (prepare) await prepare(page);
    await waitForVisualReady(page);
    const text = await page.locator("body").innerText();
    expect(text).not.toMatch(/[\u0400-\u04ff]/u);
    expect(text).not.toMatch(/Loading…|Failed to|visual-test-token|\/home\/hon/u);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.mouse.move(0, 0);
    await page.screenshot({
      path: resolve(assets, `${name}.png`),
      animations: "disabled",
      caret: "hide",
    });
    await page.close();
  }

  await screen("desktop-session", "dark", false, "session-main");
  await screen("desktop-queue", "light", false, "session-attention", async (page) => {
    await expect(page.getByText("Also check the empty state on a narrow screen.")).toBeVisible();
  });
  await screen("desktop-answers", "light", false, "session-main", async (page) => {
    const answers = page.locator(".user-input-response");
    await expect(answers.locator("section")).toHaveCount(2);
    await expect(answers).toContainText("When should the project list update");
    await expect(answers).not.toContainText("(Recommended)");
  });
  await screen("desktop-activity", "dark", false, "session-main", async (page) => {
    await page.locator(".turn-activity-toggle").click();
    await page.locator(".activity-card > summary").filter({ hasText: "npm test" }).click();
    await page
      .locator(".activity-card > summary")
      .filter({ hasText: "src/project-search.ts" })
      .click();
    await expect(page.getByText("Tests: 12 passed, 12 total", { exact: false })).toBeVisible();
    await page.locator(".turn-activity-disclosure").scrollIntoViewIfNeeded();
  });
  await screen("mobile-session", "light", true, "session-main");
  await screen("mobile-sessions", "light", true, "session-main", async (page) => {
    await page.getByRole("button", { name: "Open task list", exact: true }).click();
    const sidebar = page.locator(".sidebar.open");
    await expect(sidebar).toBeVisible();
    await expect(sidebar.locator('a[href="/threads/session-main"]')).toHaveClass(/\bactive\b/u);
    await expect(sidebar.locator('a[href="/threads/session-active"]')).toBeVisible();
    await expect(sidebar.locator('a[href="/threads/session-complete"]')).toBeVisible();
  });
  await screen("mobile-question", "dark", true, "session-attention", async (page) => {
    await expect(page.getByText("When should the project list update?")).toBeVisible();
  });
  await screen("mobile-report", "dark", true, "session-main", async (page) => {
    await page.getByRole("button", { name: "Show details", exact: true }).click();
    const inspector = page.getByRole("complementary", { name: "Task details" });
    await inspector.getByRole("tab", { name: /^Artifacts/u }).click();
    await inspector.getByRole("button", { name: "Open project-search.md" }).click();
    await expect(page.getByRole("heading", { name: "Project search", exact: true })).toBeVisible();
  });
  expect(failures).toEqual([]);
});

test("render the architecture infographics and covers", async ({ browser }) => {
  await mkdir(assets, { recursive: true });
  const replacements: Record<string, string> = {
    FONT: `data:font/woff2;base64,${(await readFile(resolve(root, "apps/client/src/assets/fonts/onest-variable.woff2"))).toString("base64")}`,
    LOGO: `data:image/svg+xml;base64,${(await readFile(resolve(root, "apps/client/public/favicon.svg"))).toString("base64")}`,
    DESKTOP: `data:image/png;base64,${(await readFile(resolve(assets, "desktop-session.png"))).toString("base64")}`,
    MOBILE: `data:image/png;base64,${(await readFile(resolve(assets, "mobile-session.png"))).toString("base64")}`,
    ILLUSTRATION: `data:image/png;base64,${(await readFile(resolve(root, "docs/media/architecture-illustration.png"))).toString("base64")}`,
  };
  const translations: Record<string, Record<string, string>> = {
    en: {
      LANG: "en",
      TITLE: "How it works",
      HEADLINE: "One ChatGPT account.<br />All your devices.",
      SUBTITLE: "Shared projects, conversations and progress.",
      ILLUSTRATION_ALT: "Four thin clients connected to one headless Linux host",
      LAPTOP: "Laptop · browser",
      TABLET: "Tablet · browser",
      PHONE: "Phone · browser",
      ACCOUNT: "ChatGPT signed in on this host",
      UNLIMITED: "As many of your devices as you need",
      NETWORK: "private VPN or trusted LAN",
      CLIENTS: "Clients only need the APK or a browser.",
      SERVER: "Codex, project files and development tools stay on the server.",
    },
    ru: {
      LANG: "ru",
      TITLE: "Как это работает",
      HEADLINE: "Один аккаунт ChatGPT.<br />Все ваши устройства.",
      SUBTITLE: "Общие проекты, диалоги и состояние работы.",
      ILLUSTRATION_ALT: "Четыре тонких клиента подключены к одному headless Linux-серверу",
      LAPTOP: "Ноутбук · браузер",
      TABLET: "Планшет · браузер",
      PHONE: "Телефон · браузер",
      ACCOUNT: "Вход в ChatGPT выполнен на сервере",
      UNLIMITED: "Любое число ваших устройств",
      NETWORK: "приватная VPN или доверенная LAN",
      CLIENTS: "На клиентах — только APK или браузер.",
      SERVER: "Codex, файлы проектов и инструменты — на сервере.",
    },
  };
  for (const [name, templateName, language, width, height] of [
    ["how-it-works", "how-it-works", "en", 1200, 880],
    ["how-it-works-ru", "how-it-works", "ru", 1200, 880],
    ["cover", "cover", "en", 1600, 900],
    ["architecture-cover", "architecture-cover", "en", 1600, 900],
    ["social-preview", "architecture-cover", "en", 1280, 640],
  ] as const) {
    const template = await readFile(resolve(root, `docs/media/${templateName}.html`), "utf8");
    const values = { ...replacements, ...translations[language] };
    const html = template.replace(/\{\{(\w+)\}\}/gu, (_, key: string) => {
      if (!(key in values)) throw new Error(`Missing media template value: ${key}`);
      return values[key]!;
    });
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.route("**/*", (route) => route.abort());
    await page.setContent(html);
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map((image) => image.decode()));
    });
    expect(await page.evaluate(() => document.fonts.check("21px Onest"))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const image = await page.screenshot({ path: resolve(assets, `${name}.png`) });
    if (name === "social-preview") expect(image.byteLength).toBeLessThan(1_000_000);
    await page.close();
  }
});
