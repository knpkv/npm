import { defineConfig } from "vitest/config"
import { workspaceSourceAlias } from "../../vitest.workspace-sources.ts"

export default defineConfig({
  resolve: {
    alias: [...workspaceSourceAlias]
  },
  test: {
    include: ["test/integration.test.ts"],
    globals: true,
    environment: "node",
    testTimeout: 60000,
    hookTimeout: 60000,
    teardownTimeout: 60000
  }
})
