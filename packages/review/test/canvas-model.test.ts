import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { CanvasGraph, CanvasGraphReading, canvasModuleOf, CanvasReading } from "../src/canvas/model.js"

const file = (path: string, added: number, removed: number) => ({
  path,
  status: removed === 0 ? "added" : "modified",
  previousPath: null,
  added,
  removed,
  parts: { _tag: "NotRecorded" }
})

const graph = {
  headRevision: "e81f0c9",
  files: [file("sync-worker/socket.ts", 142, 0), file("sync-worker/worker.ts", 96, 0)],
  dependencies: {
    _tag: "Recorded",
    edges: [{
      from: "sync-worker/worker.ts",
      to: "sync-worker/socket.ts",
      relation: "imports",
      fromPart: null,
      toPart: null
    }]
  },
  partitions: { _tag: "NotRecorded" }
}

const decodeGraph = Schema.decodeUnknownResult(CanvasGraph, { onExcessProperty: "error" })
const decodeReading = Schema.decodeUnknownResult(CanvasGraphReading, { onExcessProperty: "error" })

describe("canvas contracts", () => {
  it("decodes a file-level import graph", () => {
    expect(decodeGraph(graph)._tag).toBe("Success")
  })

  it("rejects excess properties instead of carrying unknown provider data", () => {
    expect(decodeGraph({ ...graph, repositoryArn: "arn:aws:codecommit:eu-west-1:1:relay" })._tag).toBe("Failure")
  })

  it("rejects an edge that names a file outside this change", () => {
    const edges = [{
      from: "sync-worker/worker.ts",
      to: "elsewhere.ts",
      relation: "imports",
      fromPart: null,
      toPart: null
    }]
    expect(decodeGraph({ ...graph, dependencies: { _tag: "Recorded", edges } })._tag).toBe("Failure")
  })

  it("rejects duplicate file paths", () => {
    expect(decodeGraph({ ...graph, files: [graph.files[0], graph.files[0]] })._tag).toBe("Failure")
  })

  it("requires a moved part to name where it moved", () => {
    const parts = {
      _tag: "Recorded",
      items: [{ name: "openSocket()", kind: "moved_to", movedPath: null, lines: null, added: 0, removed: 118 }]
    }
    const files = [{ ...graph.files[0], parts }, graph.files[1]]
    expect(decodeGraph({ ...graph, files })._tag).toBe("Failure")
    const named = { ...parts, items: [{ ...parts.items[0], movedPath: "sync-worker/socket.ts" }] }
    expect(decodeGraph({ ...graph, files: [{ ...graph.files[0], parts: named }, graph.files[1]] })._tag).toBe(
      "Success"
    )
  })

  it("rejects a line range that ends before it starts", () => {
    const parts = {
      _tag: "Recorded",
      items: [{
        name: "connect()",
        kind: "added",
        movedPath: null,
        lines: { start: 59, end: 14 },
        added: 46,
        removed: 0
      }]
    }
    expect(decodeGraph({ ...graph, files: [{ ...graph.files[0], parts }, graph.files[1]] })._tag).toBe("Failure")
  })

  it("rejects a partition that names a file outside this change", () => {
    const partitions = {
      _tag: "Recorded",
      items: [{ id: "A", title: "Worker owns the socket", why: "Shared socket.", files: ["missing.ts"] }]
    }
    expect(decodeGraph({ ...graph, partitions })._tag).toBe("Failure")
  })

  it("keeps an unread language explicit rather than an empty edge list", () => {
    const dependencies = { _tag: "NotRecorded", language: "TypeScript" }
    expect(decodeGraph({ ...graph, dependencies })._tag).toBe("Success")
  })

  it("rejects building progress past its files", () => {
    const building = { _tag: "Building", headRevision: "e81f0c9", placed: 2, total: 14, files: graph.files }
    expect(decodeReading(building)._tag).toBe("Success")
    expect(decodeReading({ ...building, placed: 3 })._tag).toBe("Failure")
    expect(decodeReading({ ...building, total: 1 })._tag).toBe("Failure")
  })

  it("carries every review-context source as an explicit recorded or not-recorded state", () => {
    const notRecorded = { _tag: "NotRecorded" }
    const reading = {
      graph: { _tag: "Ready", graph },
      context: { lastLook: notRecorded, readingPath: notRecorded, findings: notRecorded, tests: notRecorded }
    }
    expect(Schema.decodeUnknownResult(CanvasReading, { onExcessProperty: "error" })(reading)._tag).toBe("Success")
    const missing = { ...reading, context: { lastLook: notRecorded } }
    expect(Schema.decodeUnknownResult(CanvasReading, { onExcessProperty: "error" })(missing)._tag).toBe("Failure")
  })

  it("rejects a reading path chapter that names a file outside this change", () => {
    const notRecorded = { _tag: "NotRecorded" }
    const readingPath = {
      _tag: "Recorded",
      chapters: [{ partition: null, title: "Tests", why: "Test-only", files: ["tests/missing.test.ts"] }],
      read: [],
      current: null
    }
    const reading = {
      graph: { _tag: "Ready", graph },
      context: { lastLook: notRecorded, readingPath, findings: notRecorded, tests: notRecorded }
    }
    expect(Schema.decodeUnknownResult(CanvasReading, { onExcessProperty: "error" })(reading)._tag).toBe("Failure")
  })
})

describe("canvasModuleOf", () => {
  it("groups by the first directory", () => {
    expect(canvasModuleOf("stage/useStageSocket.ts")).toBe("stage")
  })

  it("keeps workspace containers with their package", () => {
    expect(canvasModuleOf("packages/review/src/canvas/model.ts")).toBe("packages/review")
  })

  it("puts root files in their own module", () => {
    expect(canvasModuleOf("package.json")).toBe(".")
  })
})
