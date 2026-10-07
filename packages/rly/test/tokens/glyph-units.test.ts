import { describe, expect, it } from "vitest"
import { findGlyphUnits } from "../../scripts/tokens/glyph-units.js"

const units = (source: string) =>
  findGlyphUnits("packages/app/src/app.css", source).map(({ declaration }) => declaration)

// The review guide's 68ch prose column narrowed 16% under the fallback, so every paragraph re-wrapped (CLS 0.217).
describe("glyph-relative lengths", () => {
  it("flags measures in a glyph of the current font", () => {
    expect(units(".prose { max-width: 68ch; }")).toEqual(["68ch"])
    expect(units(".a { flex: 1 1 20ch; inline-size: 2.5ex; block-size: 1cap; min-inline-size: 3ic; }")).toEqual([
      "20ch",
      "2.5ex",
      "1cap",
      "3ic"
    ])
  })

  it("leaves font-size-relative and absolute lengths, names and comments alone", () => {
    expect(units(".prose { max-width: 45.3em; inline-size: 12rem; } .tech { color: red; } /* 68ch */")).toEqual([])
    expect(units(".ch { inline-size: var(--rly-space-8); } .each-row { margin: 0; }")).toEqual([])
    expect(units(".a::after { content: \"2ch\"; background: url(icons/3ch.svg); } .b { font-family: '5ch'; }")).toEqual(
      []
    )
  })
})
