import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { runCheckedCommand } from "../scripts/checked-command.js"

describe("runCheckedCommand", () => {
  it.effect("succeeds for a zero exit code", () =>
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      yield* runCheckedCommand(spawner, "node", ["-e", ""], ".")
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("fails for a non-zero exit code", () =>
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const error = yield* runCheckedCommand(spawner, "node", ["-e", "process.exit(23)"], ".").pipe(
        Effect.flip
      )

      assert.strictEqual(error.reason, "node -e process.exit(23) exited with code 23")
    }).pipe(Effect.provide(NodeServices.layer)))
})
