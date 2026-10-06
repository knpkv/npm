import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import { loadConfiguration } from "../src/config.js"

describe("fleet configuration", () => {
  it.layer(NodeServices.layer)((it) => {
    // A first run has no configuration file: the error says where it was looked for and what to do,
    // in one line, instead of a platform error dump.
    it.effect("names the missing file and the fix when there is no configuration", () =>
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        // Removed when the test's scope closes, whether or not the assertion passes.
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fleet-config-" })
        const file = path.join(directory, "config.json")
        const error = yield* loadConfiguration(file).pipe(Effect.flip)
        expect(error.detail).toBe(
          `no fleet configuration at ${file}; create it, or set FLEET_CONFIG_PATH to an existing file`
        )
      }).pipe(Effect.scoped))
  })
})
