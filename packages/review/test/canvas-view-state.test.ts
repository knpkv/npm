import { describe, expect, it } from "vitest"
import { canvasFiles, readingOrder } from "../src/canvas/derive.js"
import type { CanvasGraph } from "../src/canvas/model.js"
import {
  canvasKeyCommand,
  type CanvasWorld,
  initialCanvasView,
  makeCanvasWorld,
  reduceCanvasView
} from "../src/canvas/view-state.js"
import { sampleContext, sampleFindings, sampleGraph } from "./canvas-fixture.js"

const world: CanvasWorld = makeCanvasWorld(sampleGraph, sampleContext, sampleFindings)
const start = initialCanvasView(world)

describe("canvas view state", () => {
  it("starts at the overview, focused on the first file to read", () => {
    const files = canvasFiles(sampleGraph, sampleContext, sampleFindings)
    expect(start).toEqual({
      level: "overview",
      focus: readingOrder(files, sampleContext.readingPath)[0],
      part: null,
      keyboard: false,
      panel: "canvas"
    })
  })

  it("zooms in from the overview to the cluster, file and the pinned part's diff", () => {
    const cluster = reduceCanvasView(world, start, { _tag: "ZoomIn" })
    expect(cluster.level).toBe("cluster")
    const file = reduceCanvasView(world, cluster, { _tag: "ZoomIn" })
    expect(file).toMatchObject({ level: "file", focus: "sync-worker/socket.ts", part: "connect()" })
    const diff = reduceCanvasView(world, file, { _tag: "ZoomIn" })
    expect(diff).toMatchObject({ level: "diff", part: "connect()" })
    expect(reduceCanvasView(world, diff, { _tag: "ZoomIn" })).toEqual(diff)
  })

  it("zooms out one level at a time and fits back to the overview", () => {
    const diff = [1, 2, 3].reduce((state) => reduceCanvasView(world, state, { _tag: "ZoomIn" }), start)
    expect(reduceCanvasView(world, diff, { _tag: "ZoomOut" }).level).toBe("file")
    expect(reduceCanvasView(world, diff, { _tag: "Fit" })).toMatchObject({ level: "overview", part: null })
    expect(reduceCanvasView(world, start, { _tag: "ZoomOut" })).toEqual(start)
  })

  it("moves the focus along an edge with the arrow keys", () => {
    const up = reduceCanvasView(world, start, { _tag: "Move", arrow: "up" })
    expect(up.focus).toBe("sync-worker/worker.ts")
    expect(reduceCanvasView(world, start, { _tag: "Move", arrow: "left" }).focus).toBe("stage/reconnect.ts")
  })

  it("keeps the focus when no edge leads that way", () => {
    const lonely: CanvasGraph = { ...sampleGraph, dependencies: { _tag: "Recorded", edges: [] } }
    const quiet = makeCanvasWorld(lonely, sampleContext, sampleFindings)
    const initial = initialCanvasView(quiet)
    expect(reduceCanvasView(quiet, initial, { _tag: "Move", arrow: "up" })).toEqual(initial)
  })

  it("walks a file's parts with up and down", () => {
    const file = reduceCanvasView(world, start, { _tag: "Level", level: "file" })
    const down = reduceCanvasView(world, file, { _tag: "Move", arrow: "down" })
    expect(down.part).toBe("onMessage()")
    expect(reduceCanvasView(world, down, { _tag: "Move", arrow: "up" }).part).toBe("connect()")
  })

  it("does not zoom while the map is building", () => {
    const building = { ...world, ready: false }
    expect(reduceCanvasView(building, start, { _tag: "ZoomIn" })).toEqual(start)
    expect(reduceCanvasView(building, start, { _tag: "Level", level: "diff" })).toEqual(start)
  })

  it("switches between the canvas and the Files list without losing the place", () => {
    const file = reduceCanvasView(world, start, { _tag: "Level", level: "file" })
    const list = reduceCanvasView(world, file, { _tag: "TogglePanel" })
    expect(list).toMatchObject({ panel: "files", level: "file", focus: file.focus })
    expect(reduceCanvasView(world, list, { _tag: "TogglePanel" }).panel).toBe("canvas")
  })
})

describe("canvasKeyCommand", () => {
  it("maps the documented keys", () => {
    expect(canvasKeyCommand("ArrowUp")).toEqual({ _tag: "Move", arrow: "up" })
    expect(canvasKeyCommand("Enter")).toEqual({ _tag: "ZoomIn" })
    expect(canvasKeyCommand("+")).toEqual({ _tag: "ZoomIn" })
    expect(canvasKeyCommand("Escape")).toEqual({ _tag: "ZoomOut" })
    expect(canvasKeyCommand("-")).toEqual({ _tag: "ZoomOut" })
    expect(canvasKeyCommand("f")).toEqual({ _tag: "Fit" })
    expect(canvasKeyCommand("l")).toEqual({ _tag: "TogglePanel" })
    expect(canvasKeyCommand("1")).toEqual({ _tag: "Level", level: "overview" })
    expect(canvasKeyCommand("4")).toEqual({ _tag: "Level", level: "diff" })
    expect(canvasKeyCommand("/")).toEqual({ _tag: "Search" })
  })

  it("leaves other keys to the page", () => {
    expect(canvasKeyCommand("k")).toBeNull()
    expect(canvasKeyCommand("Tab")).toBeNull()
  })
})
