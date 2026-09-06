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
    baseURL: "http://127.0.0.1:4178",
    browserName: "chromium",
    colorScheme: "dark",
    contextOptions: { reducedMotion: "reduce" },
    locale: "en-US",
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  },
  webServer: {
    command: "pnpm exec vite --host 127.0.0.1 --port 4178 --strictPort",
    reuseExistingServer: false,
    timeout: 30_000,
    url: "http://127.0.0.1:4178/test/browser/fixture.html"
  },
  workers: 1
})
