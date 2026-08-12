import { BROWSER_EXTENSION_ID } from "@codexnest/protocol";

import { expect, test } from "./fixtures";

test("loads and controls Chrome through the stable MV3 extension", async ({
  browserServer,
  context,
  extensionId,
}) => {
  const { clientFrames } = browserServer;
  await context.route("http://browser.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>CodexNest E2E</title><main>Browser target</main>",
    }),
  );
  const target = await context.newPage();
  await target.goto("http://browser.test/");
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  await expect(page.getByText("CodexNest", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /Connect this Chrome|Подключить Chrome/ }),
  ).toBeVisible();
  await expect(page.locator("#base-url")).toBeVisible();
  await expect(page.locator("#owner-token")).toHaveAttribute("type", "password");

  const manifest = await page.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.minimum_chrome_version).toBe("116");
  expect(extensionId).toBe(BROWSER_EXTENSION_ID);

  await page.locator("#base-url").fill(browserServer.baseUrl);
  await page.locator("#owner-token").fill("owner-token");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(page.locator('select optgroup[label="E2E Project"]')).toHaveCount(1);
  await expect
    .poll(() => clientFrames.find((frame) => frame.type === "client.hello"))
    .toMatchObject({
      type: "client.hello",
      token: "owner-token",
      instanceId: expect.any(String),
    });

  const attachResponse = await page.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const targetTab = tabs.find((tab) => tab.url === "http://browser.test/");
    if (targetTab?.id === undefined) throw new Error("E2E target tab is unavailable");
    return chrome.runtime.sendMessage({
      type: "popup.createAttach",
      target: { kind: "new", projectId: "project-1" },
      tabId: targetTab.id,
    });
  });
  expect(attachResponse).toMatchObject({ ok: true });
  await expect
    .poll(() => {
      const result = clientFrames.find(
        (frame) => frame.type === "tool.result" && frame.requestId === "tool-1",
      );
      return result?.type === "tool.result" ? result.result : null;
    })
    .toMatchObject({ value: "CodexNest E2E" });
  await expect(page.getByText("Browser E2E", { exact: true })).toBeVisible();
  await page.locator(".binding-card .danger-button").click();
  await expect
    .poll(() => clientFrames.some((frame) => frame.type === "binding.detached"))
    .toBe(true);

  const targetGroupId = await page.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url === "http://browser.test/")?.groupId;
  });
  expect(targetGroupId).toBe(-1);
});
