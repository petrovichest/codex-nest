import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import websocket from "@fastify/websocket";
import Fastify from "fastify";
import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BROWSER_EXTENSION_ORIGIN,
  BROWSER_EXTENSION_PROTOCOL,
  BROWSER_EXTENSION_PROTOCOL_VERSION,
  BROWSER_EXTENSION_WEBSOCKET_PATH,
  BROWSER_TOOL_NAMES,
  type AppSnapshot,
  type BrowserExtensionBindingSummary,
  type BrowserExtensionServerFrame,
  type BrowserThreadStatus,
  type ThreadSummary,
} from "@codexnest/protocol";

import { hashToken } from "./auth";
import { BrowserExtensionError, BrowserExtensionServer } from "./browser-extension";
import type { AppProjection } from "./projection";
import { StateStore } from "./state/store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("browser extension transport", () => {
  it("enforces origin, owner authentication, and the protocol version", async () => {
    const harness = await createHarness();

    const rejectedOrigin = await harness.app.injectWS(BROWSER_EXTENSION_WEBSOCKET_PATH, {
      headers: { origin: "http://rejected" },
    });
    expect(await closeCode(rejectedOrigin)).toBe(1008);

    const rejectedToken = await harness.app.injectWS(BROWSER_EXTENSION_WEBSOCKET_PATH, {
      headers: { origin: "http://allowed" },
    });
    rejectedToken.send(
      JSON.stringify({
        ...helloFrame("extension-instance-1"),
        token: "wrong",
      }),
    );
    expect(await closeCode(rejectedToken)).toBe(1008);

    const rejectedVersion = await harness.app.injectWS(BROWSER_EXTENSION_WEBSOCKET_PATH, {
      headers: { origin: "http://allowed" },
    });
    rejectedVersion.send(
      JSON.stringify({
        ...helloFrame("extension-instance-1"),
        version: BROWSER_EXTENSION_PROTOCOL_VERSION + 1,
      }),
    );
    expect(await closeCode(rejectedVersion)).toBe(1002);

    const acceptedExtensionOrigin = await harness.app.injectWS(BROWSER_EXTENSION_WEBSOCKET_PATH, {
      headers: { origin: BROWSER_EXTENSION_ORIGIN },
    });
    const acceptedFrames = frameReader(acceptedExtensionOrigin);
    acceptedExtensionOrigin.send(JSON.stringify(helloFrame("extension-instance-1")));
    expect((await acceptedFrames.next()).type).toBe("server.hello");
    acceptedExtensionOrigin.close();

    await harness.close();
  });

  it("pushes project and thread catalog changes to connected popups", async () => {
    const harness = await createHarness();
    const extension = await connect(harness.app, "extension-instance-1");
    expect((await extension.nextType("server.hello")).threads).toEqual([]);

    const second = { ...summary("second"), state: "running" } satisfies ThreadSummary;
    harness.projection.summaries.set(second.id, second);
    harness.projection.emit("event", 2, { type: "thread.upserted", thread: second });

    const catalog = await extension.nextType("catalog.updated");
    expect(catalog.threads).toEqual([
      expect.objectContaining({ id: "second", projectId: "project" }),
    ]);
    extension.socket.close();
    await harness.close();
  });

  it("catalogs only active eligible root sessions owned by the extension", async () => {
    const harness = await createHarness();
    const summaries = [
      { ...summary("running"), state: "running" },
      { ...summary("queued"), state: "queued" },
      { ...summary("needs-attention"), state: "needsAttention" },
      { ...summary("completed-unread"), state: "completed", unread: true },
      { ...summary("failed-unread"), state: "failed", unread: true },
      { ...summary("interrupted-unread"), state: "interrupted", unread: true },
      { ...summary("queued-message"), queuedMessageCount: 1 },
      { ...summary("owned-binding"), state: "running" },
      summary("idle"),
      { ...summary("completed-read"), state: "completed" },
      { ...summary("failed-read"), state: "failed" },
      { ...summary("interrupted-read"), state: "interrupted" },
      { ...summary("archived"), state: "running", archived: true },
      {
        ...summary("subagent"),
        state: "running",
        relation: {
          kind: "subagent",
          sessionId: "subagent-session",
          parentThreadId: "running",
          nickname: null,
          role: null,
        },
      },
      { ...summary("managed-parent"), state: "running" },
      { ...summary("foreign-binding"), state: "running" },
      { ...summary("missing-project"), state: "running", projectId: null },
    ] satisfies ThreadSummary[];
    for (const thread of summaries) harness.projection.summaries.set(thread.id, thread);
    await harness.store.update((state) => {
      state.threadMeta["managed-parent"] = {
        pinned: false,
        lastReadUpdatedAt: 0,
        managedParent: { parentThreadId: "parent", taskId: "task" },
      };
      state.threadMeta["foreign-binding"] = {
        pinned: false,
        lastReadUpdatedAt: 0,
        browserBinding: {
          bindingId: "foreign-binding-id",
          instanceId: "extension-instance-2",
          attachedAt: 1,
        },
      };
      state.threadMeta["owned-binding"] = {
        pinned: false,
        lastReadUpdatedAt: 0,
        browserBinding: {
          bindingId: "owned-binding-id",
          instanceId: "extension-instance-1",
          attachedAt: 1,
        },
      };
    });

    const extension = await connect(harness.app, "extension-instance-1");
    const hello = await extension.nextType("server.hello");

    expect(hello.threads.map((thread) => thread.id)).toEqual([
      "running",
      "queued",
      "needs-attention",
      "completed-unread",
      "failed-unread",
      "interrupted-unread",
      "queued-message",
      "owned-binding",
    ]);

    extension.socket.close();
    await harness.close();
  });

  it("creates, attaches, activates, detaches, reconnects, and preserves ownership", async () => {
    const harness = await createHarness();
    const first = await connect(harness.app, "extension-instance-1");
    expect((await first.next()).type).toBe("server.hello");

    first.socket.send(
      JSON.stringify({
        type: "session.request",
        requestId: "create-1",
        target: { kind: "new", projectId: "project" },
        tab: tabSummary(),
      }),
    );
    const created = await first.nextType("session.result");
    expect(created).toMatchObject({ action: "created", thread: { id: "created" } });
    const createdBinding = bindingSummary("created");
    first.socket.send(JSON.stringify({ type: "binding.updated", binding: createdBinding }));
    await vi.waitFor(() => expect(harness.status("created")).toBe("connected"));
    expect(harness.status("created")).toBe("connected");

    first.socket.send(
      JSON.stringify({
        type: "binding.detached",
        binding: createdBinding,
      }),
    );
    await vi.waitFor(() =>
      expect(harness.store.view().threadMeta.created?.browserBinding?.detachedAt).toEqual(
        expect.any(Number),
      ),
    );
    expect(harness.status("created")).toBe("disconnected");

    const other = await connect(harness.app, "extension-instance-2");
    await other.next();
    other.socket.send(
      JSON.stringify({
        type: "session.request",
        requestId: "attach-other",
        target: { kind: "existing", threadId: "created" },
        tab: tabSummary(2),
      }),
    );
    expect(await other.nextType("session.error")).toMatchObject({
      error: { code: "owned_by_another_instance" },
    });

    first.socket.send(
      JSON.stringify({
        type: "session.request",
        requestId: "reattach-owner",
        target: { kind: "existing", threadId: "created" },
        tab: tabSummary(),
      }),
    );
    expect(await first.nextType("session.result")).toMatchObject({ action: "attached" });
    first.socket.send(JSON.stringify({ type: "binding.updated", binding: createdBinding }));
    await vi.waitFor(() => expect(harness.status("created")).toBe("connected"));
    expect(harness.status("created")).toBe("connected");
    expect(harness.store.view().threadMeta.created?.browserBinding?.detachedAt).toBeUndefined();

    await harness.browser.deleteBinding("created");
    expect(harness.store.view().threadMeta.created?.browserBinding).toBeUndefined();
    expect(harness.status("created")).toBe("disabled");

    const replaced = closeCode(first.socket);
    const replacement = await connect(harness.app, "extension-instance-1");
    await replacement.next();
    expect(await replaced).toBe(4000);

    replacement.socket.close();
    other.socket.close();
    await harness.close();
  });

  it("advertises MCP tools, proxies results, and reports unknown outcome after dispatch loss", async () => {
    const harness = await createHarness();
    await harness.store.update((state) => {
      state.threadMeta.thread = {
        pinned: false,
        lastReadUpdatedAt: 0,
        browserBinding: {
          bindingId: "binding-1",
          instanceId: "extension-instance-1",
          attachedAt: Date.now(),
        },
      };
    });
    harness.projection.summaries.set("thread", summary("thread"));
    const extension = await connect(harness.app, "extension-instance-1", [
      bindingSummary("thread"),
    ]);
    await extension.next();

    const denied = await harness.app.inject({
      method: "POST",
      url: "/api/v1/internal/browser-mcp/binding-1",
      headers: { "x-codexnest-browser-secret": "wrong" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(denied.statusCode).toBe(403);

    const initialized = await harness.mcp("binding-1", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: {} },
    });
    expect(initialized.json()).toMatchObject({
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "codexnest-browser" },
      },
    });

    const listed = await harness.mcp("binding-1", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect(listed.json().result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      ...BROWSER_TOOL_NAMES,
    ]);

    const pending = harness.mcp("binding-1", {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "navigate", arguments: { url: "https://example.com" } },
    });
    const call = await extension.nextType("tool.call");
    expect(call).toMatchObject({ tool: "navigate", arguments: { url: "https://example.com" } });
    extension.socket.send(
      JSON.stringify({
        type: "tool.result",
        requestId: call.requestId,
        result: { content: [{ type: "text", text: "navigated" }] },
      }),
    );
    expect((await pending).json()).toMatchObject({
      result: { content: [{ type: "text", text: "navigated" }] },
    });

    const chunked = harness.mcp("binding-1", {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_page_text", arguments: {} },
    });
    const chunkedCall = await extension.nextType("tool.call");
    const chunkedResult = { content: [{ type: "text", text: "x".repeat(100_000) }] };
    const serialized = JSON.stringify(chunkedResult);
    const chunks = serialized.match(/[\s\S]{1,30000}/g) ?? [];
    for (const [chunkIndex, data] of chunks.entries()) {
      extension.socket.send(
        JSON.stringify({
          type: "tool.result.chunk",
          requestId: chunkedCall.requestId,
          chunkIndex,
          chunkCount: chunks.length,
          data,
        }),
      );
    }
    expect((await chunked).json()).toMatchObject({ result: chunkedResult });

    const lost = harness.mcp("binding-1", {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "tabs_create", arguments: {} },
    });
    await extension.nextType("tool.call");
    extension.socket.terminate();
    expect((await lost).json()).toMatchObject({
      result: {
        isError: true,
        content: [{ text: expect.stringContaining("outcome unknown") }],
      },
    });

    await harness.close();
  });

  it("waits only the configured reconnect window before failing an undispatched call", async () => {
    const harness = await createHarness({ disconnectWaitMs: 20 });
    await harness.store.update((state) => {
      state.threadMeta.thread = {
        pinned: false,
        lastReadUpdatedAt: 0,
        browserBinding: {
          bindingId: "binding-offline",
          instanceId: "extension-instance-1",
          attachedAt: Date.now(),
        },
      };
    });
    const response = await harness.mcp("binding-offline", {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "tabs_context", arguments: {} },
    });
    expect(response.json()).toMatchObject({
      result: {
        isError: true,
        content: [{ text: expect.stringContaining("disconnected") }],
      },
    });
    await harness.close();
  });

  it("validates and streams project files without exposing paths to the extension", async () => {
    const harness = await createHarness();
    const project = join(harness.directory, "project");
    await mkdir(project);
    await writeFile(join(project, "inside.txt"), "browser upload");
    await writeFile(join(harness.directory, "outside.txt"), "private");
    await harness.store.update((state) => {
      state.threadMeta.thread = {
        pinned: false,
        lastReadUpdatedAt: 0,
        browserBinding: {
          bindingId: "binding-upload",
          instanceId: "extension-instance-1",
          attachedAt: Date.now(),
        },
      };
    });
    harness.projection.summaries.set("thread", summary("thread", project));
    const extension = await connect(harness.app, "extension-instance-1", [
      bindingSummary("thread"),
    ]);
    await extension.nextType("server.hello");

    const pending = harness.mcp("binding-upload", {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "upload_file", arguments: { ref: "e_1", path: "inside.txt" } },
    });
    const call = await extension.nextType("tool.call");
    expect(call.arguments).toMatchObject({
      ref: "e_1",
      file: {
        kind: "project_file",
        name: "inside.txt",
        mediaType: "text/plain",
        size: 14,
      },
    });
    expect(call.arguments).not.toHaveProperty("path");
    const descriptor = (call.arguments as { file: { transferId: string } }).file;
    extension.socket.send(
      JSON.stringify({ type: "file.request", transferId: descriptor.transferId }),
    );
    const chunk = await extension.nextType("file.transfer");
    expect(Buffer.from(chunk.data, "base64").toString()).toBe("browser upload");
    extension.socket.send(
      JSON.stringify({
        type: "tool.result",
        requestId: call.requestId,
        result: { uploaded: true },
      }),
    );
    expect((await pending).json()).toMatchObject({ result: { content: expect.any(Array) } });

    const escaped = await harness.mcp("binding-upload", {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "upload_file",
        arguments: { ref: "e_1", path: join(harness.directory, "outside.txt") },
      },
    });
    expect(escaped.json()).toMatchObject({
      result: { isError: true, content: [{ text: expect.stringContaining("inside") }] },
    });

    const raced = harness.mcp("binding-upload", {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "upload_file", arguments: { ref: "e_1", path: "inside.txt" } },
    });
    const racedCall = await extension.nextType("tool.call");
    const racedDescriptor = (racedCall.arguments as { file: { transferId: string } }).file;
    await rename(join(project, "inside.txt"), join(project, "inside-original.txt"));
    await symlink(join(harness.directory, "outside.txt"), join(project, "inside.txt"));
    extension.socket.send(
      JSON.stringify({ type: "file.request", transferId: racedDescriptor.transferId }),
    );
    const fileError = await extension.nextType("file.error");
    expect(fileError).toMatchObject({ transferId: racedDescriptor.transferId });
    extension.socket.send(
      JSON.stringify({
        type: "tool.error",
        requestId: racedCall.requestId,
        error: { code: "file_transfer_failed", message: fileError.error },
      }),
    );
    expect((await raced).json()).toMatchObject({ result: { isError: true } });

    extension.socket.close();
    await harness.close();
  });
});

async function createHarness(options: { disconnectWaitMs?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "codexnest-browser-extension-test-"));
  directories.push(directory);
  const store = new StateStore(join(directory, "state.json"));
  await store.load();
  await store.update((state) => {
    state.auth.tokenSha256 = hashToken("correct");
  });
  const app = Fastify({ logger: false });
  await app.register(websocket);
  const projection = new FakeProjection();
  const browser = new BrowserExtensionServer({
    app,
    store,
    projection: projection as unknown as AppProjection,
    allowedOrigins: new Set(["http://allowed"]),
    port: 4310,
    authTimeoutMs: 50,
    heartbeatMs: 10_000,
    disconnectWaitMs: options.disconnectWaitMs,
    internalSecret: "internal-secret",
  });
  browser.setLifecycle({
    create: async (instanceId, _projectId, bindingId) => {
      projection.summaries.set("created", summary("created"));
      await store.update((state) => {
        state.threadMeta.created = {
          pinned: false,
          lastReadUpdatedAt: 0,
          browserBinding: { bindingId, instanceId, attachedAt: Date.now() },
        };
      });
      return projection.summaries.get("created")!;
    },
    attach: async (instanceId, threadId, bindingId) => {
      const existing = store.view().threadMeta[threadId]?.browserBinding;
      if (existing && existing.instanceId !== instanceId) {
        throw new BrowserExtensionError(
          "owned_by_another_instance",
          "Browser binding belongs to another extension instance",
        );
      }
      await store.update((state) => {
        const meta = state.threadMeta[threadId] ?? { pinned: false, lastReadUpdatedAt: 0 };
        meta.browserBinding = { bindingId, instanceId, attachedAt: Date.now() };
        state.threadMeta[threadId] = meta;
      });
      return projection.summaries.get(threadId) ?? summary(threadId);
    },
    deleteBinding: vi.fn(async (threadId: string) => {
      await store.update((state) => {
        const meta = state.threadMeta[threadId];
        if (meta) delete meta.browserBinding;
      });
    }),
  });
  browser.registerRoutes();
  await app.ready();
  return {
    app,
    store,
    projection,
    browser,
    directory,
    status: (threadId: string) => browser.browserStatus(threadId),
    mcp: (bindingId: string, payload: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: `/api/v1/internal/browser-mcp/${bindingId}`,
        headers: { "x-codexnest-browser-secret": "internal-secret" },
        payload,
      }),
    close: () => app.close(),
  };
}

class FakeProjection extends EventEmitter {
  summaries = new Map<string, ThreadSummary>();
  private statusProvider: (threadId: string) => BrowserThreadStatus = () => "disabled";

  setBrowserStatusProvider(provider: (threadId: string) => BrowserThreadStatus): void {
    this.statusProvider = provider;
  }

  setThreadResumeConfigProvider(): void {}

  publishThreadState(threadId: string): void {
    const current = this.summaries.get(threadId);
    if (current) current.browserStatus = this.statusProvider(threadId);
  }

  summary(threadId: string): ThreadSummary | undefined {
    return this.summaries.get(threadId);
  }

  snapshot(): AppSnapshot {
    return {
      sequence: 1,
      uiLanguage: "en",
      connection: { state: "ready", message: null, syncedAt: null },
      projects: [
        {
          id: "project",
          displayName: "Project",
          path: "/work",
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
        },
      ],
      threads: [...this.summaries.values()],
      attention: [],
      models: [],
    };
  }
}

function summary(id: string, cwd = "/work"): ThreadSummary {
  return {
    id,
    projectId: "project",
    title: id,
    preview: "",
    cwd,
    state: "idle",
    unread: false,
    unseen: false,
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    currentTurnId: null,
    queuedMessageCount: 0,
    browserStatus: "disconnected",
    settings: { collaborationMode: "default" },
    relation: { kind: "session", sessionId: id },
  };
}

async function connect(
  app: ReturnType<typeof Fastify>,
  instanceId: string,
  bindings: BrowserExtensionBindingSummary[] = [],
) {
  const socket = await app.injectWS(BROWSER_EXTENSION_WEBSOCKET_PATH, {
    headers: { origin: "http://allowed" },
  });
  const frames = frameReader(socket);
  socket.send(JSON.stringify(helloFrame(instanceId, bindings)));
  return { socket, ...frames };
}

function helloFrame(instanceId: string, bindings: BrowserExtensionBindingSummary[] = []) {
  return {
    type: "client.hello",
    protocol: BROWSER_EXTENSION_PROTOCOL,
    version: BROWSER_EXTENSION_PROTOCOL_VERSION,
    token: "correct",
    instanceId,
    extensionVersion: "0.1.6",
    browser: { name: "chrome", version: "128" },
    capabilities: {
      tools: BROWSER_TOOL_NAMES,
      maxProjectFileBytes: 100 * 1024 * 1024,
      screenshots: ["image/jpeg", "image/png"],
    },
    bindings,
  };
}

function bindingSummary(threadId: string): BrowserExtensionBindingSummary {
  return {
    threadId,
    projectId: "project",
    title: threadId,
    groupId: 1,
    tabIds: [1],
    createdAt: 1,
    updatedAt: 1,
  };
}

function tabSummary(id = 1) {
  return {
    id,
    windowId: 1,
    groupId: -1,
    active: true,
    title: "Tab",
    url: "https://example.com",
  };
}

function frameReader(socket: WebSocket) {
  const queued: BrowserExtensionServerFrame[] = [];
  const waiters: Array<(frame: BrowserExtensionServerFrame) => void> = [];
  socket.on("message", (data) => {
    const frame = JSON.parse(data.toString()) as BrowserExtensionServerFrame;
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else queued.push(frame);
  });
  const next = (): Promise<BrowserExtensionServerFrame> => {
    const frame = queued.shift();
    return frame ? Promise.resolve(frame) : new Promise((resolve) => waiters.push(resolve));
  };
  return {
    next,
    async nextType<Type extends BrowserExtensionServerFrame["type"]>(type: Type) {
      for (;;) {
        const frame = await next();
        if (frame.type === type)
          return frame as Extract<BrowserExtensionServerFrame, { type: Type }>;
      }
    },
  };
}

function closeCode(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}
