import path from "node:path"
import { defineConfig } from "vitest/config"
import { workspaceSourceAlias } from "../../vitest.workspace-sources.ts"

export default defineConfig({
  resolve: { alias: [...workspaceSourceAlias, { find: "@", replacement: path.resolve(import.meta.dirname, "../codecommit-web/src/client") }] },
  test: { environment: "node", include: ["test/**/*.test.{ts,tsx}"] }
})
