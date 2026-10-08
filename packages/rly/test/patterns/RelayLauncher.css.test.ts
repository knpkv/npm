import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const css = readFileSync(join(import.meta.dirname, "../../src/patterns/RelayLauncher.module.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  ""
)

/** Innermost rules as [selector list, declarations]; at-rule preludes fall outside the match. */
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors = "", body = ""]) => ({
  body,
  selectors: selectors.split(",").map((selector) => selector.trim())
}))

// In forced colours the open fill sets forced-color-adjust: none, which also lets the author hover tint
// through; storybook's synthetic hover never matches :hover, so this keeps the selectors honest.
describe("RelayLauncher forced-colours CSS", () => {
  it("keeps the inverted open fill when the open launcher is hovered", () => {
    const inverted = rules.filter(({ body }) => /background:\s*ButtonText/.test(body))
    expect(inverted).toHaveLength(2)
    for (const { selectors } of inverted) {
      const open = selectors.filter((selector) => selector.endsWith(".root[aria-expanded=\"true\"]"))
      expect(open).toHaveLength(1)
      expect(selectors).toContain(`${open[0]}:hover`)
    }
  })
})
