/** Built-product canvas capability, independent of design reference states. @module */
import { Effect, FileSystem, Path } from "effect"
import type { Inventory } from "../../../design-conformance/src/schema.js"
import { RunnerFailure } from "../../../design-conformance/src/schema.js"
import { CANVAS_REFERENCE, CanvasState } from "./canvas-fixtures.js"

export const canvasRoute = (): string => {
  const query = new URLSearchParams({ filter: "open", search: "", offset: "0", ref: CANVAS_REFERENCE, view: "canvas" })
  return `/?${query}#code/pull-requests`
}

export const canvasInventory = (): Inventory => {
  const states = CanvasState.literals.map((state) => ({
    screen: "review-canvas",
    state,
    route: canvasRoute(),
    viewports: [360, 390, 1280],
    // The Hub has one, dark, theme; its shell sets data-rly-theme="dark".
    themes: ["dark"]
  } satisfies Inventory["states"][number]))
  return { routes: [canvasRoute()], states }
}

/** A checkout from before the canvas has neither its host contract nor its view. A partial build is refused. */
export const readCanvasCapability = Effect.fn("CanvasConformance.readCanvasCapability")(
  function*(repository: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const approval = yield* fs.readFileString(path.join(repository, "packages/herdr-hub/dist/approval.js"))
    const contract = yield* fs.readFileString(
      path.join(repository, "packages/codecommit-web/dist/dts/host-contract.d.ts")
    )
    const markers = [approval.includes("data-review-canvas"), /export declare const CodeCanvasResult\b/u.test(contract)]
    if (markers.every(Boolean)) return "canvas"
    if (markers.every((present) => !present)) return "legacy"
    return yield* new RunnerFailure({ detail: "Built canvas UI and host contract disagree" })
  },
  Effect.mapError((cause) =>
    cause._tag === "RunnerFailure"
      ? cause
      : new RunnerFailure({ detail: `Cannot inspect required Code product build: ${cause.message}` })
  )
)
