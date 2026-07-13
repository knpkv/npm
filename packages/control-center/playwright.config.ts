import { defineConfig } from "@playwright/test"

export default defineConfig({
  expect: {
    timeout: 5_000
  },
  forbidOnly: true,
  fullyParallel: false,
  globalSetup: "./e2e/enforce-bounded-runner.ts",
  outputDir: "test-results/control-center",
  reporter: "list",
  retries: 0,
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" }
    }
  ],
  testDir: "e2e",
  timeout: 20_000,
  use: {
    baseURL: "http://127.0.0.1:4173",
    colorScheme: "light",
    contextOptions: {
      reducedMotion: "reduce"
    },
    locale: "en-US",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    viewport: { height: 800, width: 1280 }
  },
  webServer: {
    command: "pnpm preview",
    gracefulShutdown: { signal: "SIGTERM", timeout: 1_000 },
    reuseExistingServer: false,
    stderr: "pipe",
    stdout: "ignore",
    timeout: 30_000,
    url: "http://127.0.0.1:4173"
  },
  workers: 1
})
