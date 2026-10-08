import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const css = readFileSync(join(import.meta.dirname, "../../src/patterns/RelayLauncher.module.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  ""
)

/** Innermost rules as raw selector text and declarations; at-rule preludes fall outside the match. */
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors = "", body = ""]) => ({ body, selectors }))

// In forced colours the open fill sets forced-color-adjust: none, which also lets the author hover tint
// through; storybook's synthetic hover never matches :hover, so this keeps the selectors honest.
describe("RelayLauncher forced-colours CSS", () => {
  it("keeps the agent edge when the open launcher is hovered", () => {
    const openHovers = rules.filter(({ body, selectors }) =>
      !/ButtonText/.test(body) && /^\s*\.root\[aria-expanded="true"\][^,]*:hover\s*$/.test(selectors)
    )
    expect(openHovers.length).toBeGreaterThan(0)
    for (const { body } of openHovers) expect(body).toMatch(/border-color:\s*var\(--rly-color-agent\)/)
  })

  it("keeps the inverted open fill when the open launcher is hovered", () => {
    const inverted = rules.filter(({ body }) => /background:\s*ButtonText/.test(body))
    expect(inverted).toHaveLength(2)
    // Every author hover rule on the open launcher, repeated verbatim so specificity is equal and the
    // later forced rule wins.
    const authorHovers = rules
      .filter(({ body }) => !/ButtonText/.test(body))
      .flatMap(({ selectors }) => selectors.split(",").map((selector) => selector.trim()))
      .filter((selector) => selector.startsWith(".root[aria-expanded=\"true\"]") && selector.includes(":hover"))
    expect(authorHovers.length).toBeGreaterThan(0)
    for (const { selectors } of inverted) for (const hover of authorHovers) expect(selectors).toContain(hover)
  })
})
