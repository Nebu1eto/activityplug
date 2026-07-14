import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:4173";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI === undefined ? 0 : 2,
  reporter: process.env.CI === undefined ? "list" : "html",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop-en",
      use: {
        viewport: { width: 1440, height: 1000 },
        locale: "en-US",
        contextOptions: { reducedMotion: "reduce" },
      },
    },
    {
      name: "desktop-ko",
      use: {
        viewport: { width: 1440, height: 1000 },
        locale: "ko-KR",
        contextOptions: { reducedMotion: "reduce" },
      },
    },
    {
      name: "desktop-ja",
      use: {
        viewport: { width: 1440, height: 1000 },
        locale: "ja-JP",
        contextOptions: { reducedMotion: "reduce" },
      },
    },
    {
      name: "mobile-en",
      use: {
        ...devices["iPhone 13"],
        browserName: "chromium",
        locale: "en-US",
        contextOptions: { reducedMotion: "reduce" },
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  webServer: {
    command: "pnpm build && pnpm preview --host 127.0.0.1 --port 4173",
    url: baseURL,
    reuseExistingServer: false,
  },
});
