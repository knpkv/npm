import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "test/browser",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: 15_000,
  use: { browserName: "chromium", trace: "off", screenshot: "off" }
})
