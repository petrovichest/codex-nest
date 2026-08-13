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
  await page.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const target = tabs.find((tab) => tab.url === "http://browser.test/");
    if (target?.id === undefined) throw new Error("E2E target tab is unavailable");
    await chrome.tabs.update(target.id, { active: true });
  });
  browserServer.sendServerFrame({
    type: "catalog.updated",
    projects: [{ id: "project-1", displayName: "E2E Project", path: "/work" }],
    threads: [
      {
        id: "thread-existing",
        projectId: "project-1",
        title: "Enabled Browser Session",
        state: "idle",
      },
    ],
  });
  await expect(page.locator('select optgroup[label="E2E Project"]')).toHaveCount(1);
  await expect(page.locator('option[value^="new:"]')).toHaveCount(0);
  await expect(page.getByRole("option", { name: "New session" })).toHaveCount(0);
  await expect(page.getByRole("option", { name: /^Existing/ })).toHaveCount(0);
  await expect(page.locator("select")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Attach current tab" })).toBeDisabled();
  await expect
    .poll(() => clientFrames.find((frame) => frame.type === "client.hello"))
    .toMatchObject({
      type: "client.hello",
      token: "owner-token",
      instanceId: expect.any(String),
    });

  await page.locator("select").selectOption("thread-existing");
  await page.getByRole("button", { name: "Attach current tab" }).click();
  await expect
    .poll(() => clientFrames.find((frame) => frame.type === "session.request")?.target)
    .toEqual({ kind: "existing", threadId: "thread-existing" });
  expect(
    clientFrames.some((frame) => frame.type === "session.request" && frame.target.kind === "new"),
  ).toBe(false);
  await expect
    .poll(() => {
      const result = clientFrames.find(
        (frame) => frame.type === "tool.result" && frame.requestId === "tool-1",
      );
      return result?.type === "tool.result" ? result.result : null;
    })
    .toMatchObject({ value: "CodexNest E2E" });
  await expect(page.getByText("Attached", { exact: true })).toBeVisible();
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

test("keeps the session select stable across background catalog updates", async ({
  browserServer,
  context,
  extensionId,
}) => {
  await context.route("http://dropdown.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Dropdown target</title><main>Browser target</main>",
    }),
  );
  const targetPage = await context.newPage();
  await targetPage.goto("http://dropdown.test/");
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  await page.locator("#base-url").fill(browserServer.baseUrl);
  await page.locator("#owner-token").fill("owner-token");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();

  await page.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const target = tabs.find((tab) => tab.url === "http://dropdown.test/");
    if (target?.id === undefined) throw new Error("Dropdown target tab is unavailable");
    await chrome.tabs.update(target.id, { active: true });
  });
  browserServer.sendServerFrame({
    type: "catalog.updated",
    projects: [{ id: "project-1", displayName: "E2E Project", path: "/work" }],
    threads: [],
  });
  await expect(
    page.getByText("Enable Browser in a CodexNest session to attach this tab.", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("select optgroup")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Attach current tab" })).toBeDisabled();

  browserServer.sendServerFrame({
    type: "catalog.updated",
    projects: [
      { id: "project-1", displayName: "E2E Project", path: "/work" },
      { id: "project-empty", displayName: "Empty Project", path: "/empty" },
    ],
    threads: [
      {
        id: "thread-existing",
        projectId: "project-1",
        title: "Enabled Browser Session",
        state: "idle",
      },
      {
        id: "thread-before-focus",
        projectId: "project-1",
        title: "Before Focus",
        state: "idle",
      },
      {
        id: "thread-busy",
        projectId: "project-1",
        title: "Busy Session",
        state: "needsAttention",
      },
    ],
  });
  await expect(page.locator('option[value="thread-before-focus"]')).toHaveCount(1);
  await expect(page.locator('optgroup[label="Empty Project"]')).toHaveCount(0);
  await expect(page.locator('option[value="thread-busy"]')).toHaveAttribute("disabled", "");
  await expect(page.locator('option[value="thread-busy"]')).toHaveText("Busy Session — Busy");
  await expect(page.locator('option[value^="new:"]')).toHaveCount(0);

  await page.evaluate(() => {
    Object.assign(window, { stateChangeCount: 0 });
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type !== "background.stateChanged") return;
      Object.assign(window, {
        stateChangeCount:
          ((window as Window & { stateChangeCount?: number }).stateChangeCount ?? 0) + 1,
      });
    });
  });
  const select = page.locator("select");
  const originalSelect = await select.elementHandle();
  if (!originalSelect) throw new Error("Session select is unavailable");
  await select.selectOption("thread-existing");
  await expect(page.getByRole("button", { name: "Attach current tab" })).toBeEnabled();
  await select.focus();
  await expect(select).toBeFocused();

  browserServer.sendServerFrame({
    type: "catalog.updated",
    projects: [{ id: "project-1", displayName: "E2E Project", path: "/work" }],
    threads: [
      {
        id: "thread-existing",
        projectId: "project-1",
        title: "Enabled Browser Session",
        state: "idle",
      },
      {
        id: "thread-background",
        projectId: "project-1",
        title: "Background Update",
        state: "idle",
      },
    ],
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as Window & { stateChangeCount?: number }).stateChangeCount ?? 0),
    )
    .toBeGreaterThan(0);
  expect(
    await page.evaluate((node) => node === document.querySelector("select"), originalSelect),
  ).toBe(true);
  await expect(select).toBeFocused();
  await expect(select).toHaveValue("thread-existing");

  await page.getByRole("button", { name: "Attach current tab" }).click();
  await expect
    .poll(
      () => browserServer.clientFrames.find((frame) => frame.type === "session.request")?.target,
    )
    .toEqual({ kind: "existing", threadId: "thread-existing" });
  await expect(page.getByText("Attached", { exact: true })).toBeVisible();
});

test("keeps the panel open and follows the active tab", async ({
  browserServer,
  context,
  extensionId,
}) => {
  await context.route("http://panel-first.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Panel first</title><main>First target</main>",
    }),
  );
  await context.route("http://panel-second.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Panel second</title><main>Second target</main>",
    }),
  );
  const first = await context.newPage();
  await first.goto("http://panel-first.test/");
  const second = await context.newPage();
  await second.goto("http://panel-second.test/");
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/panel.html`);

  await panel.locator("#base-url").fill(browserServer.baseUrl);
  await panel.locator("#owner-token").fill("owner-token");
  await panel.getByRole("button", { name: "Connect" }).click();
  await expect(panel.getByText("Connected", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Open side panel" })).toHaveCount(0);

  await panel.evaluate(async () => {
    const tab = (await chrome.tabs.query({})).find((candidate) =>
      candidate.url?.startsWith("http://panel-first.test/"),
    );
    if (tab?.id === undefined) throw new Error("First panel target is unavailable");
    await chrome.tabs.update(tab.id, { active: true });
  });
  await expect(panel.getByText("Panel first", { exact: true })).toBeVisible();

  await panel.evaluate(async () => {
    const tab = (await chrome.tabs.query({})).find((candidate) =>
      candidate.url?.startsWith("http://panel-second.test/"),
    );
    if (tab?.id === undefined) throw new Error("Second panel target is unavailable");
    await chrome.tabs.update(tab.id, { active: true });
  });
  await expect(panel.getByText("Panel second", { exact: true })).toBeVisible();
  await expect(panel.getByText("Panel first", { exact: true })).toHaveCount(0);
});
