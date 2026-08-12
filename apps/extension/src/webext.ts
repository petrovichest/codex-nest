export type BrowserTarget = "chrome" | "firefox";

declare const __CODEXNEST_BROWSER_TARGET__: BrowserTarget;

export const browserTarget: BrowserTarget =
  typeof __CODEXNEST_BROWSER_TARGET__ === "undefined"
    ? /Firefox\//i.test(globalThis.navigator?.userAgent ?? "")
      ? "firefox"
      : "chrome"
    : __CODEXNEST_BROWSER_TARGET__;

export const browserDisplayName = browserTarget === "firefox" ? "Firefox" : "Chrome";

export const webext = new Proxy({} as ChromeApi, {
  get(_target, property) {
    const root = globalThis as typeof globalThis & {
      browser?: ChromeApi;
      chrome?: ChromeApi;
    };
    const api = root.browser ?? root.chrome;
    if (!api) throw new Error("WebExtension API is unavailable");
    return api[property as keyof ChromeApi];
  },
});
