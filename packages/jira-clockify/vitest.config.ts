import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "@knpkv/atlassian-common/auth": new URL("../atlassian-common/src/auth/index.ts", import.meta.url).pathname,
      "@knpkv/atlassian-common/config": new URL("../atlassian-common/src/config/index.ts", import.meta.url).pathname,
      "@knpkv/clockify-api-client": new URL("../clockify-api-client/src/index.ts", import.meta.url).pathname,
      "@knpkv/jira-api-client": new URL("../jira-api-client/src/index.ts", import.meta.url).pathname,
      "@knpkv/jira-cli/JiraAuth": new URL("../jira-cli/src/JiraAuth.ts", import.meta.url).pathname
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
