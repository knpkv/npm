import { describe, expect, it } from "@effect/vitest"
import { findAccentStripes } from "../../scripts/tokens/accent-stripes.js"

const declarations = (css: string) => findAccentStripes("x.css", css).map((violation) => violation.declaration)

describe("findAccentStripes", () => {
  it("flags a thick one-sided border used as a severity bar", () => {
    expect(declarations(".card { border-inline-start: 4px solid var(--rly-color-held-ink); }")).toEqual([
      "border-inline-start: 4px solid var(--rly-color-held-ink)"
    ])
  })

  it("flags a spacing-token width and an accent-coloured side", () => {
    expect(declarations(".a { border-left: var(--rly-space-4) solid var(--rly-color-agent) }")).toHaveLength(1)
    expect(declarations(".a { border-inline-start-color: var(--rly-color-blocked-ink) }")).toHaveLength(1)
    expect(declarations(".a { border-inline-start: 1px solid var(--rly-color-blocked-ink) }")).toHaveLength(1)
  })

  it("flags a stripe drawn with a one-sided inset shadow", () => {
    expect(declarations(".row { box-shadow: inset 3px 0 0 var(--rly-color-text-1); }")).toHaveLength(1)
  })

  it("flags an inset bar with the blur omitted, the colour first, or on the far edge", () => {
    expect(declarations(".a { box-shadow: inset var(--rly-space-4) 0 var(--rly-color-focus); }")).toHaveLength(1)
    expect(declarations(".a { box-shadow: var(--rly-color-held-ink) inset 3px 0; }")).toHaveLength(1)
    expect(declarations(".a { box-shadow: 0 1px 2px black, inset -2px 0 0 var(--rly-color-agent); }")).toHaveLength(1)
  })

  it("flags an accent mixed with transparent on one side", () => {
    expect(
      declarations(".a { border-left: 1px solid color-mix(in srgb, var(--rly-color-blocked-ink), transparent); }")
    ).toHaveLength(1)
  })

  it("keeps neutral 1px column dividers, zeroed sides and full rings", () => {
    expect(
      declarations(`
        .col { border-inline-start: 1px solid var(--rly-color-border-1); }
        .reset { border-inline-start: 0; border-left: none; }
        .ring { box-shadow: inset 0 0 0 2px var(--rly-color-focus); }
        .soft { box-shadow: inset 0 1px 3px var(--rly-color-border-2); }
        .clear { border-inline-end: 1px solid transparent; }
        .tab { box-shadow: inset 0 -3px var(--rly-color-focus); }
        .even { border: 1px solid var(--rly-color-held-ink); }
        /* border-inline-start: 4px solid red; */
      `)
    ).toEqual([])
  })

  it("reports the line of the offending declaration", () => {
    const [violation] = findAccentStripes(
      "x.css",
      ".a {\n  color: red;\n  border-left: 3px solid var(--rly-color-held-ink);\n}"
    )
    expect(violation?.line).toBe(3)
  })
})
