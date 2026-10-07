import { describe, expect, it } from "vitest"
import { compareToBaseline } from "../../scripts/tokens/stripe-baseline.js"

const at = (path: string, declaration: string, line = 1) => ({ column: 3, declaration, line, path })

describe("stripe baseline", () => {
  it("allows listed stripes wherever they moved, and fails a new one", () => {
    const baseline = [{ declaration: "border-left: 4px solid red", path: "packages/a/src/a.css" }]
    expect(compareToBaseline([at("packages/a/src/a.css", "border-left: 4px solid red", 90)], baseline)).toEqual({
      fixed: [],
      fresh: []
    })
    const fresh = at("packages/b/src/b.css", "border-left: 3px solid blue")
    expect(compareToBaseline([fresh], baseline).fresh).toEqual([fresh])
  })

  it("fails a listed stripe that is gone, so the baseline only shrinks", () => {
    const baseline = [{ declaration: "border-left: 4px solid red", path: "packages/a/src/a.css" }]
    expect(compareToBaseline([], baseline)).toEqual({ fixed: baseline, fresh: [] })
  })

  it("counts repeated declarations, so a second copy of a listed stripe is still new", () => {
    const baseline = [{ declaration: "border-left: 4px solid red", path: "packages/a/src/a.css" }]
    const copies = [
      at("packages/a/src/a.css", "border-left: 4px solid red", 1),
      at("packages/a/src/a.css", "border-left: 4px solid red", 9)
    ]
    expect(compareToBaseline(copies, baseline).fresh).toEqual([copies[1]])
  })
})
