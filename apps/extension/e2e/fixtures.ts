import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test as base, type BrowserContext } from "@playwright/test";
import type { BrowserExtensionClientFrame } from "@codexnest/protocol";
import { WebSocketServer } from "ws";

interface BrowserServerFixture {
  baseUrl: string;
  clientFrames: BrowserExtensionClientFrame[];
}

interface ExtensionFixtures {
  browserServer: BrowserServerFixture;
  context: BrowserContext;
  extensionId: string;
}

export const test = base.extend<ExtensionFixtures>({
  // Playwright fixture callbacks require an object-destructured first argument.
  // eslint-disable-next-line no-empty-pattern
  browserServer: async ({}, use) => {
    const clientFrames: BrowserExtensionClientFrame[] = [];
    const server = createServer();
    const webSockets = new WebSocketServer({
      server,
      path: "/api/v1/browser-extension/events",
      maxPayload: 64 * 1024,
    });
    webSockets.on("connection", (socket) => {
      let toolSent = false;
      socket.on("message", (message) => {
        const frame = JSON.parse(message.toString()) as BrowserExtensionClientFrame;
        clientFrames.push(frame);
        if (frame.type === "client.hello") {
          socket.send(
            JSON.stringify({
              type: "server.hello",
              protocol: "codexnest.browser",
              version: 1,
              locale: "en",
              projects: [{ id: "project-1", displayName: "E2E Project", path: "/work" }],
              threads: [],
            }),
          );
        } else if (frame.type === "session.request") {
          socket.send(
            JSON.stringify({
              type: "session.result",
              requestId: frame.requestId,
              action: "created",
              thread: {
                id: "thread-1",
                projectId: "project-1",
                title: "Browser E2E",
                state: "idle",
              },
            }),
          );
        } else if (frame.type === "binding.updated" && !toolSent) {
          toolSent = true;
          socket.send(
            JSON.stringify({
              type: "tool.call",
              requestId: "tool-1",
              threadId: frame.binding.threadId,
              tool: "javascript_tool",
              arguments: { tabId: frame.binding.tabIds[0], code: "document.title" },
            }),
          );
        }
      });
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Mock browser server did not bind");
    try {
      await use({ baseUrl: `http://127.0.0.1:${address.port}`, clientFrames });
    } finally {
      for (const client of webSockets.clients) client.terminate();
      await new Promise<void>((resolveClose) => webSockets.close(() => resolveClose()));
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      );
    }
  },
  context: async ({ playwright }, use) => {
    const profile = await mkdtemp(join(tmpdir(), "codexnest-extension-"));
    const extensionPath = resolve(import.meta.dirname, "../dist");
    const context = await playwright.chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    try {
      await use(context);
    } finally {
      await context.close();
      await rm(profile, { recursive: true, force: true });
    }
  },
  extensionId: async ({ context }, use) => {
    let worker = context.serviceWorkers()[0];
    worker ??= await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    await use(extensionId);
  },
});

export { expect };
