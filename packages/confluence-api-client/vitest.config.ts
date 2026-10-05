import { defineConfig } from "vitest/config"
import { workspaceSourceAlias } from "../../vitest.workspace-sources.ts"

export default defineConfig({
  resolve: { alias: [...workspaceSourceAlias] },
  test: {
    include: ["test/**/*.test.ts"],
    globals: true,
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 30000,
    teardownTimeout: 30000
  }
})
