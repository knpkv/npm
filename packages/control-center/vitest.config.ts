import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      "test/agent/pr-review-sandbox-real.test.ts",
      "test/integration/live-connections.test.ts",
      "test/integration/live-aws-probe.test.ts"
    ],
    include: ["test/**/*.test.{ts,tsx}"],
    testTimeout: 10_000
  }
})
