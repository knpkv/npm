import { captureContext } from "@knpkv/design-conformance/capture"
import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "e2e/visual",
  outputDir: "test-results/control-center/visual",
  testIgnore: "compare.spec.ts",
  globalSetup: "./e2e/enforce-bounded-runner.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: "list",
  timeout: 60_000,
  expect: {
    timeout: 10_000
  },
  projects: [
    { name: "desktop-light", use: { viewport: { width: 1280, height: 800 }, colorScheme: "light" } },
    { name: "desktop-dark", use: { viewport: { width: 1280, height: 800 }, colorScheme: "dark" } },
    { name: "mobile-light", use: { viewport: { width: 390, height: 844 }, colorScheme: "light" } },
    { name: "mobile-dark", use: { viewport: { width: 390, height: 844 }, colorScheme: "dark" } }
  ],
  use: {
    browserName: "chromium",
    ...captureContext,
    screenshot: "off",
    trace: "off"
  }
})
