import { tmpdir } from "node:os"

import { configDefaults, defineConfig } from "vitest/config"

const temporaryDirectory = tmpdir()
const canonicalTemporaryDirectory = temporaryDirectory.startsWith("/var/folders/")
  ? `/private${temporaryDirectory}`
  : temporaryDirectory

export default defineConfig({
  test: {
    // Node 26 enables process-global Web Storage by default. Browser tests must
    // use jsdom's origin-scoped storage instead of Node's file-backed globals.
    execArgv: ["--no-experimental-webstorage"],
    env: {
      // macOS exposes its temporary directory through the /var compatibility
      // symlink. Persistence tests deliberately require canonical roots.
      TMPDIR: canonicalTemporaryDirectory
    },
    exclude: [
      ...configDefaults.exclude,
      "test/agent/pr-review-sandbox-real.test.ts",
      "test/integration/live-connections.test.ts",
      "test/integration/live-aws-probe.test.ts"
    ],
    include: ["test/**/*.test.{ts,tsx}"],
    // SQLite-heavy materialization suites exceed their test budgets when
    // Vitest saturates larger runners with one worker per available core.
    maxWorkers: 4,
    sequence: { groupOrder: 1 },
    testTimeout: 10_000
  }
})
