import { defineConfig } from "vitest/config"
import { workspaceSourceAlias } from "../../vitest.workspace-sources.ts"

export default defineConfig({
  resolve: {
    alias: [...workspaceSourceAlias]
  },
  test: {
    environment: "happy-dom",
    name: "@knpkv/relay-product",
    include: ["test/**/*.test.{ts,tsx}"]
  }
})
