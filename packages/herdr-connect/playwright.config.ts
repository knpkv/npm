import { defineConfig } from "@playwright/test"
import { join } from "node:path"
import { keepLastRunAt, playwrightPort, pruneStaleRunDirectories } from "../../playwright-ports.ts"

// A free port per run, so this suite can run beside another copy of itself.
const port = await playwrightPort("PLAYWRIGHT_HERDR_CONNECT_PORT")
const origin = `http://127.0.0.1:${port}`
keepLastRunAt(join(import.meta.dirname, "test-results", "herdr-connect.last-run.json"))
pruneStaleRunDirectories(join(import.meta.dirname, "test-results"), "herdr-connect-", 24 * 60 * 60 * 1_000, Date.now())

export default defineConfig({
  expect: { timeout: 2_000 },
  forbidOnly: true,
  fullyParallel: false,
  // Per-run, so a concurrent copy never shares trace or screenshot files.
  outputDir: `test-results/herdr-connect-${port}`,
  reporter: "list",
  retries: 0,
  testDir: "test/browser",
  testMatch: "**/*.spec.ts",
  timeout: 10_000,
  use: {
    baseURL: origin,
    browserName: "chromium",
    colorScheme: "dark",
    contextOptions: { reducedMotion: "reduce" },
    locale: "en-US",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    viewport: { height: 844, width: 390 }
  },
  webServer: {
    command: "pnpm exec tsx test/browser/fixture-server.ts",
    env: { CONNECT_FIXTURE_PORT: String(port), CONNECT_FIXTURE_RTT_MS: "20" },
    gracefulShutdown: { signal: "SIGTERM", timeout: 1_000 },
    reuseExistingServer: false,
    stderr: "pipe",
    stdout: "ignore",
    timeout: 60_000,
    url: origin
  },
  workers: 1
})
