import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/relay-explain-real-smoke.test.ts"],
    testTimeout: 180_000
  }
})
