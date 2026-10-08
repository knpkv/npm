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

  it("keeps the inverted open fill while the open launcher is hovered or pressed", () => {
    const inverted = rules.filter(({ body }) => /background:\s*ButtonText/.test(body))
    expect(inverted).toHaveLength(2)
    // The open form of every author hover/active background rule: the open attribute plus the same
    // state suffix is never less specific, and the forced rules come later, so they win.
    const open = ".root[aria-expanded=\"true\"]"
    const required = rules
      .filter(({ body }) => !/ButtonText/.test(body) && /(^|;|\s)background:/.test(body))
      .flatMap(({ selectors }) => selectors.split(",").map((selector) => selector.trim()))
      .filter((selector) => selector.startsWith(".root") && /:(hover|active)/.test(selector))
      .map((selector) => (selector.startsWith(open) ? selector : `${open}${selector.slice(".root".length)}`))
    expect(required).toEqual(expect.arrayContaining([`${open}:not(:disabled):hover`, `${open}:not(:disabled):active`]))
    for (const { selectors } of inverted) {
      for (const selector of required) expect(selectors.replace(/\s+/g, " ")).toContain(selector)
    }
  })
})
