import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "test/browser",
  outputDir: "test-results",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  use: {
    baseURL: "http://127.0.0.1:4179",
    storageState: {
      cookies: [],
      origins: [{
        origin: "http://127.0.0.1:4179",
        localStorage: [{ name: "jcf_web_week", value: "2026-09-07" }]
      }]
    },
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
    screenshot: "only-on-failure"
  },
  webServer: {
    command: "node --import tsx test/browser/server.ts",
    url: "http://127.0.0.1:4179",
    reuseExistingServer: false
  },
  reporter: "list"
})
