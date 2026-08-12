import type { AutomationController } from "./automation";
import {
  ScreenshotStore,
  type ConsoleRecord,
  type NetworkExchangeRecord,
  type StoredImage,
} from "./cdp";
import { isRecord, MAX_AUTOMATION_RESULT_CHUNKS, type AutomationRequestFrame } from "./protocol";
import { webext } from "./webext";

const AUTOMATION_TIMEOUT_MS = 30_000;

interface PendingAutomation {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: number;
  chunks: string[] | null;
  chunkCount: number;
}

export class FirefoxController implements AutomationController {
  readonly screenshots = new ScreenshotStore();
  private readonly pending = new Map<string, PendingAutomation>();
  private readonly tabThreads = new Map<number, string>();
  private readonly attached = new Set<number>();
  private readonly attaching = new Map<number, Promise<void>>();
  private connected = false;

  constructor(
    private readonly sendFrame: (frame: AutomationRequestFrame) => void,
    private readonly markTab: (tabId: number, marker: string) => Promise<void> = markFirefoxTab,
  ) {}

  async ensureAttached(tabId: number, threadId?: string): Promise<void> {
    if (threadId) this.tabThreads.set(tabId, threadId);
    const owner = this.tabThreads.get(tabId);
    if (!owner || !this.connected || this.attached.has(tabId)) return;
    const existing = this.attaching.get(tabId);
    if (existing) return existing;
    const operation = (async () => {
      const marker = crypto.randomUUID();
      await this.markTab(tabId, marker);
      await this.request(owner, tabId, "attach", { marker });
      this.attached.add(tabId);
    })();
    this.attaching.set(tabId, operation);
    try {
      await operation;
    } finally {
      this.attaching.delete(tabId);
    }
  }

  async detach(tabId: number): Promise<void> {
    const threadId = this.tabThreads.get(tabId);
    if (!threadId) return;
    try {
      if (this.connected && this.attached.has(tabId)) {
        await this.request(threadId, tabId, "detach", {});
      }
    } finally {
      this.tabThreads.delete(tabId);
      this.attached.delete(tabId);
      this.attaching.delete(tabId);
    }
  }

  forget(tabId: number): void {
    this.tabThreads.delete(tabId);
    this.attached.delete(tabId);
    this.attaching.delete(tabId);
  }

  async command<T>(
    tabId: number,
    method: string,
    parameters?: Record<string, unknown>,
  ): Promise<T> {
    const threadId = this.tabThreads.get(tabId);
    if (!threadId) throw new Error("Firefox automation is not attached");
    await this.ensureAttached(tabId, threadId);
    if (!this.connected || !this.attached.has(tabId)) {
      throw new Error("Firefox automation is not connected");
    }
    const operation = automationOperation(method);
    return this.request(threadId, tabId, operation, {
      method,
      ...(parameters ? { parameters } : {}),
    }) as Promise<T>;
  }

  private request(
    threadId: string,
    tabId: number,
    operation: "attach" | "detach" | "evaluate" | "input" | "screenshot" | "console",
    arguments_: Record<string, unknown>,
  ): Promise<unknown> {
    const requestId = crypto.randomUUID();
    const result = new Promise<unknown>((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Firefox automation timed out for ${operation}`));
      }, AUTOMATION_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timeout, chunks: null, chunkCount: 0 });
    });
    try {
      this.sendFrame({
        type: "automation.request",
        requestId,
        threadId,
        tabId,
        operation,
        arguments: arguments_,
      });
    } catch (error) {
      this.reject(requestId, errorMessage(error));
    }
    return result;
  }

  async captureScreenshot(tabId: number): Promise<StoredImage> {
    const result = await this.command<Record<string, unknown>>(tabId, "Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    if (typeof result.data !== "string") {
      throw new Error("Firefox automation returned an invalid screenshot");
    }
    const mimeType = result.mimeType === "image/jpeg" ? "image/jpeg" : "image/png";
    return this.screenshots.add(result.data, mimeType);
  }

  async readConsole(tabId: number, options: Record<string, unknown>): Promise<ConsoleRecord[]> {
    const result = await this.command<unknown>(tabId, "Runtime.readConsole", options);
    return Array.isArray(result) ? (result as ConsoleRecord[]) : [];
  }

  async readNetwork(
    tabId: number,
    options: Record<string, unknown>,
  ): Promise<NetworkExchangeRecord[]> {
    const result = await this.command<unknown>(tabId, "Network.readRequests", options);
    return Array.isArray(result) ? (result as NetworkExchangeRecord[]) : [];
  }

  acceptFrame(frame: unknown): boolean {
    if (!isRecord(frame) || typeof frame.type !== "string") return false;
    if (frame.type === "automation.result.chunk") {
      this.acceptChunk(frame);
      return true;
    }
    if (frame.type === "automation.error") {
      const requestId = typeof frame.requestId === "string" ? frame.requestId : "";
      this.reject(
        requestId,
        isRecord(frame.error) && typeof frame.error.message === "string"
          ? frame.error.message
          : "Firefox automation failed",
      );
      return true;
    }
    if (frame.type !== "automation.result") return false;
    const requestId = typeof frame.requestId === "string" ? frame.requestId : "";
    const pending = this.pending.get(requestId);
    if (!pending) return true;
    this.finish(requestId, frame.result);
    return true;
  }

  clear(reason = "Firefox automation connection closed"): void {
    this.connected = false;
    this.attached.clear();
    this.attaching.clear();
    for (const requestId of this.pending.keys()) this.reject(requestId, reason);
  }

  setConnected(): void {
    this.connected = true;
    for (const [tabId, threadId] of this.tabThreads) {
      void this.ensureAttached(tabId, threadId).catch(() => undefined);
    }
  }

  private acceptChunk(frame: Record<string, unknown>): void {
    const requestId = typeof frame.requestId === "string" ? frame.requestId : "";
    const pending = this.pending.get(requestId);
    if (!pending) return;
    const chunkIndex = frame.chunkIndex;
    const chunkCount = frame.chunkCount;
    if (
      !Number.isInteger(chunkIndex) ||
      !Number.isInteger(chunkCount) ||
      Number(chunkIndex) < 0 ||
      Number(chunkCount) < 1 ||
      Number(chunkIndex) >= Number(chunkCount) ||
      Number(chunkCount) > MAX_AUTOMATION_RESULT_CHUNKS ||
      typeof frame.data !== "string"
    ) {
      this.reject(requestId, "Firefox automation returned an invalid result chunk");
      return;
    }
    if (!pending.chunks) {
      pending.chunks = new Array<string>(Number(chunkCount));
      pending.chunkCount = Number(chunkCount);
    }
    if (pending.chunkCount !== Number(chunkCount)) {
      this.reject(requestId, "Firefox automation changed its result chunk count");
      return;
    }
    pending.chunks[Number(chunkIndex)] = frame.data;
    if (pending.chunks.filter((chunk) => chunk !== undefined).length !== pending.chunkCount) return;
    try {
      this.finish(requestId, JSON.parse(pending.chunks.join("")));
    } catch {
      this.reject(requestId, "Firefox automation returned malformed chunked JSON");
    }
  }

  private finish(requestId: string, result: unknown): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(requestId);
    pending.resolve(result);
  }

  private reject(requestId: string, message: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(requestId);
    pending.reject(new Error(message));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function automationOperation(method: string): "evaluate" | "input" | "screenshot" | "console" {
  if (method === "Runtime.evaluate") return "evaluate";
  if (method.startsWith("Input.")) return "input";
  if (method === "Page.captureScreenshot") return "screenshot";
  if (method === "Runtime.readConsole") return "console";
  throw new Error(`Firefox automation does not support ${method}`);
}

async function markFirefoxTab(tabId: number, marker: string): Promise<void> {
  await webext.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: (value: string) => {
      document.documentElement?.setAttribute("data-codexnest-bidi-marker", value);
    },
    args: [marker],
  });
}
