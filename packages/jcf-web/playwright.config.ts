import { defineConfig } from "@playwright/test"
import { join } from "node:path"
import { keepLastRunAt, playwrightPort, pruneStaleRunDirectories } from "../../playwright-ports.ts"

// A free port per run, so this suite can run beside another copy of itself or another lane's server.
const port = await playwrightPort("PLAYWRIGHT_JCF_WEB_PORT")
const origin = `http://127.0.0.1:${port}`
keepLastRunAt(join(import.meta.dirname, "test-results", "jcf-web.last-run.json"))
pruneStaleRunDirectories(join(import.meta.dirname, "test-results"), "jcf-web-", 24 * 60 * 60 * 1_000, Date.now())

export default defineConfig({
  testDir: "test/browser",
  // Per-run, so a concurrent copy never shares trace or screenshot files.
  outputDir: `test-results/jcf-web-${port}`,
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  use: {
    baseURL: origin,
    storageState: {
      cookies: [],
      origins: [{
        origin,
        localStorage: [{ name: "jcf_web_week", value: "2026-09-07" }]
      }]
    },
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
    screenshot: "only-on-failure"
  },
  webServer: {
    command: "node --import tsx test/browser/server.ts",
    env: { JCF_WEB_BROWSER_PORT: String(port) },
    url: origin,
    reuseExistingServer: false
  },
  reporter: "list"
})
