import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { inspectRlyCssTokenWorkspace } from "../../scripts/rlyCssTokenValidation.js"

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
      // A consumer nobody listed is still scanned; a package without src is skipped.
      const herdrSource = path.join(workspaceRoot, "packages", "herdr-hub", "src")
      yield* fileSystem.makeDirectory(herdrSource, { recursive: true })
      yield* fileSystem.makeDirectory(path.join(workspaceRoot, "packages", "no-source"), { recursive: true })
      yield* fileSystem.writeFileString(path.join(workspaceRoot, "packages", "notes.md"), "not a package")
      // A directory without a package.json is not a package, even with a src tree.
      const strayCss = path.join(workspaceRoot, "packages", "not-a-package", "src")
      yield* fileSystem.makeDirectory(strayCss, { recursive: true })
      yield* fileSystem.writeFileString(path.join(strayCss, "stray.css"), ".x { gap: var(--rly-space-stray); }")
      for (const name of ["rly", "control-center", "codecommit-web", "herdr-hub"]) {
        yield* fileSystem.writeFileString(path.join(workspaceRoot, "packages", name, "package.json"), "{}")
      }
      yield* fileSystem.writeFileString(
        path.join(herdrSource, "styles.css"),
        ".chip { padding-inline: var(--rly-space-10); }"
      )
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

      assert.strictEqual(inspection.sourceRootsChecked, 4)
      assert.strictEqual(inspection.filesChecked, 4)
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
            sourcePath: "packages/herdr-hub/src/styles.css",
            token: "--rly-space-10"
          },
          {
            sourcePath: "packages/rly/src/EntityShell.module.css",
            token: "--rly-radius-grouped"
          }
        ]
      )
    }).pipe(
      // The test runner is the resource-lifetime boundary for the temporary workspace.
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(NodeServices.layer),
      Effect.scoped
    ))
})
