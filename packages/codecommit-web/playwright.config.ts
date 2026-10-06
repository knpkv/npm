import { defineConfig } from "@playwright/test"
import { playwrightPort } from "../../playwright-ports.ts"

// A free port per run, so this suite can run beside another copy of itself.
const port = await playwrightPort("PLAYWRIGHT_CODECOMMIT_WEB_PORT")
const origin = `http://127.0.0.1:${port}`

export default defineConfig({
  expect: {
    timeout: 5_000
  },
  forbidOnly: true,
  fullyParallel: false,
  // Per-run, so a concurrent copy never shares trace or screenshot files.
  outputDir: `test-results/codecommit-web-${port}`,
  reporter: "list",
  retries: 0,
  testDir: "e2e",
  timeout: 20_000,
  use: {
    baseURL: origin,
    colorScheme: "light",
    contextOptions: {
      reducedMotion: "reduce"
    },
    locale: "en-US",
    screenshot: "off",
    trace: "off"
  },
  webServer: {
    command: `pnpm exec vite preview --host 127.0.0.1 --port ${port} --strictPort`,
    gracefulShutdown: { signal: "SIGTERM", timeout: 1_000 },
    reuseExistingServer: false,
    stderr: "pipe",
    stdout: "ignore",
    timeout: 30_000,
    url: origin
  },
  workers: 1
})
