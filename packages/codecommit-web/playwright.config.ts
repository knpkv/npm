import { defineConfig } from "@playwright/test"

export default defineConfig({
  expect: {
    timeout: 5_000
  },
  forbidOnly: true,
  fullyParallel: false,
  outputDir: "test-results/codecommit-web",
  reporter: "list",
  retries: 0,
  testDir: "e2e",
  timeout: 20_000,
  use: {
    baseURL: "http://127.0.0.1:4174",
    colorScheme: "light",
    contextOptions: {
      reducedMotion: "reduce"
    },
    locale: "en-US",
    screenshot: "off",
    trace: "off"
  },
  webServer: {
    command: "pnpm exec vite preview --host 127.0.0.1 --port 4174",
    gracefulShutdown: { signal: "SIGTERM", timeout: 1_000 },
    reuseExistingServer: false,
    stderr: "pipe",
    stdout: "ignore",
    timeout: 30_000,
    url: "http://127.0.0.1:4174"
  },
  workers: 1
})
