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

  it("flags any side border that is not a neutral hairline, whatever its unit or colour spelling", () => {
    expect(declarations(".a { border-inline-start: 1px solid currentColor; }")).toHaveLength(1)
    expect(declarations(".a { border-left: 1px solid red; }")).toHaveLength(1)
    expect(declarations(".a { border-left: 1px solid var(--brand-accent); }")).toHaveLength(1)
    expect(declarations(".a { border-left: .125rem solid var(--rly-color-border-1); }")).toHaveLength(1)
    expect(declarations(".a { border-inline-start-width: thick; }")).toHaveLength(1)
  })

  it("checks a split side width against its rule's colour and ignores custom-property names", () => {
    expect(declarations(".card { border: 0 solid var(--rly-color-held-ink); border-left-width: 1px; }")).toEqual([
      "border-left-width: 1px"
    ])
    expect(declarations(".card { border: 0 solid var(--rly-color-border-1); border-left-width: 1px; }")).toEqual([])
    expect(declarations(".theme { --card-border-left: 4px solid red; --panel-box-shadow: inset 3px 0 red; }")).toEqual(
      []
    )
    expect(declarations(".card { border-left: 4px solid red; }")).toEqual(["border-left: 4px solid red"])
  })

  it("flags a coloured hairline on one inline edge and passes block underlines and neutral hairlines", () => {
    expect(declarations(".card { border: solid var(--rly-color-held-ink); border-width: 0 0 0 1px; }")).toEqual([
      "border-width: 0 0 0 1px"
    ])
    expect(declarations(".card { border-style: solid; border-width: 0 1px 0 0; }")).toEqual(["border-width: 0 1px 0 0"])
    expect(declarations(".card { border: solid var(--rly-color-held-ink); border-inline-width: 1px 0; }")).toEqual([
      "border-inline-width: 1px 0"
    ])
    expect(declarations(".row { border: solid var(--rly-color-border-1); border-width: 0 0 0 1px; }")).toEqual([])
    expect(declarations(".card { border: 1px solid var(--rly-color-held-ink); }")).toEqual([])
    expect(declarations(".tab { border: solid var(--rly-color-focus); border-width: 0 0 3px; }")).toEqual([])
    expect(declarations(".tab { border-width: 0 0 3px 0; }")).toEqual([])
    expect(declarations(".a { border-inline-width: 4px 0; }")).toEqual(["border-inline-width: 4px 0"])
  })

  it("flags a stripe built from border-width, and a side border whose width is left at medium", () => {
    expect(declarations(".card { border: solid var(--rly-color-held-ink); border-width: 0 0 0 4px; }")).toEqual([
      "border-width: 0 0 0 4px"
    ])
    expect(declarations(".a { border-left: solid var(--rly-color-border-1); }")).toHaveLength(1)
    expect(declarations(".a { border-width: 1px; border-width: 0 1px 1px 0; }")).toEqual([])
    expect(declarations(".card { border: solid var(--rly-color-border-1); border-width: 1px 1px 1px 4px; }")).toEqual([
      "border-width: 1px 1px 1px 4px"
    ])
    // An omitted colour is currentColor, so a coloured text tints the side.
    expect(declarations(".card { color: var(--rly-color-blocked-ink); border-left: 1px solid; }")).toHaveLength(1)
  })

  it("lets a drawn shape opt out per declaration, with a reason", () => {
    expect(
      declarations(".chevron { border-inline-end: 1.5px solid currentcolor; /* stripe-ok: drawn chevron */ }")
    ).toEqual([])
    expect(declarations(".chevron { border-inline-end: 1.5px solid currentcolor; /* stripe-ok: */ }")).toHaveLength(1)
  })

  it("treats an inset whose offsets cannot be read as a stripe", () => {
    expect(declarations(".a { box-shadow: inset calc(-1 * var(--rly-space-4)) 0 var(--rly-color-focus); }"))
      .toHaveLength(1)
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
