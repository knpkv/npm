/** Opt-in real-socket walk; the default suites match *.spec.ts only. */
import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: ".",
  testMatch: "terminal-control.walk.ts",
  outputDir: "../../test-results/terminal-walk",
  fullyParallel: false,
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  use: {
    browserName: "chromium",
    reducedMotion: "reduce",
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure"
  }
})
