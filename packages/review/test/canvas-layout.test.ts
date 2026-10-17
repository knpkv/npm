import { describe, expect, it } from "vitest"
import { canvasFiles } from "../src/canvas/derive.js"
import {
  CANVAS_MINIMAP,
  CANVAS_WIDTH,
  canvasNodeHeight,
  clusterOf,
  layoutCluster,
  layoutDiff,
  layoutFile,
  layoutOverview,
  type Rect
} from "../src/canvas/layout.js"
import type { CanvasGraph, CanvasPart } from "../src/canvas/model.js"
import { noContext, sampleContext, sampleFindings, sampleGraph } from "./canvas-fixture.js"

const overlaps = (left: Rect, right: Rect): boolean =>
  left.x < right.x + right.w && right.x < left.x + left.w && left.y < right.y + right.h && right.y < left.y + left.h
const inside = (inner: Rect, outer: Rect): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w &&
  inner.y + inner.h <= outer.y + outer.h
const pairs = <A>(items: ReadonlyArray<A>): ReadonlyArray<readonly [A, A]> =>
  items.flatMap((left, index) => items.slice(index + 1).map((right): readonly [A, A] => [left, right]))

const files = canvasFiles(sampleGraph, sampleContext, sampleFindings)

describe("overview layout", () => {
  const scene = layoutOverview(sampleGraph, files)

  it("places every file once, without overlaps", () => {
    expect(scene.nodes.map((node) => node.path).sort()).toEqual(files.map((file) => file.path).sort())
    expect(pairs(scene.nodes).filter(([left, right]) => overlaps(left, right))).toEqual([])
  })

  it("keeps each file inside its module region and its partition band", () => {
    for (const node of scene.nodes) {
      const file = files.find((entry) => entry.path === node.path)
      const region = scene.regions.find((entry) => entry.id === file?.module)
      expect(region !== undefined && inside(node, region)).toBe(true)
      if (file?.partition !== null) {
        const band = scene.bands.find((entry) => entry.id === file?.partition)
        expect(band !== undefined && inside(node, band)).toBe(true)
      }
    }
  })

  it("does not overlap module regions or partition bands", () => {
    expect(pairs(scene.regions).filter(([left, right]) => overlaps(left, right))).toEqual([])
    expect(pairs(scene.bands).filter(([left, right]) => overlaps(left, right))).toEqual([])
  })

  it("draws one line per connected pair, dashed only for moves", () => {
    expect(scene.lines).toHaveLength(13)
    expect(scene.lines.filter((line) => line.dash).map((line) => [line.from, line.to])).toEqual([
      ["stage/reconnect.ts", "sync-worker/socket.ts"]
    ])
  })

  it("is the same picture for the same change on a later head", () => {
    expect(layoutOverview({ ...sampleGraph, headRevision: "f00ba11" }, files)).toEqual(scene)
  })

  it("sizes boxes by their marks", () => {
    const socketTest = scene.nodes.find((node) => node.path === "tests/socket.test.ts")
    expect(socketTest?.h).toBe(canvasNodeHeight(2))
  })

  it("lays out by module only when dependency data is missing", () => {
    const graph: CanvasGraph = { ...sampleGraph, dependencies: { _tag: "NotRecorded", language: "TypeScript" } }
    const modules = layoutOverview(graph, canvasFiles(graph, sampleContext, sampleFindings))
    expect(modules.mode).toBe("modules")
    expect(modules.bands).toEqual([])
    expect(modules.lines).toEqual([])
    expect(modules.regions.map((region) => region.id)).toEqual(["stage", "sync-worker", "composer", "tests"])
    expect(pairs(modules.nodes).filter(([left, right]) => overlaps(left, right))).toEqual([])
    expect(new Set(modules.regions.map((region) => region.h)).size).toBe(1)
    // Four columns end at 1004; the frame keeps the column gap after them, so it stays the standard width.
    expect(modules.width).toBe(CANVAS_WIDTH)
  })

  it("draws edges without bands when partitions were not recorded", () => {
    const graph: CanvasGraph = { ...sampleGraph, partitions: { _tag: "NotRecorded" } }
    const plain = layoutOverview(graph, canvasFiles(graph, noContext, sampleFindings))
    expect(plain.mode).toBe("edges")
    expect(plain.bands).toEqual([])
    expect(plain.lines).toHaveLength(13)
  })
})

describe("cluster layout", () => {
  const target = clusterOf(sampleGraph, files, "sync-worker/socket.ts")

  it("zooms a partitioned file into its partition", () => {
    expect(target).toEqual({ kind: "partition", id: "A" })
  })

  it("zooms an unpartitioned file into its module", () => {
    expect(clusterOf(sampleGraph, files, "tests/socket.test.ts")).toEqual({ kind: "module", id: "tests" })
  })

  it("places the cluster's files in module columns, with stubs for edges that leave it", () => {
    const scene = layoutCluster(sampleGraph, files, target ?? { kind: "module", id: "stage" })
    expect(scene.boxes.map((box) => box.path)).toEqual([
      "stage/useStageSocket.ts",
      "stage/StageProvider.tsx",
      "stage/reconnect.ts",
      "sync-worker/worker.ts",
      "sync-worker/protocol.ts",
      "sync-worker/socket.ts"
    ])
    expect(scene.stubs.map((stub) => stub.path).sort()).toEqual([
      "sync-worker/drafts.ts",
      "tests/reconnect.test.ts",
      "tests/socket.test.ts"
    ])
    expect(pairs([...scene.boxes, ...scene.stubs]).filter(([left, right]) => overlaps(left, right))).toEqual([])
    expect(scene.band?.id).toBe("A")
  })

  it("labels an outside file in another partition with its partition", () => {
    const scene = layoutCluster(sampleGraph, files, { kind: "partition", id: "A" })
    expect(scene.stubs.find((stub) => stub.path === "sync-worker/drafts.ts")?.label).toBe("drafts.ts, in B")
    expect(scene.stubs.find((stub) => stub.path === "tests/socket.test.ts")?.label).toBe("tests/socket.test.ts")
  })

  it("keeps every stub clear of the minimap in the bottom-right corner", () => {
    // Parts on worker.ts and protocol.ts push socket.ts, and the stubs leaving it, down towards the minimap.
    const added = (name: string, index: number): CanvasPart => ({
      name,
      kind: "added",
      movedPath: null,
      lines: { start: 1 + index * 10, end: 9 + index * 10 },
      added: 9,
      removed: 0
    })
    const withParts =
      (path: string, names: ReadonlyArray<string>) =>
      (entry: CanvasGraph["files"][number]): CanvasGraph["files"][number] =>
        entry.path !== path ? entry : { ...entry, parts: { _tag: "Recorded", items: names.map(added) } }
    const graph: CanvasGraph = {
      ...sampleGraph,
      files: sampleGraph.files
        .map(withParts("sync-worker/worker.ts", ["onconnect()", "routeFrame()"]))
        .map(withParts("sync-worker/protocol.ts", ["FrameType"]))
    }
    const scene = layoutCluster(graph, canvasFiles(graph, sampleContext, sampleFindings), {
      kind: "partition",
      id: "A"
    })
    const minimap = {
      x: scene.width - CANVAS_MINIMAP.inset - CANVAS_MINIMAP.w,
      y: scene.height - CANVAS_MINIMAP.inset - CANVAS_MINIMAP.h,
      w: CANVAS_MINIMAP.w,
      h: CANVAS_MINIMAP.h
    }
    expect(scene.stubs.filter((stub) => overlaps(stub, minimap)).map((stub) => stub.path)).toEqual([])
  })
})

describe("file layout", () => {
  const scene = layoutFile(sampleGraph, files, sampleFindings, "sync-worker/socket.ts")

  it("lists parts by line, the file's imports and types last", () => {
    expect(scene.rows.map((row) => row.part.name)).toEqual([
      "connect()",
      "onMessage()",
      "reconnect()",
      "close()",
      "imports and types"
    ])
  })

  it("pins the most severe finding under its part", () => {
    expect(scene.card).toEqual({ row: 0, finding: "F1" })
  })

  it("sizes the box to its content and its 2px border", () => {
    // Header 48, five rows of 44, the pinned card 128, 6 below the last row, and the border top and bottom.
    expect(scene.box.h).toBe(48 + 5 * 44 + 128 + 6 + 4)
  })

  it("puts callers on the left and callees on the right, without overlaps", () => {
    expect(scene.callers.map((stub) => stub.path)).toEqual([
      "sync-worker/worker.ts",
      "stage/reconnect.ts",
      "tests/socket.test.ts"
    ])
    expect(scene.callees.map((stub) => stub.path)).toEqual(["sync-worker/drafts.ts"])
    expect(pairs([scene.box, ...scene.callers, ...scene.callees]).filter(([left, right]) => overlaps(left, right)))
      .toEqual([])
  })
})

describe("diff layout", () => {
  it("frames the part's head lines with its neighbours at the edges", () => {
    const scene = layoutDiff(sampleGraph, files, sampleFindings, "sync-worker/socket.ts", "connect()")
    expect(scene.lines).toEqual({ start: 14, end: 59 })
    expect(scene.cards).toEqual([{ after: 16, finding: "F1" }])
    expect(scene.next).toBe("onMessage()")
    expect(scene.left.map((stub) => stub.path)).toEqual([
      "sync-worker/worker.ts",
      "stage/reconnect.ts",
      "tests/socket.test.ts"
    ])
  })

  it("names the part after the one shown as next, also when the requested part is unknown", () => {
    const scene = layoutDiff(sampleGraph, files, sampleFindings, "sync-worker/socket.ts", "")
    expect(scene.part.name).toBe("connect()")
    expect(scene.next).toBe("onMessage()")
  })

  it("keeps many neighbours of a short part inside the scene and points them at the box", () => {
    const callers = [
      "stage/useStageSocket.ts",
      "stage/StageProvider.tsx",
      "stage/reconnect.ts",
      "sync-worker/worker.ts",
      "sync-worker/protocol.ts",
      "tests/drafts.test.ts"
    ]
    const graph: CanvasGraph = {
      ...sampleGraph,
      dependencies: {
        _tag: "Recorded",
        edges: callers.map((from) => ({
          from,
          to: "composer/draftStore.ts",
          relation: "imports",
          fromPart: null,
          toPart: null
        }))
      }
    }
    const scene = layoutDiff(graph, canvasFiles(graph, sampleContext, sampleFindings), [], "composer/draftStore.ts", "")
    expect(scene.left).toHaveLength(6)
    expect(scene.left.filter((stub) => stub.y + stub.h > scene.height)).toEqual([])
    const boxEdge = scene.links.filter((link) => link.x2 === scene.box.x)
    expect(boxEdge.filter((link) => link.y2 < scene.box.y || link.y2 > scene.box.y + scene.box.h)).toEqual([])
  })
})
