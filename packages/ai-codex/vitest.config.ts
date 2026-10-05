import { defineConfig } from "vitest/config"
import { workspaceSourceAlias } from "../../vitest.workspace-sources.ts"

export default defineConfig({
  resolve: { alias: [...workspaceSourceAlias] },
  test: {
    environment: "node",
    exclude: ["test/real-smoke.test.ts"],
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000
  }
})
