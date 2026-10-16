import { describe, expect, it } from "vitest"
import { canvasFiles } from "../src/canvas/derive.js"
import {
  canvasNodeHeight,
  clusterOf,
  layoutCluster,
  layoutDiff,
  layoutFile,
  layoutOverview,
  type Rect
} from "../src/canvas/layout.js"
import type { CanvasGraph } from "../src/canvas/model.js"
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
})
