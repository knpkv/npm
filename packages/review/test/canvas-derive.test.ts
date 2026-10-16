import { describe, expect, it } from "vitest"
import { arrowNeighbours, canvasFiles, canvasModules, canvasNodeWidth, readingOrder } from "../src/canvas/derive.js"
import { noContext, sampleContext, sampleFindings, sampleGraph } from "./canvas-fixture.js"

describe("canvas file view", () => {
  const files = canvasFiles(sampleGraph, sampleContext, sampleFindings)
  const byPath = new Map(files.map((file) => [file.path, file]))

  it("rates risk from changed lines and open P0–P2 findings", () => {
    expect(byPath.get("sync-worker/socket.ts")?.risk).toBe("high")
    expect(byPath.get("sync-worker/drafts.ts")?.risk).toBe("high")
    expect(byPath.get("sync-worker/protocol.ts")?.risk).toBe("medium")
    expect(byPath.get("composer/useDraft.ts")?.risk).toBe("medium")
    expect(byPath.get("tests/socket.test.ts")?.risk).toBe("low")
    expect(byPath.get("stage/StageView.tsx")?.risk).toBe("low")
  })

  it("marks failing test files and files changed since the last look, failing first", () => {
    expect(byPath.get("tests/socket.test.ts")?.marks).toEqual(["failing", "changed"])
    expect(byPath.get("sync-worker/socket.ts")?.marks).toEqual(["changed"])
    expect(byPath.get("sync-worker/worker.ts")?.marks).toEqual([])
  })

  it("shows no marks for sources that were not recorded", () => {
    const plain = canvasFiles(sampleGraph, noContext, sampleFindings)
    expect(plain.every((file) => file.marks.length === 0)).toBe(true)
  })

  it("badges each file with its findings in severity order", () => {
    expect(byPath.get("sync-worker/socket.ts")?.badges).toEqual(["P1"])
    expect(byPath.get("stage/StageProvider.tsx")?.badges).toEqual([])
  })

  it("groups modules in first-appearance order", () => {
    expect(canvasModules(files).map((module) => [module.id, module.files.length])).toEqual([
      ["stage", 4],
      ["sync-worker", 4],
      ["composer", 3],
      ["tests", 3]
    ])
  })
})

describe("canvasNodeWidth", () => {
  it("fits the name, and grows with changed lines", () => {
    expect(canvasNodeWidth("useStageSocket.ts", 142)).toBe(139)
    expect(canvasNodeWidth("StageProvider.tsx", 71)).toBe(134)
    expect(canvasNodeWidth("socket.ts", 142)).toBe(139)
    expect(canvasNodeWidth("worker.ts", 96)).toBe(125)
    expect(canvasNodeWidth("StageView.tsx", 12)).toBe(108)
  })

  it("caps very large changes", () => {
    expect(canvasNodeWidth("big.ts", 50_000)).toBe(220)
  })
})

describe("readingOrder", () => {
  it("follows a recorded reading path", () => {
    const files = canvasFiles(sampleGraph, sampleContext, sampleFindings)
    expect(readingOrder(files, sampleContext.readingPath).slice(0, 3)).toEqual([
      "sync-worker/socket.ts",
      "stage/useStageSocket.ts",
      "sync-worker/worker.ts"
    ])
  })

  it("falls back to the riskiest files first, without a recorded path", () => {
    const files = canvasFiles(sampleGraph, noContext, sampleFindings)
    const order = readingOrder(files, noContext.readingPath)
    expect(order[0]).toBe("sync-worker/socket.ts")
    expect(new Set(order).size).toBe(14)
  })
})

describe("arrowNeighbours", () => {
  const center = { x: 425, y: 211 }
  it("gives each neighbour its own arrow, by the closest free direction", () => {
    const result = arrowNeighbours(center, [
      { path: "worker", x: 418, y: 135 },
      { path: "reconnect", x: 236, y: 203 },
      { path: "socket.test", x: 551, y: 535 },
      { path: "drafts", x: 577, y: 391 }
    ])
    expect(result).toEqual({ up: "worker", left: "reconnect", down: "socket.test", right: "drafts" })
  })

  it("leaves a direction empty rather than reusing a neighbour", () => {
    expect(arrowNeighbours(center, [{ path: "only", x: 425, y: 50 }])).toEqual({ up: "only" })
  })
})
