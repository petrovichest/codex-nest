import type { DebuggerController, StoredImage } from "./cdp";
import {
  isRecord,
  MAX_PROJECT_FILE_BYTES,
  type BindingSummary,
  type BrowserTabSummary,
  type BrowserToolName,
  type ProjectFileTransferDescriptor,
  type UploadDescriptor,
} from "./protocol";
import { KeyedSerialQueue } from "./serial";
import { FileTransferRegistry, type ProjectFileData } from "./transfers";

interface ContentResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface ToolContext {
  threadId: string;
  tool: BrowserToolName;
  arguments: unknown;
}

export class BrowserToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "BrowserToolError";
  }
}

export class BrowserToolDispatcher {
  readonly transfers: FileTransferRegistry;
  private readonly queue = new KeyedSerialQueue();
  private readonly debuggerTabs = new Map<string, Set<number>>();
  private readonly detachedThreads = new Set<string>();

  constructor(
    private readonly debuggerController: DebuggerController,
    private readonly getBindings: () => Promise<Record<string, BindingSummary>>,
    private readonly addTabToBinding: (
      threadId: string,
      tabId: number,
      groupId: number,
    ) => Promise<void>,
    private readonly invalidateRefs: (tabId: number) => void,
    requestFile: (transferId: string) => void,
  ) {
    this.transfers = new FileTransferRegistry(requestFile);
  }

  async dispatch(context: ToolContext): Promise<unknown> {
    const binding = (await this.getBindings())[context.threadId];
    if (!binding)
      throw new BrowserToolError("session_detached", "This browser session is no longer attached");
    const args = recordArgs(context.arguments);
    if (context.tool === "tabs_context") return this.tabsContext(binding);
    if (context.tool === "tabs_create") return this.tabsCreate(binding, args);
    if (context.tool === "tabs_close") return this.tabsClose(binding, args);
    const tabId = await this.resolveTabId(binding, args.tabId);
    return this.queue.run(tabId, async () => {
      await this.attachTab(context.threadId, tabId);
      switch (context.tool) {
        case "navigate":
          return this.navigate(tabId, args);
        case "computer":
          return this.computer(tabId, args);
        case "read_page":
          return this.content(tabId, "read_page", args);
        case "get_page_text":
          return this.content(tabId, "get_page_text", args);
        case "find":
          return this.content(tabId, "find", args);
        case "form_input":
          return this.content(tabId, "form_input", args);
        case "javascript_tool":
          return this.javascript(tabId, args);
        case "read_console_messages":
          return { tabId, messages: this.debuggerController.readConsole(tabId, args) };
        case "read_network_requests":
          return { tabId, requests: this.debuggerController.readNetwork(tabId, args) };
        case "resize_window":
          return this.resizeWindow(tabId, args);
        case "upload_file":
          return this.uploadFile(tabId, args);
        default:
          throw new BrowserToolError("unknown_tool", `Unsupported browser tool: ${context.tool}`);
      }
    });
  }

  async attachTab(threadId: string, tabId: number): Promise<void> {
    if (this.detachedThreads.has(threadId)) {
      throw new BrowserToolError("session_detached", "This browser session is no longer attached");
    }
    await this.debuggerController.ensureAttached(tabId);
    if (this.detachedThreads.has(threadId)) {
      if (![...this.debuggerTabs.values()].some((candidate) => candidate.has(tabId))) {
        await this.debuggerController.detach(tabId).catch(() => undefined);
      }
      throw new BrowserToolError("session_detached", "This browser session is no longer attached");
    }
    const tabs = this.debuggerTabs.get(threadId) ?? new Set<number>();
    tabs.add(tabId);
    this.debuggerTabs.set(threadId, tabs);
  }

  async releaseThread(threadId: string): Promise<void> {
    this.detachedThreads.add(threadId);
    const tabs = this.debuggerTabs.get(threadId);
    if (!tabs) return;
    this.debuggerTabs.delete(threadId);
    await Promise.all(
      [...tabs].map(async (tabId) => {
        if ([...this.debuggerTabs.values()].some((candidate) => candidate.has(tabId))) return;
        await this.debuggerController.detach(tabId).catch(() => undefined);
      }),
    );
  }

  activateThread(threadId: string): void {
    this.detachedThreads.delete(threadId);
  }

  forgetTab(tabId: number): void {
    for (const tabs of this.debuggerTabs.values()) tabs.delete(tabId);
    this.debuggerController.forget(tabId);
  }

  private async tabsContext(binding: BindingSummary): Promise<unknown> {
    const tabs = await chrome.tabs.query({});
    const bindings = await this.getBindings();
    const owners = new Map<number, string>();
    for (const candidate of Object.values(bindings)) {
      for (const tabId of candidate.tabIds) owners.set(tabId, candidate.threadId);
    }
    return {
      session: binding,
      tabs: tabs.flatMap((tab) => {
        const summary = tabSummary(tab);
        return summary ? [{ ...summary, ownerThreadId: owners.get(summary.id) ?? null }] : [];
      }),
    };
  }

  private async tabsCreate(
    binding: BindingSummary,
    args: Record<string, unknown>,
  ): Promise<BrowserTabSummary> {
    const url = optionalString(args.url) ?? "about:blank";
    const current = await this.resolveTabId(binding, args.tabId);
    const source = await chrome.tabs.get(current);
    const tab = await chrome.tabs.create({
      url,
      active: args.active !== false,
      windowId: source.windowId,
    });
    if (tab.id === undefined)
      throw new BrowserToolError("tab_create_failed", "Chrome did not return the new tab ID");
    const groupId = await chrome.tabs.group({ tabIds: tab.id, groupId: binding.groupId });
    await this.addTabToBinding(binding.threadId, tab.id, groupId);
    await this.attachTab(binding.threadId, tab.id).catch(() => undefined);
    const grouped = await chrome.tabs.get(tab.id);
    const summary = tabSummary(grouped);
    if (!summary)
      throw new BrowserToolError("tab_create_failed", "Chrome did not return the new tab");
    return summary;
  }

  private async tabsClose(
    binding: BindingSummary,
    args: Record<string, unknown>,
  ): Promise<{ closed: number[] }> {
    const requested = Array.isArray(args.tabIds)
      ? args.tabIds.map(requireTabId)
      : [await this.resolveTabId(binding, args.tabId)];
    const unique = [...new Set(requested)];
    await Promise.all(
      unique.map((tabId) => this.queue.run(tabId, () => chrome.tabs.remove(tabId))),
    );
    return { closed: unique };
  }

  private async navigate(tabId: number, args: Record<string, unknown>): Promise<BrowserTabSummary> {
    const action = optionalString(args.action) ?? (typeof args.url === "string" ? "url" : "reload");
    this.invalidateRefs(tabId);
    if (action === "url") {
      const url = requireString(args.url, "url");
      await chrome.tabs.update(tabId, { url });
    } else if (action === "back") {
      await chrome.tabs.goBack(tabId);
    } else if (action === "forward") {
      await chrome.tabs.goForward(tabId);
    } else if (action === "reload") {
      await chrome.tabs.reload(tabId, { bypassCache: args.bypassCache === true });
    } else {
      throw new BrowserToolError(
        "invalid_arguments",
        "navigate.action must be url, back, forward, or reload",
      );
    }
    const tab = await chrome.tabs.get(tabId);
    const summary = tabSummary(tab);
    if (!summary) throw new BrowserToolError("tab_not_found", `Tab ${tabId} no longer exists`);
    return summary;
  }

  private async computer(tabId: number, args: Record<string, unknown>): Promise<unknown> {
    const action = requireString(args.action, "action");
    if (action === "screenshot") {
      const image = await this.debuggerController.captureScreenshot(tabId);
      return imageResult(tabId, image);
    }
    if (action === "wait") {
      const milliseconds = Math.max(
        0,
        Math.min(30_000, numberValue(args.milliseconds ?? args.duration, 1_000)),
      );
      await delay(milliseconds);
      return { tabId, waitedMs: milliseconds };
    }
    if (action === "zoom") {
      const factor = Math.max(0.25, Math.min(5, numberValue(args.factor, 1)));
      await chrome.tabs.setZoom(tabId, factor);
      return { tabId, zoom: factor };
    }
    if (action === "scroll_to") {
      const result = await this.content(tabId, "scroll_to", {
        ref: requireString(args.ref, "ref"),
      });
      return { tabId, ...recordResult(result) };
    }
    if (action === "type") {
      const text = requireString(args.text, "text", true);
      if (typeof args.ref === "string") {
        const point = await this.pointFor(tabId, args);
        await this.clickAt(tabId, point.x, point.y, 1, "left");
      }
      await this.debuggerController.command(tabId, "Input.insertText", { text });
      return { tabId, typed: text.length };
    }
    if (action === "key") {
      const key = requireString(args.key, "key");
      await this.sendKey(tabId, key);
      return { tabId, key };
    }
    if (action === "scroll") {
      const x = numberValue(args.x, 0);
      const y = numberValue(args.y, 0);
      const deltaX = numberValue(args.deltaX, 0);
      const deltaY = numberValue(args.deltaY, numberValue(args.amount, 600));
      await this.debuggerController.command(tabId, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX,
        deltaY,
      });
      return { tabId, deltaX, deltaY };
    }
    if (action === "hover") {
      const point = await this.pointFor(tabId, args);
      await this.debuggerController.command(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
      });
      return { tabId, ...point };
    }
    if (action === "click") {
      const point = await this.pointFor(tabId, args);
      const count = boundedInteger(args.count, 1, 1, 3);
      const button = optionalString(args.button) ?? "left";
      await this.clickAt(tabId, point.x, point.y, count, button);
      return { tabId, ...point, count, button };
    }
    if (action === "drag") {
      const fromX = numberValue(args.fromX, NaN);
      const fromY = numberValue(args.fromY, NaN);
      const toX = numberValue(args.toX, NaN);
      const toY = numberValue(args.toY, NaN);
      if (![fromX, fromY, toX, toY].every(Number.isFinite)) {
        throw new BrowserToolError("invalid_arguments", "drag requires fromX, fromY, toX, and toY");
      }
      await this.drag(tabId, fromX, fromY, toX, toY);
      return { tabId, fromX, fromY, toX, toY };
    }
    throw new BrowserToolError("invalid_arguments", `Unknown computer action: ${action}`);
  }

  private async javascript(tabId: number, args: Record<string, unknown>): Promise<unknown> {
    const expression = requireString(args.code ?? args.expression, "code", true);
    const response = await this.debuggerController.command<Record<string, unknown>>(
      tabId,
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
        replMode: false,
      },
    );
    if (response.exceptionDetails) {
      const details = isRecord(response.exceptionDetails) ? response.exceptionDetails : {};
      throw new BrowserToolError(
        "javascript_error",
        String(details.text ?? "JavaScript evaluation failed"),
        details,
      );
    }
    const remote = isRecord(response.result) ? response.result : {};
    return { tabId, value: remote.value, type: remote.type, description: remote.description };
  }

  private async resizeWindow(tabId: number, args: Record<string, unknown>): Promise<unknown> {
    const tab = await chrome.tabs.get(tabId);
    const width = boundedInteger(args.width, 1280, 320, 10_000);
    const height = boundedInteger(args.height, 800, 240, 10_000);
    const updated = await chrome.windows.update(tab.windowId, { width, height, state: "normal" });
    return { windowId: tab.windowId, width: updated.width, height: updated.height };
  }

  private async uploadFile(tabId: number, args: Record<string, unknown>): Promise<unknown> {
    const ref = requireString(args.ref, "ref");
    const descriptor = uploadDescriptor(args.file ?? args);
    let file: ProjectFileData;
    if (descriptor.kind === "captured_image") {
      const image = this.debuggerController.screenshots.get(descriptor.imageId);
      if (!image)
        throw new BrowserToolError(
          "image_not_found",
          "Captured image is unavailable or has expired",
        );
      file = {
        name:
          descriptor.name ??
          `${descriptor.imageId}.${image.mimeType === "image/png" ? "png" : "jpg"}`,
        mediaType: image.mimeType,
        size: image.byteLength,
        chunks: splitBase64(image.data),
      };
    } else {
      file = await this.transfers.receive(descriptor);
    }
    if (file.size > MAX_PROJECT_FILE_BYTES)
      throw new BrowserToolError("file_too_large", "File must be 100 MB or smaller");
    await this.streamUpload(tabId, ref, file, args.drop === true);
    return { tabId, ref, name: file.name, mediaType: file.mediaType, size: file.size };
  }

  private async streamUpload(
    tabId: number,
    ref: string,
    file: ProjectFileData,
    drop: boolean,
  ): Promise<void> {
    await this.ensureContentScript(tabId);
    const port = chrome.tabs.connect(tabId, { name: "codexnest.upload", frameId: 0 });
    const completion = new Promise<void>((resolve, reject) => {
      const timeout = globalThis.setTimeout(
        () => reject(new Error("File injection timed out")),
        120_000,
      );
      port.onMessage.addListener((message) => {
        if (!isRecord(message) || typeof message.ok !== "boolean") return;
        clearTimeout(timeout);
        if (message.ok) resolve();
        else
          reject(
            new Error(typeof message.error === "string" ? message.error : "File injection failed"),
          );
      });
      port.onDisconnect.addListener(() => {
        clearTimeout(timeout);
        reject(new Error("File injection connection closed before completion"));
      });
    });
    port.postMessage({
      type: "start",
      name: file.name,
      mediaType: file.mediaType,
      size: file.size,
      ref,
      drop,
    });
    for (const chunk of file.chunks) port.postMessage({ type: "chunk", data: chunk });
    port.postMessage({ type: "end" });
    try {
      await completion;
    } finally {
      port.disconnect();
    }
  }

  private async content(
    tabId: number,
    action: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const request = { type: "codexnest.content", action, arguments: args };
    let response: unknown;
    try {
      response = await chrome.tabs.sendMessage(tabId, request, { frameId: 0 });
    } catch {
      await this.ensureContentScript(tabId);
      response = await chrome.tabs.sendMessage(tabId, request, { frameId: 0 });
    }
    const parsed = response as ContentResponse | undefined;
    if (!parsed?.ok)
      throw new BrowserToolError(
        "page_unavailable",
        parsed?.error ?? "Page content is unavailable",
      );
    return parsed.result;
  }

  private async ensureContentScript(tabId: number): Promise<void> {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        files: ["content.js"],
      });
    } catch (error) {
      throw new BrowserToolError(
        "page_unavailable",
        `This page cannot be accessed: ${errorMessage(error)}`,
      );
    }
  }

  private async pointFor(
    tabId: number,
    args: Record<string, unknown>,
  ): Promise<{ x: number; y: number }> {
    if (typeof args.ref === "string") {
      const value = await this.content(tabId, "element_rect", { ref: args.ref });
      if (!isRecord(value)) throw new BrowserToolError("stale_ref", "Element ref is unavailable");
      return { x: numberValue(value.centerX, NaN), y: numberValue(value.centerY, NaN) };
    }
    const x = numberValue(args.x, NaN);
    const y = numberValue(args.y, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y))
      throw new BrowserToolError("invalid_arguments", "x and y, or ref, are required");
    return { x, y };
  }

  private async clickAt(
    tabId: number,
    x: number,
    y: number,
    clickCount: number,
    button: string,
  ): Promise<void> {
    const cdpButton = button === "right" ? "right" : button === "middle" ? "middle" : "left";
    await this.debuggerController.command(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
    });
    await this.debuggerController.command(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: cdpButton,
      clickCount,
    });
    await this.debuggerController.command(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: cdpButton,
      clickCount,
    });
  }

  private async drag(
    tabId: number,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
  ): Promise<void> {
    await this.debuggerController.command(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: fromX,
      y: fromY,
    });
    await this.debuggerController.command(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: fromX,
      y: fromY,
      button: "left",
      clickCount: 1,
    });
    for (let step = 1; step <= 8; step += 1) {
      const ratio = step / 8;
      await this.debuggerController.command(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: fromX + (toX - fromX) * ratio,
        y: fromY + (toY - fromY) * ratio,
        button: "left",
        buttons: 1,
      });
    }
    await this.debuggerController.command(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: toX,
      y: toY,
      button: "left",
      clickCount: 1,
    });
  }

  private async sendKey(tabId: number, shortcut: string): Promise<void> {
    const parts = shortcut
      .split("+")
      .map((part) => part.trim())
      .filter(Boolean);
    const key = parts.pop();
    if (!key) throw new BrowserToolError("invalid_arguments", "key must not be empty");
    let modifiers = 0;
    for (const modifier of parts) {
      const normalised = modifier.toLowerCase();
      if (normalised === "alt" || normalised === "option") modifiers |= 1;
      else if (normalised === "ctrl" || normalised === "control") modifiers |= 2;
      else if (normalised === "meta" || normalised === "cmd" || normalised === "command")
        modifiers |= 4;
      else if (normalised === "shift") modifiers |= 8;
      else throw new BrowserToolError("invalid_arguments", `Unknown key modifier: ${modifier}`);
    }
    const definition = keyDefinition(key);
    await this.debuggerController.command(tabId, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      modifiers,
      ...definition,
    });
    await this.debuggerController.command(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers,
      ...definition,
    });
  }

  private async resolveTabId(binding: BindingSummary, value: unknown): Promise<number> {
    if (value !== undefined) {
      const requested = requireTabId(value);
      await chrome.tabs.get(requested).catch(() => {
        throw new BrowserToolError("tab_not_found", `Tab ${requested} does not exist`);
      });
      return requested;
    }
    let firstLive: ChromeTab | null = null;
    for (const candidate of binding.tabIds) {
      firstLive = await chrome.tabs.get(candidate).catch(() => null);
      if (firstLive) break;
    }
    if (!firstLive || firstLive.id === undefined) {
      throw new BrowserToolError("session_detached", "The browser session has no tabs");
    }
    const tabs = await chrome.tabs.query({ active: true, windowId: firstLive.windowId });
    const active = tabs.find((tab) => tab.id !== undefined && binding.tabIds.includes(tab.id));
    return active?.id ?? firstLive.id;
  }
}

function tabSummary(tab: ChromeTab): BrowserTabSummary | null {
  if (tab.id === undefined) return null;
  return {
    id: tab.id,
    windowId: tab.windowId,
    groupId: tab.groupId,
    active: tab.active,
    title: tab.title ?? "",
    url: tab.url ?? tab.pendingUrl ?? "",
  };
}

function imageResult(tabId: number, image: StoredImage): unknown {
  return {
    tabId,
    imageId: image.imageId,
    content: [{ type: "image", mimeType: image.mimeType, data: image.data }],
  };
}

function uploadDescriptor(value: unknown): UploadDescriptor {
  if (!isRecord(value))
    throw new BrowserToolError("invalid_arguments", "file descriptor is required");
  if (value.kind === "captured_image" && typeof value.imageId === "string") {
    return { kind: "captured_image", imageId: value.imageId, name: optionalString(value.name) };
  }
  if (
    value.kind === "project_file" &&
    typeof value.transferId === "string" &&
    typeof value.name === "string" &&
    typeof value.mediaType === "string" &&
    typeof value.size === "number"
  ) {
    return value as unknown as ProjectFileTransferDescriptor;
  }
  throw new BrowserToolError(
    "invalid_arguments",
    "file must identify a captured image or project file transfer",
  );
}

function splitBase64(value: string): string[] {
  const chunkLength = 512 * 1024;
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += chunkLength)
    chunks.push(value.slice(offset, offset + chunkLength));
  return chunks;
}

function keyDefinition(value: string): Record<string, unknown> {
  const upper = value.toUpperCase();
  const special: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
    ENTER: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
    TAB: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
    ESCAPE: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
    BACKSPACE: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
    DELETE: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
    ARROWUP: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
    ARROWDOWN: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
    ARROWLEFT: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
    ARROWRIGHT: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
    SPACE: { key: " ", code: "Space", windowsVirtualKeyCode: 32 },
  };
  const known = special[upper];
  if (known) return known;
  const key = value.length === 1 ? value : value;
  return {
    key,
    code: value.length === 1 && /[a-z]/i.test(value) ? `Key${upper}` : value,
    windowsVirtualKeyCode: upper.charCodeAt(0),
  };
}

function recordArgs(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value))
    throw new BrowserToolError("invalid_arguments", "Tool arguments must be an object");
  return value;
}

function recordResult(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : { result: value };
}

function requireTabId(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    throw new BrowserToolError("invalid_arguments", "tabId must be a non-negative integer");
  return value;
}

function requireString(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0))
    throw new BrowserToolError(
      "invalid_arguments",
      `${name} must be ${allowEmpty ? "a string" : "a non-empty string"}`,
    );
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, Math.floor(value)))
    : fallback;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
