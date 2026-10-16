import { describe, expect, it } from "vitest"
import {
  checkWords,
  focusDescription,
  levelLine,
  noDependencyNotice,
  reviewLine,
  sinceLine,
  statusLine,
  timeOfDay
} from "../src/canvas/copy.js"
import type { CanvasGraph } from "../src/canvas/model.js"
import { initialCanvasView, makeCanvasWorld, reduceCanvasView } from "../src/canvas/view-state.js"
import { sampleContext, sampleFindings, sampleGraph } from "./canvas-fixture.js"

const world = makeCanvasWorld(sampleGraph, sampleContext, sampleFindings)
const start = initialCanvasView(world)
const at = (level: "overview" | "cluster" | "file" | "diff") => reduceCanvasView(world, start, { _tag: "Level", level })

describe("canvas copy", () => {
  it("formats times as the viewer's hour and minute", () => {
    expect(timeOfDay(Date.UTC(2026, 9, 16, 14, 22), "UTC")).toBe("14:22")
  })

  it("names the zoom level and what it shows", () => {
    expect(levelLine(world, at("overview"))).toBe("Overview: the whole change")
    expect(levelLine(world, at("cluster"))).toBe("Cluster: partition A, 6 files")
    expect(levelLine(world, at("file"))).toBe("File: sync-worker/socket.ts")
    expect(levelLine(world, at("diff"))).toBe("Diff: connect(), lines 14–59")
    expect(levelLine({ ...world, ready: false }, start)).toBe("Zoom opens when the map is ready")
  })

  it("summarises the overview", () => {
    expect(statusLine(world, start, null)).toBe(
      "14 files, 13 edges this change touches, 2 partitions. Enter on a partition zooms into it."
    )
  })

  it("says how many files are placed while the map builds", () => {
    expect(statusLine({ ...world, ready: false }, start, { placed: 9, total: 14 })).toBe(
      "Building the map: reading call and import relations, 9 of 14 files"
    )
  })

  it("summarises a cluster and where its stubs lead", () => {
    expect(statusLine(world, at("cluster"), null)).toBe(
      "Partition A, 6 files in stage and sync-worker. Faint stubs at the edge lead out of A: to partition B and to tests."
    )
  })

  it("summarises a file and a diff", () => {
    expect(statusLine(world, at("file"), null)).toBe(
      "socket.ts, 5 changed parts. Callers on the left, callees on the right; each stub says where it leads."
    )
    expect(statusLine(world, at("diff"), null)).toBe(
      "Lines 14–59 of socket.ts, the P1 between 16 and 17. Neighbours stay at the edge: worker.ts, reconnect.ts and socket.test.ts on the left, drafts.ts on the right, onMessage() below."
    )
  })

  it("describes the focused node and each arrow's neighbour", () => {
    expect(focusDescription(world, start)).toBe(
      "socket.ts, sync-worker, partition A. High risk, P1 open, changed since you looked. 4 edges: ↑ worker.ts calls it, ← reconnect.ts moved into it, ↓ it calls drafts.ts, → socket.test.ts imports it."
    )
  })

  it("lays out by module when there is no dependency data", () => {
    const graph: CanvasGraph = { ...sampleGraph, dependencies: { _tag: "NotRecorded", language: "TypeScript" } }
    const modules = makeCanvasWorld(graph, sampleContext, sampleFindings)
    expect(levelLine(modules, initialCanvasView(modules))).toBe("Overview: files by module")
    expect(statusLine(modules, initialCanvasView(modules), null)).toBe(
      "14 files placed by module. Cluster zoom opens a module; File and Diff zoom work as usual."
    )
    expect(noDependencyNotice(graph, "relay/web")).toBe(
      "Edges are missing: there’s no dependency data for TypeScript in relay/web yet. Files are grouped by module only, so partitions A and B can’t be drawn either."
    )
  })

  it("counts open findings in the review line", () => {
    expect(reviewLine("sec-cc", Date.UTC(2026, 9, 16, 14, 22), sampleFindings, "UTC")).toBe(
      "sec-cc review, 14:22: 1 P1, 2 P2, 1 P3"
    )
    expect(reviewLine("sec-cc", Date.UTC(2026, 9, 16, 14, 22), [], "UTC")).toBe(
      "sec-cc review, 14:22: no open findings"
    )
  })

  it("names failed checks", () => {
    expect(checkWords(["unit-tests"])).toBe("1 check failed")
    expect(checkWords(["unit-tests", "lint"])).toBe("2 checks failed")
  })

  it("tells the viewer what changed since they looked", () => {
    expect(sinceLine(sampleContext.lastLook, "UTC")).toBe("You looked at 13:20. 2 commits since, 4 files changed.")
    expect(sinceLine({ _tag: "NotRecorded" }, "UTC")).toBeNull()
  })
})
