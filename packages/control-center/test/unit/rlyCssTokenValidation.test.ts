import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { inspectRlyCssTokenWorkspace, RLY_CSS_TOKEN_SOURCE_ROOTS } from "../../scripts/rlyCssTokenValidation.js"

describe("workspace rly CSS token validation", () => {
  it.effect("scans Rly and every application consumer source tree", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rly-css-tokens-" })
      const rlySource = path.join(workspaceRoot, "packages", "rly", "src")
      const controlCenterSource = path.join(workspaceRoot, "packages", "control-center", "src")
      const codeCommitWebSource = path.join(workspaceRoot, "packages", "codecommit-web", "src")
      yield* fileSystem.makeDirectory(rlySource, { recursive: true })
      yield* fileSystem.makeDirectory(controlCenterSource, { recursive: true })
      yield* fileSystem.makeDirectory(codeCommitWebSource, { recursive: true })
      yield* fileSystem.writeFileString(
        path.join(rlySource, "EntityShell.module.css"),
        ".root { border-radius: var(--rly-radius-grouped); }"
      )
      yield* fileSystem.writeFileString(
        path.join(controlCenterSource, "Overview.module.css"),
        ".root { gap: var(--rly-space-missing); }"
      )
      yield* fileSystem.writeFileString(
        path.join(codeCommitWebSource, "Review.module.css"),
        ".valid { gap: var(--rly-space-8); } .invalid { gap: var(--rly-space-web-missing); }"
      )

      const inspection = yield* inspectRlyCssTokenWorkspace(workspaceRoot, new Set(["--rly-space-8"]))

      assert.deepStrictEqual(RLY_CSS_TOKEN_SOURCE_ROOTS, [
        "packages/codecommit-web/src",
        "packages/control-center/src",
        "packages/rly/src"
      ])
      assert.strictEqual(inspection.filesChecked, 3)
      assert.deepStrictEqual(
        inspection.violations.map(({ sourcePath, token }) => ({ sourcePath, token })),
        [
          {
            sourcePath: "packages/codecommit-web/src/Review.module.css",
            token: "--rly-space-web-missing"
          },
          {
            sourcePath: "packages/control-center/src/Overview.module.css",
            token: "--rly-space-missing"
          },
          {
            sourcePath: "packages/rly/src/EntityShell.module.css",
            token: "--rly-radius-grouped"
          }
        ]
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))
})
