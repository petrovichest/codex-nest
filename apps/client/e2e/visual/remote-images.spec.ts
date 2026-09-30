import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import type { ThreadDetail } from "@codexnest/protocol";
import { buildApp } from "../../../server/src/app";
import { AttentionManager } from "../../../server/src/attention";
import { CodexBridge } from "../../../server/src/codex/bridge";
import { loadConfig } from "../../../server/src/config";
import { AppProjection } from "../../../server/src/projection";
import { StateStore } from "../../../server/src/state/store";
import { installVisualFixture, snapshot } from "./fixtures";

const github = "https://github.com/pump-fun/pump-public-docs/blob/main/docs/fees.png";
const raw = "https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/docs/fees.png";
const remote = "https://image.test/chart.png";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lLkAAAAASUVORK5CYII=",
  "base64",
);
const cors = { "access-control-allow-origin": "*" };
let app: Awaited<ReturnType<typeof buildApp>>;
let directory: string;

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "codexnest-remote-images-"));
  const store = new StateStore(join(directory, "state.json"));
  await store.load();
  const bridge = new CodexBridge({
    codexBin: "unused",
    spawnProcess() {
      throw new Error("The image test must not start Codex");
    },
  });
  const attention = new AttentionManager();
  const projection = new AppProjection(bridge, store, attention);
  app = await buildApp(
    loadConfig({
      statePath: store.path,
      databasePath: store.databasePath,
      clientDist: resolve(import.meta.dirname, "../../dist"),
    }),
    { bridge, store, projection, attention, projectRoot: directory },
  );
});

test.afterAll(async () => {
  await app?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

// Build the client before running: exercise Fastify's actual static responses and CSP, not Vite's.
for (const width of [390, 1440]) {
  test(`remote image links load, retry and download under server CSP at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const seed = structuredClone(snapshot);
    seed.attention = [];
    const summary = seed.threads.find((thread) => thread.id === "session-main")!;
    summary.settings.collaborationMode = "default";
    summary.browserStatus = "disabled";
    const detail: ThreadDetail = {
      summary,
      queuedMessages: [],
      olderTurnsCursor: null,
      draft: null,
      turns: [
        {
          id: "images",
          status: "completed",
          startedAt: summary.updatedAt - 1000,
          completedAt: summary.updatedAt,
          durationMs: 1000,
          items: [
            {
              type: "agentMessage",
              id: "image-message",
              text: `[Таблица комиссий Pump](${github})\n\n[Открыть саму таблицу](${raw})\n\n![График](${remote})\n\n[Локальное изображение](/work/local.png)`,
              images: [],
              status: "completed",
              timestamp: summary.updatedAt,
              phase: "final_answer",
            },
          ],
        },
      ],
    };
    await installVisualFixture(page, {
      theme: "light",
      snapshot: seed,
      reducedMotion: "no-preference",
    });
    await page.route("http://127.0.0.1:4173/**", async (route) => {
      const url = new URL(route.request().url());
      const response = await app.inject({ url: `${url.pathname}${url.search}` });
      await route.fulfill({
        status: response.statusCode,
        headers: response.headers as Record<string, string>,
        body: response.rawPayload,
      });
    });
    await page.route("**/api/v1/threads/session-main", (route) =>
      route.fulfill({ json: detail, headers: cors }),
    );
    const localRequests: string[] = [];
    await page.route("**/api/v1/threads/session-main/downloads", (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback();
      localRequests.push(route.request().postDataJSON().path);
      return route.fulfill({
        json: {
          downloadUrl: "/downloads/local.png",
          fileName: "local.png",
          size: png.length,
          expiresAt: Date.now() + 60_000,
        },
        headers: cors,
      });
    });
    await page.route("**/downloads/local.png", (route) =>
      route.fulfill({ body: png, contentType: "image/png", headers: cors }),
    );
    await page.route(remote, (route) =>
      route.fulfill({ body: png, contentType: "image/png", headers: cors }),
    );
    let githubRequests = 0;
    await page.route(github, (route) => {
      githubRequests++;
      return route.abort();
    });
    let failTable = true;
    await page.route(raw, (route) => {
      if (failTable) {
        failTable = false;
        return route.fulfill({ status: 503, body: "Unavailable" });
      }
      return route.fulfill({ body: png, contentType: "image/png", headers: cors });
    });
    const response = await page.goto("/threads/session-main");
    expect(response?.status()).toBe(200);
    expect(response?.headers()["content-security-policy"]).toBeTruthy();
    const gallery = page.locator(".message-image-gallery");
    await expect(gallery.locator(".gallery-thumbnail")).toHaveCount(3);
    await expect(gallery.locator(".is-ready")).toHaveCount(2);
    await gallery.getByRole("button", { name: /Таблица комиссий Pump: Не удалось/ }).click();
    await expect(gallery.locator(".is-ready")).toHaveCount(3);
    expect(githubRequests).toBe(0);
    expect(localRequests).toEqual(["/work/local.png"]);
    await expect(gallery.getByAltText("Таблица комиссий Pump")).toHaveAttribute("src", raw);
    await page
      .locator(".message-markdown")
      .getByRole("button", { name: "Открыть изображение Таблица комиссий Pump", exact: true })
      .last()
      .click();
    const viewer = page.getByRole("dialog", { name: "Просмотр изображений" });
    await expect(viewer.getByText("Изображение 1 из 3")).toBeVisible();
    await expect(viewer.getByAltText("Таблица комиссий Pump")).toHaveAttribute("src", raw);
    const downloaded = page.waitForEvent("download");
    await viewer.getByRole("button", { name: "Скачать Таблица комиссий Pump" }).click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe("fees.png");
    expect(await download.failure()).toBeNull();
    expect(await readFile((await download.path())!)).toEqual(png);
    await page.keyboard.press("Escape");
    await page.reload();
    await expect(gallery.locator(".gallery-thumbnail")).toHaveCount(3);
    await expect(gallery.locator(".is-ready")).toHaveCount(3);
    expect(githubRequests).toBe(0);
  });
}
