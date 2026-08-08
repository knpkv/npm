import { configDefaults, defineConfig } from "vitest/config"

import baseConfig from "./vitest.config.js"

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    environment: "node",
    exclude: configDefaults.exclude,
    include: ["test/integration/live-aws-probe.test.ts"],
    testTimeout: 120_000
  }
})
