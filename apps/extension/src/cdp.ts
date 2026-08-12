const CDP_VERSION = "1.3";
const MAX_RECORDS_PER_TAB = 1_000;
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const MAX_STORED_SCREENSHOT_BYTES = 24 * 1024 * 1024;
const MAX_STORED_SCREENSHOTS = 16;

import {
  CdpNetworkCaptureAssembler,
  type CompletedNetworkCapture,
  type DroppedNetworkCapture,
} from "./network-capture";
import { webext } from "./webext";

export interface ConsoleRecord {
  id: number;
  at: number;
  level: string;
  text: string;
  url?: string;
  line?: number;
}

export interface NetworkExchangeRecord {
  id: number;
  at: number;
  requestId: string;
  exchangeId: string;
  method: string;
  url: string;
  resourceType?: string;
  status?: number;
  mimeType?: string;
  failed?: string;
}

export interface StoredImage {
  imageId: string;
  data: string;
  mimeType: "image/png" | "image/jpeg";
  byteLength: number;
  createdAt: number;
}

export class ScreenshotStore {
  private readonly images = new Map<string, StoredImage>();
  private totalBytes = 0;

  add(data: string, mimeType: StoredImage["mimeType"]): StoredImage {
    const image: StoredImage = {
      imageId: crypto.randomUUID(),
      data,
      mimeType,
      byteLength: base64ByteLength(data),
      createdAt: Date.now(),
    };
    this.images.set(image.imageId, image);
    this.totalBytes += image.byteLength;
    this.trim();
    return image;
  }

  get(imageId: string): StoredImage | undefined {
    return this.images.get(imageId);
  }

  clear(): void {
    this.images.clear();
    this.totalBytes = 0;
  }

  get size(): number {
    return this.images.size;
  }

  private trim(): void {
    while (
      this.images.size > MAX_STORED_SCREENSHOTS ||
      this.totalBytes > MAX_STORED_SCREENSHOT_BYTES
    ) {
      const oldest = this.images.values().next().value as StoredImage | undefined;
      if (!oldest) break;
      this.images.delete(oldest.imageId);
      this.totalBytes -= oldest.byteLength;
    }
  }
}

export class DebuggerController {
  readonly screenshots = new ScreenshotStore();
  private readonly attached = new Set<number>();
  private readonly attaching = new Map<number, Promise<void>>();
  private readonly consoleRecords = new Map<number, ConsoleRecord[]>();
  private readonly networkRecords = new Map<number, NetworkExchangeRecord[]>();
  private readonly networkCapture: CdpNetworkCaptureAssembler;
  private recordId = 1;

  constructor(
    private readonly navigationListener: (tabId: number) => void,
    private readonly networkCaptureListener: (
      capture: CompletedNetworkCapture,
    ) => void | Promise<void> = () => undefined,
    threadForTab: (tabId: number) => string | null = () => null,
    networkCaptureDropListener: (capture: DroppedNetworkCapture) => void | Promise<void> = () =>
      undefined,
  ) {
    this.networkCapture = new CdpNetworkCaptureAssembler(
      async <T>(tabId: number, method: string, parameters?: Record<string, unknown>) =>
        (await webext.debugger.sendCommand({ tabId }, method, parameters)) as T,
      threadForTab,
      (capture) => {
        this.pushNetwork(capture.tabId, {
          id: this.recordId++,
          requestId: capture.requestId,
          exchangeId: capture.exchangeId,
          ...capture.summary,
        });
        void this.networkCaptureListener(capture);
      },
      (capture) => void networkCaptureDropListener(capture),
    );
    webext.debugger.onEvent.addListener((source, method, parameters) => {
      if (source.tabId === undefined) return;
      this.onEvent(source.tabId, method, parameters);
    });
    webext.debugger.onDetach.addListener((source) => {
      if (source.tabId !== undefined) {
        this.attached.delete(source.tabId);
        this.attaching.delete(source.tabId);
      }
    });
  }

  async ensureAttached(tabId: number): Promise<void> {
    if (this.attached.has(tabId)) return;
    const existing = this.attaching.get(tabId);
    if (existing) return existing;
    const operation = this.attach(tabId);
    this.attaching.set(tabId, operation);
    try {
      await operation;
    } finally {
      this.attaching.delete(tabId);
    }
  }

  async detach(tabId: number): Promise<void> {
    if (!this.attached.has(tabId)) return;
    try {
      await webext.debugger.detach({ tabId });
    } finally {
      this.attached.delete(tabId);
    }
  }

  async command<T>(
    tabId: number,
    method: string,
    parameters?: Record<string, unknown>,
  ): Promise<T> {
    await this.ensureAttached(tabId);
    return (await webext.debugger.sendCommand({ tabId }, method, parameters)) as T;
  }

  async captureScreenshot(tabId: number): Promise<StoredImage> {
    const png = await this.command<{ data: string }>(tabId, "Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    if (base64ByteLength(png.data) <= MAX_SCREENSHOT_BYTES) {
      return this.screenshots.add(png.data, "image/png");
    }

    let smallest = "";
    for (const quality of [82, 65, 48, 32, 20, 10]) {
      const jpeg = await this.command<{ data: string }>(tabId, "Page.captureScreenshot", {
        format: "jpeg",
        quality,
        fromSurface: true,
        captureBeyondViewport: false,
      });
      smallest = jpeg.data;
      if (base64ByteLength(jpeg.data) <= MAX_SCREENSHOT_BYTES) break;
    }
    if (base64ByteLength(smallest) > MAX_SCREENSHOT_BYTES) {
      throw new Error("Screenshot exceeds the 5 MB transfer limit even after JPEG compression");
    }
    return this.screenshots.add(smallest, "image/jpeg");
  }

  readConsole(tabId: number, options: Record<string, unknown>): ConsoleRecord[] {
    const since = typeof options.since === "number" ? options.since : 0;
    const level = typeof options.level === "string" ? options.level : "";
    const search = typeof options.search === "string" ? options.search.toLocaleLowerCase() : "";
    const limit = boundedInteger(options.limit, 200, 1, 1_000);
    return (this.consoleRecords.get(tabId) ?? [])
      .filter(
        (record) =>
          record.at >= since &&
          (!level || record.level === level) &&
          (!search || record.text.toLocaleLowerCase().includes(search)),
      )
      .slice(-limit);
  }

  readNetwork(tabId: number, options: Record<string, unknown>): NetworkExchangeRecord[] {
    const since = typeof options.since === "number" ? options.since : 0;
    const search = typeof options.search === "string" ? options.search.toLocaleLowerCase() : "";
    const limit = boundedInteger(options.limit, 200, 1, 1_000);
    return (this.networkRecords.get(tabId) ?? [])
      .filter(
        (record) =>
          record.at >= since && (!search || record.url.toLocaleLowerCase().includes(search)),
      )
      .slice(-limit);
  }

  forget(tabId: number): void {
    this.consoleRecords.delete(tabId);
    this.networkRecords.delete(tabId);
    this.networkCapture.forget(tabId);
  }

  private async attach(tabId: number): Promise<void> {
    await webext.debugger.attach({ tabId }, CDP_VERSION);
    this.attached.add(tabId);
    try {
      await Promise.all([
        this.command(tabId, "Page.enable"),
        this.command(tabId, "Runtime.enable"),
        this.command(tabId, "Log.enable"),
        this.command(tabId, "Network.enable", {
          maxTotalBufferSize: 0,
          maxResourceBufferSize: 0,
          maxPostDataSize: 0,
        }),
      ]);
    } catch (error) {
      await this.detach(tabId).catch(() => undefined);
      throw error;
    }
  }

  private onEvent(tabId: number, method: string, value: unknown): void {
    const parameters = isRecord(value) ? value : {};
    if (method === "Page.frameNavigated") {
      const frame = isRecord(parameters.frame) ? parameters.frame : {};
      if (!frame.parentId) this.navigationListener(tabId);
      return;
    }
    if (method === "Page.navigatedWithinDocument") {
      this.navigationListener(tabId);
      return;
    }
    if (method === "Runtime.consoleAPICalled") {
      const args = Array.isArray(parameters.args) ? parameters.args : [];
      const text = args.map(remoteObjectText).join(" ");
      const stack =
        isRecord(parameters.stackTrace) && Array.isArray(parameters.stackTrace.callFrames)
          ? parameters.stackTrace.callFrames[0]
          : undefined;
      const source = isRecord(stack) ? stack : {};
      this.pushConsole(tabId, {
        id: this.recordId++,
        at: Date.now(),
        level: typeof parameters.type === "string" ? parameters.type : "log",
        text: trimMetadata(text),
        url: typeof source.url === "string" ? source.url : undefined,
        line: typeof source.lineNumber === "number" ? source.lineNumber : undefined,
      });
      return;
    }
    if (method === "Log.entryAdded") {
      const entry = isRecord(parameters.entry) ? parameters.entry : {};
      this.pushConsole(tabId, {
        id: this.recordId++,
        at: Date.now(),
        level: typeof entry.level === "string" ? entry.level : "log",
        text: trimMetadata(typeof entry.text === "string" ? entry.text : ""),
        url: typeof entry.url === "string" ? entry.url : undefined,
        line: typeof entry.lineNumber === "number" ? entry.lineNumber : undefined,
      });
      return;
    }
    if (
      method === "Network.requestWillBeSent" ||
      method === "Network.requestWillBeSentExtraInfo" ||
      method === "Network.responseReceived" ||
      method === "Network.responseReceivedExtraInfo" ||
      method === "Network.loadingFinished" ||
      method === "Network.loadingFailed"
    ) {
      this.networkCapture.accept(tabId, method, parameters);
    }
  }

  private pushConsole(tabId: number, record: ConsoleRecord): void {
    const records = this.consoleRecords.get(tabId) ?? [];
    records.push(record);
    if (records.length > MAX_RECORDS_PER_TAB)
      records.splice(0, records.length - MAX_RECORDS_PER_TAB);
    this.consoleRecords.set(tabId, records);
  }

  private pushNetwork(tabId: number, record: NetworkExchangeRecord): void {
    const records = this.networkRecords.get(tabId) ?? [];
    records.push(record);
    if (records.length > MAX_RECORDS_PER_TAB) {
      records.splice(0, records.length - MAX_RECORDS_PER_TAB);
    }
    this.networkRecords.set(tabId, records);
  }
}

export function base64ByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

function remoteObjectText(value: unknown): string {
  if (!isRecord(value)) return String(value);
  if (typeof value.value === "string") return value.value;
  if (value.value !== undefined) return JSON.stringify(value.value);
  if (typeof value.description === "string") return value.description;
  return typeof value.type === "string" ? `[${value.type}]` : "[value]";
}

function trimMetadata(value: string): string {
  const maximum = 8_192;
  return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
