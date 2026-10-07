import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "test/browser",
  outputDir: "test-results",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  use: { reducedMotion: "reduce", screenshot: "only-on-failure" },
  reporter: "list"
})
