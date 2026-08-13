export const browserDisplayName = "Chrome";

export const webext = new Proxy({} as ChromeApi, {
  get(_target, property) {
    const root = globalThis as typeof globalThis & {
      chrome?: ChromeApi;
    };
    const api = root.chrome;
    if (!api) throw new Error("WebExtension API is unavailable");
    return api[property as keyof ChromeApi];
  },
});
