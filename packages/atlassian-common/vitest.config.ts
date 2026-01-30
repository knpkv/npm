import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globals: true,
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 30000,
    teardownTimeout: 30000
  }
})
