import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/agent/pr-review-sandbox-real.test.ts"],
    testTimeout: 180_000
  }
})
