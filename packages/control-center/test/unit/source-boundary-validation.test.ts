import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { inspectProductionSourceBoundaries } from "../../scripts/source-boundary-validation.js"

describe("Control Center production source-boundary validation", () => {
  it.effect("discovers forbidden imports in every supported Node module source extension", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const packageRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-boundaries-" })
      const clientRoot = path.join(packageRoot, "src", "client", "nested")
      yield* fileSystem.makeDirectory(clientRoot, { recursive: true })

      const extensions: ReadonlyArray<string> = ["mts", "cts", "mjs", "cjs"]
      for (const extension of extensions) {
        yield* fileSystem.writeFileString(
          path.join(clientRoot, `forbidden.${extension}`),
          `import "../../server/main.${extension}"`
        )
      }

      const violations = yield* inspectProductionSourceBoundaries(packageRoot)

      assert.deepStrictEqual(
        violations.map(({ sourcePath }) => sourcePath).sort(),
        extensions.map((extension) => `src/client/nested/forbidden.${extension}`).sort()
      )
      for (const violation of violations) {
        assert.strictEqual(violation.reason, "client code cannot import server code")
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))
})
