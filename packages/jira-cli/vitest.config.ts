import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "@knpkv/jira-api-client": new URL("../jira-api-client/src/index.ts", import.meta.url).pathname
    }
  },
  test: {
    include: ["test/**/*.test.ts"],
    globals: true,
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 30000,
    teardownTimeout: 30000
  }
})
