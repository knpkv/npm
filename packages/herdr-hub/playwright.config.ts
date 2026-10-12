import { defineConfig } from "@playwright/test"
import { join } from "node:path"
import {
  keepLastRunAt,
  playwrightLaunchEnvironment,
  playwrightPort,
  pruneStaleRunDirectories
} from "../../playwright-ports.ts"

const port = await playwrightPort("PLAYWRIGHT_HERDR_HUB_PORT")
const origin = `http://127.0.0.1:${port}`
keepLastRunAt(join(import.meta.dirname, "test-results", "herdr-hub.last-run.json"))
pruneStaleRunDirectories(join(import.meta.dirname, "test-results"), "herdr-hub-", 24 * 60 * 60 * 1_000, Date.now())

export default defineConfig({
  expect: { timeout: 2_000 },
  forbidOnly: true,
  fullyParallel: false,
  outputDir: `test-results/herdr-hub-${port}`,
  // Headless native time editors read the OS locale independently of the context locale.
  projects: [
    { name: "", testIgnore: "**/connect-controls.spec.ts" },
    {
      name: "connect-controls-24h",
      testMatch: "**/connect-controls.spec.ts",
      grepInvert: /12-hour locale/,
      use: {
        launchOptions: {
          args: ["--lang=en-GB"],
          env: { ...playwrightLaunchEnvironment(), LANG: "en_GB.UTF-8", LC_ALL: "en_GB.UTF-8" }
        }
      }
    },
    {
      name: "connect-controls-12h",
      testMatch: "**/connect-controls.spec.ts",
      grep: /12-hour locale/,
      use: {
        launchOptions: {
          args: ["--lang=en-US"],
          env: { ...playwrightLaunchEnvironment(), LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" }
        }
      }
    }
  ],
  reporter: "list",
  retries: 0,
  testDir: "test/browser",
  testMatch: "**/*.spec.ts",
  timeout: 15_000,
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
    env: { APPROVALS_FIXTURE_PORT: String(port) },
    gracefulShutdown: { signal: "SIGTERM", timeout: 1_000 },
    reuseExistingServer: false,
    stderr: "pipe",
    stdout: "ignore",
    timeout: 60_000,
    url: origin
  },
  workers: 1
})
