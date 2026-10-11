import { env } from "node:process"
import { defineConfig, type TestUserConfig } from "vitest/config"

const isDeno = "Deno" in globalThis
const isBun = "Bun" in globalThis

const localSettings: TestUserConfig = {}
// VITEST_MAX_WORKERS and --maxWorkers override this local default.
if (!env.CI) {
  localSettings.maxWorkers = "50%"
}

export default defineConfig({
  test: {
    ...localSettings,
    projects: [
      "packages/*/vitest.config.ts",
      "packages/jcf-web/vitest.dst.config.ts",
      "packages/sql/*/vitest.config.ts",
      ...(isDeno
        ? [
          "!packages/platform-bun",
          "!packages/platform-node",
          "!packages/platform-node-shared",
          "!packages/sql/d1",
          "!packages/sql/sqlite-node"
        ]
        : []),
      ...(isBun ? ["!packages/platform-node"] : [])
    ]
  }
})
