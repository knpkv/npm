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
    // A fixed zone with daylight saving, because several of these tests are *about* transition days
    // and a zone is not something a test can choose after the process has started. In UTC the
    // DST cases passed with the bug reinstated — they were asserting on ordinary 24-hour days. This
    // zone's transitions (March and November) are the dates those tests use.
    env: { TZ: "America/New_York" },
    testTimeout: 30000,
    hookTimeout: 30000,
    teardownTimeout: 30000
  }
})
