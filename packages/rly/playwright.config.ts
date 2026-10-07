import { defineConfig } from "@playwright/test"
import { join } from "node:path"
import { keepLastRunAt, playwrightPort, pruneStaleRunDirectories } from "../../playwright-ports.ts"
import { COARSE_POINTER_LAUNCH_ARGS } from "./scripts/browser/coarse-pointer.js"

// A free port per run, so this suite can run beside another copy of itself;
// `pnpm storybook` and `pnpm storybook:serve` keep 6006 for people.
const port = await playwrightPort("PLAYWRIGHT_RLY_VISUAL_PORT")
const origin = `http://127.0.0.1:${port}`
keepLastRunAt(join(import.meta.dirname, "test-results", "rly-visual.last-run.json"))
pruneStaleRunDirectories(join(import.meta.dirname, "test-results"), "rly-visual-", 24 * 60 * 60 * 1_000, Date.now())

export default defineConfig({
  expect: {
    timeout: 5_000
  },
  forbidOnly: true,
  fullyParallel: false,
  // Per-run, so a concurrent copy never shares trace or screenshot files.
  outputDir: `test-results/rly-visual-${port}`,
  projects: [
    { name: "fine", testIgnore: /\.coarse\.spec\.ts$/ },
    // A touch-first device: coarse pointer, no hover (scripts/browser/coarse-pointer.ts).
    {
      name: "coarse",
      testMatch: /\.coarse\.spec\.ts$/,
      use: { launchOptions: { args: [...COARSE_POINTER_LAUNCH_ARGS] } }
    }
  ],
  reporter: "list",
  retries: 0,
  testDir: "visual",
  timeout: 20_000,
  use: {
    baseURL: origin,
    browserName: "chromium",
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
    command: `pnpm exec vite preview --outDir storybook-static --host 127.0.0.1 --port ${port} --strictPort`,
    gracefulShutdown: { signal: "SIGTERM", timeout: 1_000 },
    reuseExistingServer: false,
    stderr: "pipe",
    stdout: "ignore",
    timeout: 30_000,
    url: origin
  },
  workers: 1
})
