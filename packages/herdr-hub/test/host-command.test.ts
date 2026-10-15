import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { makeHostCommand } from "../src/internal/host-command.js"

describe("host Git repository isolation", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("clears every repository-local variable Git names while preserving the host environment", () =>
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const command = makeHostCommand("git", ["rev-parse", "--local-env-vars"])
        const variables = yield* spawner.lines(command)
        expect(variables).toContain("GIT_DIR")
        expect(variables).toContain("GIT_INDEX_FILE")
        expect(command.options.extendEnv).toBe(true)
        for (const variable of variables) {
          expect(Object.hasOwn(command.options.env ?? {}, variable), variable).toBe(true)
          expect(command.options.env?.[variable], variable).toBeUndefined()
        }
      }))
  })
})
