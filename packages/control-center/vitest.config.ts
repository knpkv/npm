import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    exclude: ["test/agent/pr-review-sandbox-real.test.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
    testTimeout: 10_000
  }
})
