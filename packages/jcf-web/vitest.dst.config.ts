import { defineConfig } from "vitest/config"
import { workspaceSourceAlias } from "../../vitest.workspace-sources.ts"

/** A separate worker owns the transition timezone; other suites keep their configured clocks. */
export default defineConfig({
  resolve: { alias: [...workspaceSourceAlias] },
  test: {
    name: "@knpkv/jcf-web-dst",
    include: ["test/confirmDst.test.ts"],
    environment: "node",
    env: { TZ: "Europe/Berlin" },
    pool: "forks",
    maxWorkers: 1
  }
})
