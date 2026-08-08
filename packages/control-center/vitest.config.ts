import { tmpdir } from "node:os"

import { configDefaults, defineConfig } from "vitest/config"

const temporaryDirectory = tmpdir()
const canonicalTemporaryDirectory = temporaryDirectory.startsWith("/var/folders/")
  ? `/private${temporaryDirectory}`
  : temporaryDirectory

export default defineConfig({
  test: {
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
    testTimeout: 10_000
  }
})
