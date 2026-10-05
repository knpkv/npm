import { defineConfig } from "vitest/config"
import { workspaceSourceAlias } from "../../vitest.workspace-sources.ts"

export default defineConfig({
  resolve: { alias: [...workspaceSourceAlias] },
  test: {
    include: ["test/**/*.test.ts"]
  }
})
