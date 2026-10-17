import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path, Result } from "effect"
import { readCanvasCapability } from "./design-conformance/canvas-inventory.js"

const capability = (bundle: string) =>
  Effect.gen(function*() {
    const reads: Array<string> = []
    const fs = FileSystem.makeNoop({
      readFileString: (path) => Effect.sync(() => reads.push(path)).pipe(Effect.as(bundle))
    })
    const result = yield* Effect.result(
      readCanvasCapability("/repo").pipe(Effect.provideService(FileSystem.FileSystem, fs))
    )
    return { reads, result }
  })

it.layer(Path.layer)("canvas capability", (it) => {
  it.effect("reads only the Hub's own build", () =>
    Effect.gen(function*() {
      const { reads, result } = yield* capability("data-review-canvas=\"\" data-code-canvas-state=\"Ready\"")
      expect(Result.isSuccess(result) ? result.success : null).toBe("canvas")
      expect(reads).toEqual(["/repo/packages/herdr-hub/dist/approval.js"])
    }))

  it.effect("calls a Hub without the canvas legacy, and refuses a build that has only one half", () =>
    Effect.gen(function*() {
      const legacy = yield* capability("no canvas here")
      expect(Result.isSuccess(legacy.result) ? legacy.result.success : null).toBe("legacy")
      const partial = yield* capability("data-review-canvas=\"\"")
      expect(Result.isFailure(partial.result) ? partial.result.failure.detail : null).toBe(
        "Built canvas view and Code canvas page disagree"
      )
    }))
})
