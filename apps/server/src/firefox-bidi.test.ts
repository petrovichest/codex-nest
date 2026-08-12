import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserCaptureStore } from "./browser-capture-store";
import { FirefoxBidiClient } from "./firefox-bidi";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("FirefoxBidiClient", () => {
  it("maps a marked tab, performs BiDi automation, and stores raw console/network events", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-firefox-bidi-"));
    directories.push(directory);
    const captures = new BrowserCaptureStore(join(directory, "state.json"));
    const socket = new FakeBidiSocket();
    const client = new FirefoxBidiClient({
      captures,
      createSocket: () => socket as unknown as WebSocket,
      commandTimeoutMs: 1_000,
    });

    expect(
      await client.execute({
        bindingId: "binding-firefox",
        threadId: "thread-firefox",
        tabId: 9,
        operation: "attach",
        arguments: { marker: "one-shot" },
      }),
    ).toEqual({ context: "context-1" });
    await client.execute({
      bindingId: "binding-firefox",
      threadId: "thread-firefox",
      tabId: 9,
      operation: "input",
      arguments: {
        method: "Input.dispatchMouseEvent",
        parameters: { type: "mouseMoved", x: 10, y: 20 },
      },
    });
    expect(socket.methods).toContain("input.performActions");
    expect(
      socket.commands.find((command) => command.method === "input.performActions")?.params,
    ).toMatchObject({
      context: "context-1",
      actions: [{ type: "pointer", actions: [{ type: "pointerMove", x: 10, y: 20 }] }],
    });

    expect(
      await client.execute({
        bindingId: "binding-firefox",
        threadId: "thread-firefox",
        tabId: 9,
        operation: "screenshot",
        arguments: {
          method: "Page.captureScreenshot",
          parameters: { format: "jpeg", quality: 65 },
        },
      }),
    ).toEqual({ data: "screenshot", mimeType: "image/jpeg" });
    expect(
      socket.commands.find((command) => command.method === "browsingContext.captureScreenshot")
        ?.params,
    ).toMatchObject({ format: { type: "image/jpeg", quality: 0.65 } });

    expect(
      await client.execute({
        bindingId: "binding-firefox",
        threadId: "thread-firefox",
        tabId: 9,
        operation: "evaluate",
        arguments: {
          method: "Runtime.evaluate",
          parameters: { expression: "6 * 7", awaitPromise: true },
        },
      }),
    ).toEqual({ result: { type: "number", value: 42 } });

    socket.event("log.entryAdded", {
      source: { context: "context-1", realm: "realm-1" },
      timestamp: 5,
      level: "info",
      text: "hello",
      providerExtra: { preserved: true },
    });
    const consoleResult = await client.execute({
      bindingId: "binding-firefox",
      threadId: "thread-firefox",
      tabId: 9,
      operation: "console",
      arguments: { method: "Runtime.readConsole", parameters: {} },
    });
    expect(consoleResult).toEqual([{ id: 1, at: 5, level: "info", text: "hello" }]);

    socket.event("network.beforeRequestSent", {
      context: "context-1",
      redirectCount: 0,
      timestamp: 10,
      initiator: { type: "script", extra: true },
      request: {
        request: "request-1",
        url: "https://example.test/data",
        method: "GET",
        headers: [],
        bodySize: null,
      },
      providerOnly: { preserved: true },
    });
    socket.event("network.responseCompleted", {
      context: "context-1",
      redirectCount: 0,
      timestamp: 20,
      request: {
        request: "request-1",
        url: "https://example.test/data",
        method: "GET",
        headers: [],
      },
      response: {
        url: "https://example.test/data",
        status: 200,
        statusText: "OK",
        headers: [],
        protocol: "h2",
        fromCache: false,
        bodySize: 0,
        content: { size: 0 },
      },
      responseExtra: { preserved: true },
    });

    const listed = await pollCapture(captures);
    expect(listed.requests[0]).toMatchObject({
      exchangeId: "request-1:0",
      metadata: { provider: "firefox" },
    });
    expect(await captures.get("binding-firefox", "request-1:0")).toMatchObject({
      metadata: {
        rawEvents: [
          { params: { providerOnly: { preserved: true } } },
          { params: { responseExtra: { preserved: true } } },
        ],
      },
    });
    expect(socket.methods.filter((method) => method === "network.getData")).toHaveLength(1);

    await client.close();
  });

  it("drops the whole exchange when a reported body is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-firefox-bidi-"));
    directories.push(directory);
    const captures = new BrowserCaptureStore(join(directory, "state.json"));
    const socket = new FakeBidiSocket({ response: "" });
    const client = new FirefoxBidiClient({
      captures,
      createSocket: () => socket as unknown as WebSocket,
      commandTimeoutMs: 1_000,
    });
    await client.execute({
      bindingId: "binding-firefox",
      threadId: "thread-firefox",
      tabId: 9,
      operation: "attach",
      arguments: { marker: "one-shot" },
    });
    socket.event("network.beforeRequestSent", {
      context: "context-1",
      redirectCount: 0,
      timestamp: 10,
      request: {
        request: "request-missing-body",
        url: "https://example.test/data",
        method: "POST",
        headers: [],
        bodySize: 3,
      },
    });
    socket.event("network.responseCompleted", {
      context: "context-1",
      redirectCount: 0,
      timestamp: 20,
      request: { request: "request-missing-body" },
      response: {
        url: "https://example.test/data",
        status: 200,
        statusText: "OK",
        headers: [],
        bodySize: 0,
        content: { size: 0 },
      },
    });

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const listed = await captures.list("binding-firefox", { limit: 10 });
      if (listed.stats.dropped === 1) {
        expect(listed.requests).toEqual([]);
        await client.close();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await client.close();
    throw new Error("Timed out waiting for the incomplete capture to be dropped");
  });

  it("drops redirects whose response body Firefox cannot expose", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-firefox-bidi-"));
    directories.push(directory);
    const captures = new BrowserCaptureStore(join(directory, "state.json"));
    const socket = new FakeBidiSocket();
    const client = new FirefoxBidiClient({
      captures,
      createSocket: () => socket as unknown as WebSocket,
      commandTimeoutMs: 1_000,
    });
    await client.execute({
      bindingId: "binding-firefox",
      threadId: "thread-firefox",
      tabId: 9,
      operation: "attach",
      arguments: { marker: "one-shot" },
    });
    socket.event("network.beforeRequestSent", {
      context: "context-1",
      redirectCount: 0,
      request: {
        request: "request-redirect",
        url: "https://example.test/old",
        method: "GET",
        headers: [],
        bodySize: null,
      },
    });
    socket.event("network.responseCompleted", {
      context: "context-1",
      redirectCount: 0,
      request: { request: "request-redirect" },
      response: {
        url: "https://example.test/old",
        status: 302,
        statusText: "Found",
        headers: [],
        bodySize: 5,
        content: { size: 5 },
      },
    });

    await vi.waitFor(async () => {
      const listed = await captures.list("binding-firefox", { limit: 10 });
      expect(listed).toMatchObject({ requests: [], stats: { dropped: 1 } });
    });
    expect(socket.methods).not.toContain("network.getData");
    await client.close();
  });
});

class FakeBidiSocket extends EventEmitter {
  readyState = 0;
  methods: string[] = [];
  commands: Array<{ method: string; params: Record<string, unknown> }> = [];

  constructor(
    private readonly networkData: Partial<Record<"request" | "response", string>> = {
      response: "",
    },
  ) {
    super();
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open");
    });
  }

  send(data: string, callback?: (error?: Error) => void): void {
    const command = JSON.parse(data) as {
      id: number;
      method: string;
      params: Record<string, unknown>;
    };
    this.methods.push(command.method);
    this.commands.push({ method: command.method, params: command.params });
    queueMicrotask(() => {
      if (command.method === "network.getData") {
        const dataType = command.params.dataType;
        const value =
          dataType === "request" || dataType === "response"
            ? this.networkData[dataType]
            : undefined;
        if (value !== undefined) {
          this.emit(
            "message",
            Buffer.from(
              JSON.stringify({
                id: command.id,
                type: "success",
                result: { bytes: { type: "base64", value } },
              }),
            ),
          );
          return;
        }
        this.emit(
          "message",
          Buffer.from(
            JSON.stringify({
              id: command.id,
              type: "error",
              error: "no such network data",
              message: "No body was collected",
            }),
          ),
        );
        return;
      }
      let result: unknown = {};
      if (command.method === "network.addDataCollector") result = { collector: "collector-1" };
      if (command.method === "browsingContext.getTree") {
        result = { contexts: [{ context: "context-1", children: [] }] };
      }
      if (command.method === "script.evaluate") {
        result = String(command.params.expression).includes("data-codexnest-bidi-marker")
          ? { result: { type: "boolean", value: true } }
          : { type: "success", result: { type: "number", value: 42 }, realm: "realm-1" };
      }
      if (command.method === "browsingContext.captureScreenshot") {
        result = { data: "screenshot" };
      }
      this.emit(
        "message",
        Buffer.from(JSON.stringify({ id: command.id, type: "success", result })),
      );
    });
    callback?.();
  }

  event(method: string, params: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify({ type: "event", method, params })));
  }

  close(): void {
    this.readyState = 3;
    this.emit("close");
  }

  terminate(): void {
    this.close();
  }
}

async function pollCapture(captures: BrowserCaptureStore) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const listed = await captures.list("binding-firefox", { limit: 10 });
    if (listed.requests.length) return listed;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for Firefox network capture");
}
