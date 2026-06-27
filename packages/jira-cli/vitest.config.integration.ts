import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "@knpkv/jira-api-client": new URL("../jira-api-client/src/index.ts", import.meta.url).pathname
    }
  },
  test: {
    include: ["test/integration.test.ts"],
    globals: true,
    environment: "node",
    testTimeout: 120000,
    hookTimeout: 60000,
    teardownTimeout: 60000
  }
})
