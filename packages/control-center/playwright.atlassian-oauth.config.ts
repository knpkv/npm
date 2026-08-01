import { defineConfig } from "@playwright/test"

export default defineConfig({
  forbidOnly: true,
  fullyParallel: false,
  globalSetup: "./e2e/enforce-bounded-runner.ts",
  outputDir: "test-results/control-center/atlassian-oauth",
  reporter: "list",
  retries: 0,
  testDir: "e2e",
  timeout: 20_000,
  use: {
    colorScheme: "light",
    contextOptions: { reducedMotion: "reduce" },
    screenshot: "off",
    trace: "off",
    video: "off",
    viewport: { height: 800, width: 1280 }
  },
  workers: 1
})
