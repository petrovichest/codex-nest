import type { ConsoleRecord, NetworkExchangeRecord, StoredImage } from "./cdp";

export interface AutomationController {
  readonly screenshots: {
    get(imageId: string): StoredImage | undefined;
  };
  ensureAttached(tabId: number, threadId?: string): Promise<void>;
  detach(tabId: number): Promise<void>;
  forget(tabId: number): void;
  command<T>(tabId: number, method: string, parameters?: Record<string, unknown>): Promise<T>;
  captureScreenshot(tabId: number): Promise<StoredImage>;
  readConsole(
    tabId: number,
    options: Record<string, unknown>,
  ): ConsoleRecord[] | Promise<ConsoleRecord[]>;
  readNetwork(
    tabId: number,
    options: Record<string, unknown>,
  ): NetworkExchangeRecord[] | Promise<NetworkExchangeRecord[]>;
}
