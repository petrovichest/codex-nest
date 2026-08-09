import { defineConfig } from "@playwright/test";

const baseURL = "http://127.0.0.1:4173";

export default defineConfig({
  testDir: "./e2e/visual",
  outputDir: "./test-results",
  snapshotPathTemplate: "{testDir}/__screenshots__/{projectName}/{arg}{ext}",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  reporter: "line",
  use: {
    baseURL,
    locale: "ru-RU",
    timezoneId: "Europe/Minsk",
    reducedMotion: "reduce",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.01,
      threshold: 0.2,
    },
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 4173 --strictPort",
    url: baseURL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
