import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"

import { disposeFailedFixtureSetup, protectPartialFixtureAllocation } from "../../e2e/realRuntimeLifecycle.js"

describe("real runtime fixture lifecycle", () => {
  it.effect("removes a partial fixture when allocation fails", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const dataRoot = yield* fileSystem.makeTempDirectory({ prefix: "control-center-partial-fixture-" })
      const allocationFailure = new Error("injected allocation failure")

      const failure = yield* Effect.flip(
        protectPartialFixtureAllocation(
          Effect.fail(allocationFailure),
          fileSystem.remove(dataRoot, { force: true, recursive: true })
        )
      )

      expect(failure).toBe(allocationFailure)
      expect(yield* fileSystem.exists(dataRoot)).toBe(false)
    }).pipe(Effect.provide(NodeServices.layer)))

  it("preserves allocation and cleanup failures across the Promise boundary", async () => {
    const allocationFailure = new Error("allocation failed")
    const cleanupFailure = new Error("cleanup failed")

    await expect(
      Effect.runPromise(
        protectPartialFixtureAllocation(
          Effect.fail(allocationFailure),
          Effect.fail(cleanupFailure)
        )
      )
    ).rejects.toMatchObject({ errors: [allocationFailure, cleanupFailure] })
  })

  it("preserves setup and cleanup failures together", async () => {
    const setupFailure = new Error("setup failed")
    const cleanupFailure = new Error("cleanup failed")

    await expect(
      disposeFailedFixtureSetup(setupFailure, () => Promise.reject(cleanupFailure))
    ).rejects.toMatchObject({
      errors: [setupFailure, cleanupFailure]
    })
  })

  it("rethrows the setup failure when cleanup succeeds", async () => {
    const setupFailure = new Error("setup failed")
    await expect(disposeFailedFixtureSetup(setupFailure, () => Promise.resolve())).rejects.toBe(setupFailure)
  })
})
