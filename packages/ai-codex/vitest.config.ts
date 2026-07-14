import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["test/real-smoke.test.ts"],
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000
  }
})
