import { defineConfig } from "@playwright/test"
import { captureContext } from "./src/capture.js"

export default defineConfig({
  testDir: "e2e",
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  timeout: 180_000,
  reporter: "list",
  use: { browserName: "chromium", ...captureContext }
})
