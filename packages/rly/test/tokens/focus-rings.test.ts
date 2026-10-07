import { describe, expect, it } from "vitest"
import { findFocusRingViolations } from "../../scripts/tokens/focus-rings.js"

const rules = (source: string) => findFocusRingViolations("packages/app/src/app.css", source).map(({ rule }) => rule)

const RING = "outline: var(--rly-focus-ring-width) solid var(--rly-color-focus);"

describe("focus ring policy", () => {
  it("rejects a focus outline in any colour but the focus token", () => {
    expect(rules(".x:focus-visible { outline: 1px solid var(--rly-color-agent); }")).toEqual(["focus-outline"])
    expect(rules(".x:focus { outline: 2px solid var(--rly-color-focus); }")).toEqual(["focus-outline"])
    expect(rules(`.x:focus-visible { ${RING} outline-offset: var(--rly-focus-ring-offset); }`)).toEqual([])
  })

  it("accepts only the offset token, the negated width, or flush", () => {
    expect(rules(`.x:focus-visible { ${RING} outline-offset: 3px; }`)).toEqual(["focus-offset"])
    expect(rules(`.x:focus-visible { ${RING} outline-offset: var(--rly-space-2); }`)).toEqual(["focus-offset"])
    expect(rules(`.x:focus-visible { ${RING} outline-offset: calc(var(--rly-focus-ring-width) * -1); }`)).toEqual([])
    expect(rules(`.x:focus-visible { ${RING} outline-offset: 0; }`)).toEqual([])
  })

  it("rejects a box-shadow standing in for the ring", () => {
    expect(
      rules(".x:focus-visible { box-shadow: 0 0 0 3px color-mix(in srgb, var(--rly-color-agent) 20%, transparent); }")
    )
      .toEqual(["focus-shadow"])
    expect(rules(".x:focus-visible { box-shadow: none; }")).toEqual([])
  })

  it("rejects an outline: none that erases a ring drawn in the same rule", () => {
    expect(rules(`.x:focus-visible { ${RING} outline: none; }`)).toEqual(["focus-outline"])
  })

  it("rejects a :focus-visible rule that removes the outline without drawing the ring", () => {
    expect(rules(".a:hover, .a:focus-visible { outline: none; }")).toEqual(["focus-outline"])
    expect(rules(".a:focus-visible { outline-width: 0; }")).toEqual(["focus-outline"])
  })

  it("lets plain :focus and mouse focus drop the outline", () => {
    expect(rules(".a:focus:not(:focus-visible) { outline: none; }")).toEqual([])
    expect(rules(".editor:focus { outline: none; }")).toEqual([])
    expect(rules(`.field:focus-within { ${RING} } .field input:focus { outline: none; }`)).toEqual([])
  })

  it("exempts forced colours, which draw the system ring", () => {
    expect(rules("@media (forced-colors: active) { .x:focus-visible { outline: 2px solid Highlight; } }")).toEqual([])
    expect(rules("[data-rly-forced-colors] .x:focus-visible { outline: 2px solid Highlight; }")).toEqual([])
  })

  it("ignores rules that are not focus states", () => {
    expect(rules(".x:hover { outline: 1px solid red; box-shadow: 0 0 0 2px red; }")).toEqual([])
    expect(rules(".x:focus-visible { color: var(--rly-color-text-1); }")).toEqual([])
  })
})
