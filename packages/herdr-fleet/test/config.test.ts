import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfiguration } from "../src/config.js"

describe("fleet configuration", () => {
  it.layer(NodeServices.layer)((it) => {
    // A first run has no configuration file: the error says where it was looked for and what to do,
    // in one line, instead of a platform error dump.
    it.effect("names the missing file and the fix when there is no configuration", () =>
      Effect.gen(function*() {
        const directory = mkdtempSync(join(tmpdir(), "fleet-config-"))
        const path = join(directory, "config.json")
        const error = yield* loadConfiguration(path).pipe(Effect.flip)
        rmSync(directory, { recursive: true, force: true })
        expect(error.detail).toBe(
          `no fleet configuration at ${path}; create it, or set FLEET_CONFIG_PATH to an existing file`
        )
      }))
  })
})
