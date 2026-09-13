import { defineConfig } from "@playwright/test";

import visualConfig from "./playwright.config";

export default defineConfig({
  ...visualConfig,
  testDir: "./e2e/docs",
  timeout: 60_000,
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  use: { ...visualConfig.use, locale: "en-US", timezoneId: "UTC", deviceScaleFactor: 1 },
});
