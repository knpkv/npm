import { defineConfig } from "vitest/config"
import { workspaceSourceAlias } from "../../vitest.workspace-sources.ts"

export default defineConfig({
  resolve: {
    alias: [...workspaceSourceAlias]
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
