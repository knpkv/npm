import { describe, expect, it } from "vitest"
import { canvasReadHeads } from "../src/code-canvas-page.js"

describe("canvasReadHeads", () => {
  it("joins findings and lines read at the map's head", () => {
    expect(canvasReadHeads("b", "b", "b")).toEqual({ findings: true, lines: true, other: null })
  })

  it("keeps a review or lines from another head off the map and names that head", () => {
    expect(canvasReadHeads("b", "c", "b")).toEqual({ findings: false, lines: true, other: "c" })
    expect(canvasReadHeads("b", "b", "c")).toEqual({ findings: true, lines: false, other: "c" })
  })

  it("joins nothing that has not been read yet, without calling it another head", () => {
    expect(canvasReadHeads("b", null, null)).toEqual({ findings: false, lines: false, other: null })
  })
})
