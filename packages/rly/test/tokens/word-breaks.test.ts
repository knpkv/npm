import { describe, expect, it } from "vitest"
import { findWordSplits } from "../../scripts/tokens/word-breaks.js"

const declarations = (source: string) => findWordSplits("x.css", source).map(({ declaration }) => declaration)

describe("word splits", () => {
  it("flags CSS that lets a word split mid-word", () => {
    expect(declarations(".label { overflow-wrap: anywhere; }")).toEqual(["overflow-wrap: anywhere"])
    expect(declarations(".id { word-break: break-all; }")).toEqual(["word-break: break-all"])
    expect(declarations(".id { word-break:break-word; }")).toEqual(["word-break: break-word"])
  })

  it("allows break-word wrapping, comments and custom properties", () => {
    expect(declarations(".title { overflow-wrap: break-word; min-inline-size: 0; }")).toEqual([])
    expect(declarations("/* overflow-wrap: anywhere */ .x { --note-overflow-wrap: anywhere; }")).toEqual([])
  })
})
