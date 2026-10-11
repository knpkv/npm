import { defineConfig } from "@playwright/test"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import { resolve } from "node:path"

const base = Effect.runSync(Config.NonEmptyString("CC_VISUAL_BASE"))

export default defineConfig({
  testDir: ".",
  testMatch: "compare.spec.ts",
  outputDir: "../../test-results/visual/compare",
  snapshotPathTemplate: `${resolve(base)}/{arg}{ext}`,
  updateSnapshots: "none",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [["list"], ["./compareReporter.ts"]],
  expect: { toMatchSnapshot: { maxDiffPixelRatio: 0.001 } }
})
