import { defineConfig } from "@playwright/test"

export default defineConfig({
  expect: {
    timeout: 5_000
  },
  forbidOnly: true,
  fullyParallel: false,
  outputDir: "test-results/rly-visual",
  projects: [
    { name: "fine", testIgnore: /\.coarse\.spec\.ts$/ },
    // Blink pointer type 2 is coarse: the browser reports a touch-first device to `(pointer: coarse)`.
    {
      name: "coarse",
      testMatch: /\.coarse\.spec\.ts$/,
      use: { launchOptions: { args: ["--blink-settings=primaryPointerType=2,availablePointerTypes=2"] } }
    }
  ],
  reporter: "list",
  retries: 0,
  testDir: "visual",
  timeout: 20_000,
  use: {
    baseURL: "http://127.0.0.1:6006",
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
    command: "pnpm storybook:serve",
    gracefulShutdown: { signal: "SIGTERM", timeout: 1_000 },
    reuseExistingServer: false,
    stderr: "pipe",
    stdout: "ignore",
    timeout: 30_000,
    url: "http://127.0.0.1:6006"
  },
  workers: 1
})
