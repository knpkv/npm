import { defineConfig } from "@playwright/test"
import { playwrightPort } from "../../playwright-ports.js"

const port = await playwrightPort("PLAYWRIGHT_SUPERAPP_PORT")
const origin = `http://127.0.0.1:${String(port)}`

export default defineConfig({
  testDir: "test/superapp-browser",
  testMatch: "**/*.spec.ts",
  outputDir: `test-results/superapp-${String(port)}`,
  fullyParallel: false,
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: 20_000,
  use: {
    baseURL: origin,
    browserName: "chromium",
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  },
  projects: [
    { name: "phone", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: "desktop", use: { viewport: { width: 1280, height: 900 } } }
  ],
  webServer: {
    command: "pnpm exec tsx test/superapp-browser/server.ts",
    url: origin,
    env: { SUPERAPP_FIXTURE_PORT: String(port) },
    reuseExistingServer: false,
    timeout: 30_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 1_000 }
  }
})
