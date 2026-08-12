import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import WebSocket from "ws";

import {
  BROWSER_AUTOMATION_OPERATIONS,
  BROWSER_MAX_NETWORK_BODY_BYTES,
  type BrowserAutomationOperation,
} from "@codexnest/protocol";

import type {
  BrowserCaptureStore,
  BrowserCaptureBodyDeclaration,
  BrowserCaptureStart,
} from "./browser-capture-store";

const DEFAULT_ENDPOINT = "ws://127.0.0.1:9222/session";
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_CAPTURE_BODY_BYTES = BROWSER_MAX_NETWORK_BODY_BYTES;
const MAX_ENCODED_CAPTURE_BODY_BYTES = Math.ceil((MAX_CAPTURE_BODY_BYTES * 4) / 3) + 4;
const MAX_BIDI_WEBSOCKET_MESSAGE_BYTES = MAX_ENCODED_CAPTURE_BODY_BYTES + 1024 * 1024;
const MAX_CONSOLE_EVENTS_PER_TAB = 1_000;

export interface FirefoxAutomationRequest {
  bindingId: string;
  threadId: string;
  tabId: string | number;
  operation: BrowserAutomationOperation;
  arguments: Record<string, unknown>;
}

interface PendingCommand {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface ContextBinding {
  bindingId: string;
  threadId: string;
  tabId: string | number;
}

interface NetworkExchangeEvents {
  bindingId: string;
  threadId: string;
  tabId: string | number;
  exchangeId: string;
  createdAt: number;
  requestId: string;
  events: Array<Record<string, unknown>>;
}

export interface FirefoxBidiClientOptions {
  captures: BrowserCaptureStore;
  endpoint?: string;
  commandTimeoutMs?: number;
  createSocket?: (url: string) => WebSocket;
}

/** Minimal Firefox WebDriver BiDi adapter used by protocol-v2 extension requests. */
export class FirefoxBidiClient extends EventEmitter {
  private readonly captures: BrowserCaptureStore;
  private readonly endpoint: string;
  private readonly commandTimeoutMs: number;
  private readonly createSocket: (url: string) => WebSocket;
  private socket?: WebSocket;
  private connecting?: Promise<void>;
  private nextCommandId = 1;
  private readonly pendingCommands = new Map<number, PendingCommand>();
  private readonly contextByTab = new Map<string, string>();
  private readonly bindingByContext = new Map<string, ContextBinding>();
  private readonly consoleEvents = new Map<string, Array<Record<string, unknown>>>();
  private readonly networkEvents = new Map<string, NetworkExchangeEvents>();
  private collector?: string;
  private closed = false;

  constructor(options: FirefoxBidiClientOptions) {
    super();
    this.captures = options.captures;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.createSocket =
      options.createSocket ??
      ((url) => new WebSocket(url, { maxPayload: MAX_BIDI_WEBSOCKET_MESSAGE_BYTES }));
  }

  async execute(request: FirefoxAutomationRequest): Promise<unknown> {
    if (!BROWSER_AUTOMATION_OPERATIONS.includes(request.operation)) {
      throw new Error(`Unsupported Firefox automation operation: ${request.operation}`);
    }
    if (request.operation === "detach") {
      this.detachTab(request.bindingId, request.tabId);
      return {};
    }
    const marker =
      typeof request.arguments.marker === "string" ? request.arguments.marker : undefined;
    const context = await this.contextForTab(
      request.bindingId,
      request.threadId,
      request.tabId,
      marker,
    );
    const method =
      typeof request.arguments.method === "string" ? request.arguments.method : undefined;
    const parameters = isRecord(request.arguments.parameters)
      ? request.arguments.parameters
      : Object.fromEntries(
          Object.entries(request.arguments).filter(
            ([key]) => key !== "marker" && key !== "method" && key !== "parameters",
          ),
        );
    if (request.operation === "attach") return { context };
    if (request.operation === "input") {
      if (!method) {
        const actions = Array.isArray(parameters.actions) ? parameters.actions : [];
        return this.command("input.performActions", { context, actions });
      }
      return this.performCdpInput(context, method, parameters);
    }
    if (request.operation === "evaluate") {
      if (method && method !== "Runtime.evaluate") {
        throw new Error(`Unsupported Firefox evaluation method: ${method}`);
      }
      if (typeof parameters.expression !== "string") {
        throw new Error("Firefox JavaScript evaluation requires an expression");
      }
      const result = await this.command("script.evaluate", {
        expression: parameters.expression,
        target: { context },
        awaitPromise: parameters.awaitPromise !== false,
        resultOwnership: "none",
        serializationOptions: { maxObjectDepth: 10, maxDomDepth: 0 },
      });
      return cdpEvaluationResult(result);
    }
    if (request.operation === "screenshot") {
      if (method && method !== "Page.captureScreenshot") {
        throw new Error(`Unsupported Firefox screenshot method: ${method}`);
      }
      const jpeg = parameters.format === "jpeg";
      const quality = Math.max(0, Math.min(1, finiteNumber(parameters.quality, 100) / 100));
      const result = await this.command("browsingContext.captureScreenshot", {
        context,
        origin: "viewport",
        format: jpeg ? { type: "image/jpeg", quality } : { type: "image/png" },
      });
      return isRecord(result) ? { ...result, mimeType: jpeg ? "image/jpeg" : "image/png" } : result;
    }
    if (method && method !== "Runtime.readConsole") {
      throw new Error(`Unsupported Firefox console method: ${method}`);
    }
    return this.readConsoleEvents(request.bindingId, request.tabId, parameters);
  }

  private performCdpInput(
    context: string,
    method: string,
    parameters: Record<string, unknown>,
  ): Promise<unknown> {
    if (method === "Input.insertText") {
      if (typeof parameters.text !== "string") {
        throw new Error("Firefox text input requires text");
      }
      const actions = [...parameters.text].flatMap((value) => [
        { type: "keyDown", value },
        { type: "keyUp", value },
      ]);
      if (actions.length === 0) return Promise.resolve({});
      return this.command("input.performActions", {
        context,
        actions: [{ type: "key", id: "codexnest-keyboard", actions }],
      });
    }
    if (method === "Input.dispatchKeyEvent") {
      const type = parameters.type;
      const value = bidiKeyValue(parameters.key);
      const modifiers = bidiModifierValues(parameters.modifiers);
      const actions =
        type === "rawKeyDown" || type === "keyDown"
          ? [
              ...modifiers.map((modifier) => ({ type: "keyDown", value: modifier })),
              { type: "keyDown", value },
            ]
          : type === "keyUp"
            ? [
                { type: "keyUp", value },
                ...modifiers.reverse().map((modifier) => ({ type: "keyUp", value: modifier })),
              ]
            : undefined;
      if (!actions) throw new Error(`Unsupported Firefox key event type: ${String(type)}`);
      return this.command("input.performActions", {
        context,
        actions: [{ type: "key", id: "codexnest-keyboard", actions }],
      });
    }
    if (method === "Input.dispatchMouseEvent") {
      const type = parameters.type;
      const x = finiteNumber(parameters.x, 0);
      const y = finiteNumber(parameters.y, 0);
      if (type === "mouseWheel") {
        return this.command("input.performActions", {
          context,
          actions: [
            {
              type: "wheel",
              id: "codexnest-wheel",
              actions: [
                {
                  type: "scroll",
                  x,
                  y,
                  deltaX: finiteNumber(parameters.deltaX, 0),
                  deltaY: finiteNumber(parameters.deltaY, 0),
                  origin: "viewport",
                },
              ],
            },
          ],
        });
      }
      const button = bidiMouseButton(parameters.button);
      let actions: Array<Record<string, unknown>>;
      if (type === "mouseMoved") {
        actions = [{ type: "pointerMove", x, y, duration: 0, origin: "viewport" }];
      } else if (type === "mousePressed") {
        const clickCount = Math.max(
          1,
          Math.min(3, Math.trunc(finiteNumber(parameters.clickCount, 1))),
        );
        actions = [];
        for (let click = 0; click < clickCount; click += 1) {
          actions.push({ type: "pointerDown", button });
          if (click + 1 < clickCount) actions.push({ type: "pointerUp", button });
        }
      } else if (type === "mouseReleased") {
        actions = [{ type: "pointerUp", button }];
      } else {
        throw new Error(`Unsupported Firefox mouse event type: ${String(type)}`);
      }
      return this.command("input.performActions", {
        context,
        actions: [
          {
            type: "pointer",
            id: "codexnest-mouse",
            parameters: { pointerType: "mouse" },
            actions,
          },
        ],
      });
    }
    throw new Error(`Unsupported Firefox input method: ${method}`);
  }

  async close(): Promise<void> {
    this.closed = true;
    const socket = this.socket;
    this.socket = undefined;
    this.connecting = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "Server closing");
    this.rejectPending(new Error("Firefox WebDriver BiDi client closed"));
    this.resetSessionState();
  }

  detachBinding(bindingId: string): void {
    for (const [key, context] of this.contextByTab) {
      if (!key.startsWith(`${bindingId}\0`)) continue;
      this.contextByTab.delete(key);
      this.consoleEvents.delete(key);
      this.bindingByContext.delete(context);
    }
    for (const [key, exchange] of this.networkEvents) {
      if (exchange.bindingId === bindingId) this.networkEvents.delete(key);
    }
  }

  private async contextForTab(
    bindingId: string,
    threadId: string,
    tabId: string | number,
    marker: string | undefined,
  ): Promise<string> {
    await this.connect();
    const key = tabKey(bindingId, tabId);
    const cached = this.contextByTab.get(key);
    if (cached) return cached;
    if (!marker || marker.length > 512)
      throw new Error("Firefox tab marker is required for attach");

    const tree = await this.command("browsingContext.getTree", {});
    const contexts = flattenContexts(
      isRecord(tree) && Array.isArray(tree.contexts) ? tree.contexts : [],
    );
    const expression = `(() => { const node = document.documentElement; if (node?.getAttribute("data-codexnest-bidi-marker") !== ${JSON.stringify(marker)}) return false; node.removeAttribute("data-codexnest-bidi-marker"); return true; })()`;
    for (const context of contexts) {
      try {
        const evaluated = await this.command("script.evaluate", {
          expression,
          target: { context },
          awaitPromise: false,
          resultOwnership: "none",
        });
        if (!remoteBoolean(evaluated)) continue;
        this.contextByTab.set(key, context);
        this.bindingByContext.set(context, { bindingId, threadId, tabId });
        return context;
      } catch {
        // Cross-origin, transient, or discarded contexts are not the marked top-level tab.
      }
    }
    throw new Error("Unable to map the Firefox tab to a WebDriver BiDi browsing context");
  }

  private detachTab(bindingId: string, tabId: string | number): void {
    const key = tabKey(bindingId, tabId);
    const context = this.contextByTab.get(key);
    this.contextByTab.delete(key);
    this.consoleEvents.delete(key);
    if (context) this.bindingByContext.delete(context);
    for (const [exchangeKey, exchange] of this.networkEvents) {
      if (exchange.bindingId === bindingId && String(exchange.tabId) === String(tabId)) {
        this.networkEvents.delete(exchangeKey);
      }
    }
  }

  private async connect(): Promise<void> {
    if (this.closed) throw new Error("Firefox WebDriver BiDi client is closed");
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = this.createSocket(this.endpoint);
      let settled = false;
      const timer = setTimeout(() => {
        socket.terminate();
        fail(new Error("Timed out connecting to Firefox WebDriver BiDi"));
      }, this.commandTimeoutMs);
      timer.unref();
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.socket === socket) this.socket = undefined;
        this.connecting = undefined;
        reject(error);
      };
      socket.once("error", (error) => fail(error));
      socket.once("open", () => {
        this.socket = socket;
        this.attachSocket(socket);
        void this.command("session.new", { capabilities: { alwaysMatch: {} } })
          .then(async () => {
            await this.command("session.subscribe", {
              events: [
                "log.entryAdded",
                "network.beforeRequestSent",
                "network.responseStarted",
                "network.responseCompleted",
                "network.fetchError",
              ],
            });
            const collector = await this.command("network.addDataCollector", {
              dataTypes: ["request", "response"],
              maxEncodedDataSize: MAX_ENCODED_CAPTURE_BODY_BYTES,
              collectorType: "blob",
            });
            if (!isRecord(collector) || typeof collector.collector !== "string") {
              throw new Error("Firefox returned an invalid network collector");
            }
            this.collector = collector.collector;
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            this.connecting = undefined;
            resolve();
          })
          .catch((error) => {
            socket.terminate();
            fail(asError(error));
          });
      });
    });
    return this.connecting;
  }

  private attachSocket(socket: WebSocket): void {
    socket.on("message", (data) => {
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!isRecord(message)) return;
      if (Number.isSafeInteger(message.id)) {
        const id = Number(message.id);
        const pending = this.pendingCommands.get(id);
        if (!pending) return;
        this.pendingCommands.delete(id);
        clearTimeout(pending.timer);
        if (message.type === "error" || typeof message.error === "string") {
          pending.reject(new Error(bidiErrorMessage(message)));
        } else {
          pending.resolve(message.result);
        }
        return;
      }
      if (message.type === "event" && typeof message.method === "string") {
        this.handleEvent(structuredClone(message));
      }
    });
    socket.once("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.connecting = undefined;
      this.rejectPending(new Error("Firefox WebDriver BiDi connection closed"));
      this.resetSessionState();
      this.emit("disconnect");
    });
    socket.on("error", () => undefined);
  }

  private command(method: string, params: Record<string, unknown>): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Firefox WebDriver BiDi is disconnected"));
    }
    const id = this.nextCommandId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(id);
        reject(new Error(`Firefox WebDriver BiDi command timed out: ${method}`));
      }, this.commandTimeoutMs);
      timer.unref();
      this.pendingCommands.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        const pending = this.pendingCommands.get(id);
        if (!pending) return;
        this.pendingCommands.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  private handleEvent(event: Record<string, unknown>): void {
    const method = event.method;
    const params = isRecord(event.params) ? event.params : {};
    if (method === "log.entryAdded") {
      const context =
        typeof params.source === "object" && isRecord(params.source)
          ? params.source.context
          : params.context;
      if (typeof context !== "string") return;
      const binding = this.bindingByContext.get(context);
      if (!binding) return;
      const key = tabKey(binding.bindingId, binding.tabId);
      const events = this.consoleEvents.get(key) ?? [];
      events.push(event);
      if (events.length > MAX_CONSOLE_EVENTS_PER_TAB) {
        events.splice(0, events.length - MAX_CONSOLE_EVENTS_PER_TAB);
      }
      this.consoleEvents.set(key, events);
      return;
    }
    if (typeof method !== "string" || !method.startsWith("network.")) return;
    void this.handleNetworkEvent(event, method, params).catch(() => undefined);
  }

  private async handleNetworkEvent(
    event: Record<string, unknown>,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const context = typeof params.context === "string" ? params.context : undefined;
    const binding = context ? this.bindingByContext.get(context) : undefined;
    const request = isRecord(params.request) ? params.request : undefined;
    const requestId = typeof request?.request === "string" ? request.request : undefined;
    if (!binding || !requestId) return;
    const redirectCount = Number.isSafeInteger(params.redirectCount)
      ? Number(params.redirectCount)
      : 0;
    const exchangeId = `${requestId}:${redirectCount}`;
    const key = `${binding.bindingId}\0${String(binding.tabId)}\0${exchangeId}`;
    let exchange = this.networkEvents.get(key);
    if (!exchange) {
      exchange = {
        bindingId: binding.bindingId,
        threadId: binding.threadId,
        tabId: binding.tabId,
        exchangeId,
        createdAt: eventTimestamp(params),
        requestId,
        events: [],
      };
      this.networkEvents.set(key, exchange);
    }
    exchange.events.push(event);
    if (method === "network.fetchError") {
      this.networkEvents.delete(key);
      await this.commitNetworkExchange(exchange, false);
    } else if (method === "network.responseCompleted") {
      this.networkEvents.delete(key);
      await this.commitNetworkExchange(exchange, true);
    }
  }

  private async commitNetworkExchange(
    exchange: NetworkExchangeEvents,
    retrieveResponse: boolean,
  ): Promise<void> {
    const collector = this.collector;
    if (!collector) return;
    let requestBody: Buffer | undefined;
    let responseBody: Buffer | undefined;
    try {
      const expected = expectedBodySizes(exchange, retrieveResponse);
      requestBody = await this.getNetworkBody(
        collector,
        exchange.requestId,
        "request",
        expected.request,
      );
      responseBody = retrieveResponse
        ? await this.getNetworkBody(collector, exchange.requestId, "response", expected.response)
        : undefined;
    } catch (error) {
      await this.captures.recordDrop(exchange.bindingId);
      throw error;
    }
    const captureId = randomUUID();
    const requestDeclaration = requestBody
      ? bodyDeclaration(captureId, "request", requestBody)
      : undefined;
    const responseDeclaration = responseBody
      ? bodyDeclaration(captureId, "response", responseBody)
      : undefined;
    const canonical = canonicalFirefoxExchange(exchange, requestDeclaration, responseDeclaration);
    const start: BrowserCaptureStart = {
      captureId,
      bindingId: exchange.bindingId,
      tabId: exchange.tabId,
      exchangeId: exchange.exchangeId,
      createdAt: exchange.createdAt,
      metadata: canonical,
      ...(requestDeclaration ? { requestBody: requestDeclaration } : {}),
      ...(responseDeclaration ? { responseBody: responseDeclaration } : {}),
    };
    await this.captures.storeComplete(start, {
      ...(requestBody ? { request: requestBody } : {}),
      ...(responseBody ? { response: responseBody } : {}),
    });
  }

  private async getNetworkBody(
    collector: string,
    request: string,
    dataType: "request" | "response",
    expectedBytes: number | null,
  ): Promise<Buffer | undefined> {
    if (expectedBytes === null) return undefined;
    try {
      const result = await this.command("network.getData", {
        collector,
        request,
        dataType,
        disown: true,
      });
      if (!isRecord(result) || !isRecord(result.bytes)) {
        throw new Error(`Firefox returned an invalid ${dataType} body`);
      }
      const body = decodeBytesValue(result.bytes);
      if (body.byteLength > MAX_CAPTURE_BODY_BYTES) {
        throw new Error(`${dataType} body exceeds ${MAX_CAPTURE_BODY_BYTES} bytes`);
      }
      if (body.byteLength !== expectedBytes) {
        throw new Error(
          `${dataType} body length ${body.byteLength} does not match the reported ${expectedBytes} bytes`,
        );
      }
      return body;
    } catch (error) {
      const message = asError(error).message;
      if (/no such network data|unavailable network data/iu.test(message)) {
        throw new Error(`${dataType} body is unavailable`, { cause: error });
      }
      throw error;
    }
  }

  private readConsoleEvents(
    bindingId: string,
    tabId: string | number,
    options: Record<string, unknown>,
  ): Array<Record<string, unknown>> {
    const since = typeof options.since === "number" ? options.since : 0;
    const level = typeof options.level === "string" ? options.level : "";
    const search = typeof options.search === "string" ? options.search.toLocaleLowerCase() : "";
    const limit = typeof options.limit === "number" ? options.limit : 200;
    const boundedLimit = Math.max(1, Math.min(MAX_CONSOLE_EVENTS_PER_TAB, Math.trunc(limit)));
    return (this.consoleEvents.get(tabKey(bindingId, tabId)) ?? [])
      .map((event, index) => firefoxConsoleRecord(event, index + 1))
      .filter(
        (record) =>
          record.at >= since &&
          (!level || record.level === level) &&
          (!search || record.text.toLocaleLowerCase().includes(search)),
      )
      .slice(-boundedLimit)
      .map((record) => structuredClone(record));
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingCommands.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingCommands.clear();
  }

  private resetSessionState(): void {
    for (const exchange of this.networkEvents.values()) {
      void this.captures.recordDrop(exchange.bindingId).catch(() => undefined);
    }
    this.collector = undefined;
    this.contextByTab.clear();
    this.bindingByContext.clear();
    this.networkEvents.clear();
  }
}

function expectedBodySizes(
  captured: NetworkExchangeEvents,
  retrieveResponse: boolean,
): { request: number | null; response: number | null } {
  const before = findNetworkEvent(captured.events, "network.beforeRequestSent");
  const beforeParams = eventParams(before);
  const request = isRecord(beforeParams.request) ? beforeParams.request : undefined;
  if (!request) throw new Error("Firefox request metadata is incomplete");
  const requestBytes = reportedBodySize(request.bodySize, "request");
  if (!retrieveResponse) return { request: requestBytes, response: null };

  const completed = findNetworkEvent(captured.events, "network.responseCompleted");
  const completedParams = eventParams(completed);
  const response = isRecord(completedParams.response) ? completedParams.response : undefined;
  if (!response) throw new Error("Firefox response metadata is incomplete");
  const status = typeof response.status === "number" ? response.status : NaN;
  const method = typeof request.method === "string" ? request.method.toUpperCase() : "";
  const bodyForbidden =
    method === "HEAD" ||
    (Number.isInteger(status) && status >= 100 && status < 200) ||
    status === 204 ||
    status === 205 ||
    status === 304;
  const content = isRecord(response.content) ? response.content : undefined;
  const reportedResponseBytes = bodyForbidden
    ? null
    : reportedBodySize(content?.size, "response content");
  const redirectBodyUnavailable =
    (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) &&
    reportedResponseBytes !== 0;
  if (redirectBodyUnavailable) {
    throw new Error("Firefox does not expose non-empty intermediate redirect response bodies");
  }
  const responseBytes =
    reportedResponseBytes === 0 && status >= 300 && status < 400 ? null : reportedResponseBytes;
  return { request: requestBytes, response: responseBytes };
}

function reportedBodySize(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Firefox ${label} body size is missing or invalid`);
  }
  const size = Number(value);
  if (size > MAX_CAPTURE_BODY_BYTES) {
    throw new Error(`${label} body exceeds ${MAX_CAPTURE_BODY_BYTES} bytes`);
  }
  return size;
}

function flattenContexts(values: unknown[]): string[] {
  const contexts: string[] = [];
  const visit = (value: unknown) => {
    if (!isRecord(value)) return;
    if (typeof value.context === "string") contexts.push(value.context);
    if (Array.isArray(value.children)) value.children.forEach(visit);
  };
  values.forEach(visit);
  return contexts;
}

function remoteBoolean(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.result)) return false;
  return value.result.type === "boolean" && value.result.value === true;
}

function decodeBytesValue(value: Record<string, unknown>): Buffer {
  if (value.type === "string" && typeof value.value === "string") return Buffer.from(value.value);
  if (value.type === "base64" && typeof value.value === "string") {
    return decodeBase64(value.value);
  }
  throw new Error("Firefox returned an invalid network body");
}

function decodeBase64(value: string): Buffer {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u.test(value)
  ) {
    throw new Error("Invalid base64 data");
  }
  return Buffer.from(value, "base64");
}

function bodyDeclaration(
  captureId: string,
  kind: "request" | "response",
  body: Buffer,
): BrowserCaptureBodyDeclaration {
  return {
    bodyId: `${captureId}:${kind}`,
    length: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

function canonicalFirefoxExchange(
  captured: NetworkExchangeEvents,
  requestBody: BrowserCaptureBodyDeclaration | undefined,
  responseBody: BrowserCaptureBodyDeclaration | undefined,
): Record<string, unknown> {
  const before = findNetworkEvent(captured.events, "network.beforeRequestSent");
  const completed = findNetworkEvent(captured.events, "network.responseCompleted");
  const started = findNetworkEvent(captured.events, "network.responseStarted");
  const failed = findNetworkEvent(captured.events, "network.fetchError");
  const firstParams = eventParams(before ?? captured.events[0]);
  const completionParams = eventParams(completed ?? failed ?? captured.events.at(-1));
  const request = isRecord(firstParams.request) ? firstParams.request : {};
  const responseParams = eventParams(completed ?? started);
  const response = isRecord(responseParams.response) ? responseParams.response : undefined;
  const redirectCount = Number.isSafeInteger(firstParams.redirectCount)
    ? Number(firstParams.redirectCount)
    : 0;
  const completedAt =
    typeof completionParams.timestamp === "number" && Number.isFinite(completionParams.timestamp)
      ? completionParams.timestamp
      : Date.now();
  return {
    schemaVersion: 1,
    provider: "firefox",
    exchange: {
      exchangeId: captured.exchangeId,
      threadId: captured.threadId,
      tabId: captured.tabId,
      redirect: {
        chainId: captured.requestId,
        index: redirectCount,
        redirectedFromExchangeId:
          redirectCount > 0 ? `${captured.requestId}:${redirectCount - 1}` : null,
        redirectedToExchangeId: null,
      },
      request: {
        url: typeof request.url === "string" ? request.url : "",
        method: typeof request.method === "string" ? request.method : "",
        headers: canonicalHeaders(request.headers),
        timestamp: captured.createdAt,
        wallTime: null,
        httpVersion: stringOrNull(request.httpVersion),
        resourceType: stringOrNull(request.destination),
        initiator: firstParams.initiator ?? null,
        body: requestBody ? protocolBodyDescriptor(requestBody, request) : null,
      },
      response: response
        ? {
            url: typeof response.url === "string" ? response.url : "",
            status: typeof response.status === "number" ? response.status : 0,
            statusText: typeof response.statusText === "string" ? response.statusText : "",
            headers: canonicalHeaders(response.headers),
            timestamp:
              typeof responseParams.timestamp === "number" ? responseParams.timestamp : completedAt,
            httpVersion: stringOrNull(response.protocol),
            mediaType: responseMimeType(response),
            remoteAddress: canonicalRemoteAddress(response),
            fromCache: response.fromCache === true,
            fromServiceWorker: response.fromServiceWorker === true,
            body: responseBody ? protocolBodyDescriptor(responseBody, response) : null,
          }
        : null,
      failure: failed
        ? {
            timestamp: completedAt,
            errorText:
              typeof completionParams.errorText === "string"
                ? completionParams.errorText
                : "Network request failed",
            canceled: completionParams.canceled === true,
            blockedReason: stringOrNull(completionParams.blockedReason),
          }
        : null,
      startedAt: captured.createdAt,
      completedAt,
    },
    rawEvents: captured.events,
  };
}

function findNetworkEvent(
  events: Array<Record<string, unknown>>,
  method: string,
): Record<string, unknown> | undefined {
  return events.find((event) => event.method === method);
}

function eventParams(event: Record<string, unknown> | undefined): Record<string, unknown> {
  return event && isRecord(event.params) ? event.params : {};
}

function canonicalHeaders(value: unknown): Array<{ name: string; value: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((header) => {
    if (!isRecord(header) || typeof header.name !== "string") return [];
    if (typeof header.value === "string") return [{ name: header.name, value: header.value }];
    if (isRecord(header.value) && typeof header.value.value === "string") {
      return [{ name: header.name, value: header.value.value }];
    }
    return [];
  });
}

function protocolBodyDescriptor(
  declaration: BrowserCaptureBodyDeclaration,
  endpoint: Record<string, unknown>,
): Record<string, unknown> {
  return {
    bodyId: declaration.bodyId,
    byteLength: declaration.length,
    sha256: declaration.sha256,
    mediaType: declaration.mimeType ?? responseMimeType(endpoint),
    encoding: null,
  };
}

function responseMimeType(response: Record<string, unknown>): string | null {
  if (typeof response.mimeType === "string") return response.mimeType;
  for (const header of canonicalHeaders(response.headers)) {
    if (header.name.toLocaleLowerCase() === "content-type") return header.value;
  }
  return null;
}

function canonicalRemoteAddress(
  response: Record<string, unknown>,
): { ip: string; port: number | null } | null {
  if (typeof response.remoteAddress === "string") {
    return {
      ip: response.remoteAddress,
      port: typeof response.remotePort === "number" ? response.remotePort : null,
    };
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function eventTimestamp(params: Record<string, unknown>): number {
  return typeof params.timestamp === "number" && Number.isFinite(params.timestamp)
    ? params.timestamp
    : Date.now();
}

function firefoxConsoleRecord(
  event: Record<string, unknown>,
  id: number,
): Record<string, unknown> & { at: number; level: string; text: string } {
  const params = eventParams(event);
  const stackTrace = isRecord(params.stackTrace) ? params.stackTrace : undefined;
  const frame = Array.isArray(stackTrace?.callFrames) ? stackTrace.callFrames[0] : undefined;
  const source = isRecord(frame) ? frame : {};
  const argumentText = Array.isArray(params.args) ? params.args.map(remoteValueText).join(" ") : "";
  const text = typeof params.text === "string" ? params.text : argumentText;
  return {
    id,
    at: eventTimestamp(params),
    level:
      typeof params.level === "string"
        ? params.level
        : typeof params.method === "string"
          ? params.method
          : "log",
    text: text.length > 8_192 ? `${text.slice(0, 8_191)}…` : text,
    ...(typeof source.url === "string" ? { url: source.url } : {}),
    ...(typeof source.lineNumber === "number" ? { line: source.lineNumber } : {}),
  };
}

function cdpEvaluationResult(value: unknown): unknown {
  if (!isRecord(value)) throw new Error("Firefox returned an invalid JavaScript result");
  if (value.type === "exception") {
    return {
      exceptionDetails: isRecord(value.exceptionDetails)
        ? value.exceptionDetails
        : { text: "JavaScript evaluation failed" },
    };
  }
  if (value.type !== "success" || !isRecord(value.result)) return value;
  const result = value.result;
  const type = typeof result.type === "string" ? result.type : "undefined";
  const deserialized = bidiRemoteValue(result);
  return {
    result: {
      type: type === "array" || type === "map" || type === "set" ? "object" : type,
      value: deserialized,
      ...(typeof result.description === "string" ? { description: result.description } : {}),
    },
  };
}

function bidiRemoteValue(value: Record<string, unknown>, depth = 0): unknown {
  if (depth > 12) return "[maximum depth]";
  if (value.type === "undefined") return undefined;
  if (value.type === "null") return null;
  if (value.type === "number" && typeof value.value === "string") {
    if (value.value === "NaN") return Number.NaN;
    if (value.value === "Infinity") return Number.POSITIVE_INFINITY;
    if (value.value === "-Infinity") return Number.NEGATIVE_INFINITY;
    if (value.value === "-0") return -0;
  }
  if (
    value.type === "string" ||
    value.type === "boolean" ||
    value.type === "number" ||
    value.type === "bigint" ||
    value.type === "date"
  ) {
    return value.value;
  }
  if ((value.type === "array" || value.type === "set") && Array.isArray(value.value)) {
    return value.value.map((entry) =>
      isRecord(entry) ? bidiRemoteValue(entry, depth + 1) : entry,
    );
  }
  if ((value.type === "object" || value.type === "map") && Array.isArray(value.value)) {
    const entries = value.value.flatMap((entry) => {
      if (!Array.isArray(entry) || entry.length !== 2) return [];
      const key = isRecord(entry[0]) ? bidiRemoteValue(entry[0], depth + 1) : entry[0];
      const item = isRecord(entry[1]) ? bidiRemoteValue(entry[1], depth + 1) : entry[1];
      return [[String(key), item] as const];
    });
    return value.type === "map" ? entries : Object.fromEntries(entries);
  }
  if (value.type === "regexp" && isRecord(value.value)) return { ...value.value };
  return value.value ?? value.description ?? `[${String(value.type ?? "value")}]`;
}

function remoteValueText(value: unknown): string {
  if (!isRecord(value)) return String(value);
  const decoded = bidiRemoteValue(value);
  if (typeof decoded === "string") return decoded;
  if (decoded === undefined) return "undefined";
  try {
    return JSON.stringify(decoded);
  } catch {
    return typeof value.type === "string" ? `[${value.type}]` : "[value]";
  }
}

function bidiKeyValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Firefox key input requires a key");
  }
  const special: Record<string, string> = {
    Backspace: "\uE003",
    Tab: "\uE004",
    Enter: "\uE007",
    Shift: "\uE008",
    Control: "\uE009",
    Alt: "\uE00A",
    Escape: "\uE00C",
    " ": "\uE00D",
    PageUp: "\uE00E",
    PageDown: "\uE00F",
    End: "\uE010",
    Home: "\uE011",
    ArrowLeft: "\uE012",
    ArrowUp: "\uE013",
    ArrowRight: "\uE014",
    ArrowDown: "\uE015",
    Insert: "\uE016",
    Delete: "\uE017",
    Meta: "\uE03D",
  };
  return special[value] ?? value;
}

function bidiModifierValues(value: unknown): string[] {
  const modifiers = typeof value === "number" && Number.isInteger(value) ? value : 0;
  return [
    ...(modifiers & 8 ? ["\uE008"] : []),
    ...(modifiers & 2 ? ["\uE009"] : []),
    ...(modifiers & 1 ? ["\uE00A"] : []),
    ...(modifiers & 4 ? ["\uE03D"] : []),
  ];
}

function bidiMouseButton(value: unknown): number {
  if (value === "middle") return 1;
  if (value === "right") return 2;
  return 0;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function bidiErrorMessage(message: Record<string, unknown>): string {
  const code = typeof message.error === "string" ? message.error : "unknown error";
  const detail = typeof message.message === "string" ? message.message : "Firefox command failed";
  return `${code}: ${detail}`;
}

function tabKey(bindingId: string, tabId: string | number): string {
  return `${bindingId}\0${String(tabId)}`;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error("Firefox WebDriver BiDi request failed");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
