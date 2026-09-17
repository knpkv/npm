import { defineConfig } from "@playwright/test"

export default defineConfig({
  expect: { timeout: 2_000 },
  forbidOnly: true,
  fullyParallel: false,
  outputDir: "test-results/browser",
  reporter: "list",
  retries: 0,
  testDir: "test/browser",
  timeout: 10_000,
  use: {
    browserName: "chromium",
    colorScheme: "dark",
    contextOptions: { reducedMotion: "reduce" },
    locale: "en-US",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    viewport: { height: 844, width: 390 }
  },
  workers: 1
})
