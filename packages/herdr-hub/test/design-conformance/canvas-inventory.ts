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

/**
 * A checkout from before the canvas has neither the canvas view nor the Code page that mounts it. Both are read from
 * the Hub's own built bundle, so the inventory depends only on this package's build. A partial build is refused.
 */
export const readCanvasCapability = Effect.fn("CanvasConformance.readCanvasCapability")(
  function*(repository: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const approval = yield* fs.readFileString(path.join(repository, "packages/herdr-hub/dist/approval.js"))
    const markers = [approval.includes("data-review-canvas"), approval.includes("data-code-canvas-state")]
    if (markers.every(Boolean)) return "canvas"
    if (markers.every((present) => !present)) return "legacy"
    return yield* new RunnerFailure({ detail: "Built canvas view and Code canvas page disagree" })
  },
  Effect.mapError((cause) =>
    cause._tag === "RunnerFailure"
      ? cause
      : new RunnerFailure({ detail: `Cannot inspect required Hub build: ${cause.message}` })
  )
)
