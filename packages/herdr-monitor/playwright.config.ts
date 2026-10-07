import { defineConfig } from "@playwright/test"
import { join } from "node:path"
import { keepLastRunAt, playwrightPort, pruneStaleRunDirectories } from "../../playwright-ports.ts"

// A free port per run, recorded for the workers, so this suite can run beside another copy of itself.
const port = await playwrightPort("PLAYWRIGHT_HERDR_MONITOR_PORT")
keepLastRunAt(join(import.meta.dirname, "test-results", "herdr-monitor.last-run.json"))
pruneStaleRunDirectories(join(import.meta.dirname, "test-results"), "herdr-monitor-", 24 * 60 * 60 * 1_000, Date.now())

/** Synthetic keys for the local test monitor only; the server checks their shape, not their secrecy. */
export const monitorEnv = {
  MONITOR_ORIGIN: `http://127.0.0.1:${port}`,
  MONITOR_PORT: String(port),
  MONITOR_PUBLISH_TOKEN: "publish_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  MONITOR_VIEW_TOKEN: "view_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
}

export default defineConfig({
  testDir: "test/browser",
  // Per-run, so a concurrent copy never shares trace or screenshot files.
  outputDir: `test-results/herdr-monitor-${port}`,
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  use: { baseURL: monitorEnv.MONITOR_ORIGIN, reducedMotion: "reduce", screenshot: "only-on-failure" },
  webServer: {
    command: "node dist/cli.js serve",
    env: monitorEnv,
    url: monitorEnv.MONITOR_ORIGIN,
    reuseExistingServer: false
  },
  reporter: "list"
})
