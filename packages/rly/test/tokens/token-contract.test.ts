import { describe, expect, it } from "vitest"
import { contrastRatio, measureContrastPairs } from "../../scripts/tokens/contrast.js"
import { renderTokenContract, renderTokenCss } from "../../scripts/tokens/token-contract.js"
import { colorTokenSource, contrastPairSource } from "../../src/tokens/colors.js"
import { motionTokenSource } from "../../src/tokens/motion.js"
import {
  RLY_COLOR_TOKEN_NAMES,
  RLY_MOTION_TOKEN_NAMES,
  RLY_RADIUS_TOKEN_NAMES,
  RLY_SPACE_TOKEN_NAMES,
  RLY_TYPE_TOKEN_NAMES
} from "../../src/tokens/semantic-tokens.js"
import { radiusTokenSource } from "../../src/tokens/shape.js"
import { spaceTokenSource } from "../../src/tokens/space.js"
import { typeTokenSource } from "../../src/tokens/typography.js"

describe("semantic token contract", () => {
  it("renders byte-identical generated artifacts", () => {
    expect([...renderTokenContract()]).toEqual([...renderTokenContract()])
  })

  it("keeps public token names aligned without exporting palette values", () => {
    expect(RLY_COLOR_TOKEN_NAMES).toEqual(colorTokenSource.map(({ name }) => name))
    expect(RLY_SPACE_TOKEN_NAMES).toEqual(spaceTokenSource.map(({ name }) => name))
    expect(RLY_RADIUS_TOKEN_NAMES).toEqual(radiusTokenSource.map(({ name }) => name))
    expect(RLY_TYPE_TOKEN_NAMES).toEqual(typeTokenSource.map(({ name }) => name))
    expect(RLY_MOTION_TOKEN_NAMES).toEqual(motionTokenSource.map(({ name }) => name))
  })

  it("uses known WCAG contrast vectors", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5)
    expect(contrastRatio("#767676", "#FFFFFF")).toBeCloseTo(4.54, 2)
    expect(contrastRatio("#336699", "#336699")).toBe(1)
  })

  it("passes every declared light and dark contrast invariant", () => {
    for (const result of measureContrastPairs(colorTokenSource, contrastPairSource)) {
      expect(result.ratio, `${result.name} in ${result.scheme}`).toBeGreaterThanOrEqual(result.minimum)
    }
  })

  it("keeps provenance and readiness in separate semantic groups", () => {
    const services = colorTokenSource.filter(({ name }) => name.startsWith("service-"))
    expect(services).toHaveLength(5)
    expect(services.every(({ purpose }) => purpose === "provenance")).toBe(true)
    expect(
      colorTokenSource.filter(({ purpose }) => purpose === "state").every(
        ({ name }) => !name.startsWith("service-")
      )
    ).toBe(true)
  })

  it("keeps the approved motion rhythm and easing curve exact", () => {
    expect(motionTokenSource.map(({ duration, easing, name }) => ({ duration, easing, name }))).toEqual([
      { duration: "90ms", easing: "cubic-bezier(.2, .8, .2, 1)", name: "fast" },
      { duration: "160ms", easing: "cubic-bezier(.2, .8, .2, 1)", name: "standard" },
      { duration: "240ms", easing: "cubic-bezier(.2, .8, .2, 1)", name: "deliberate" },
      { duration: "360ms", easing: "cubic-bezier(.2, .8, .2, 1)", name: "slow" }
    ])
  })

  it("emits one central light-dark, forced-color, and reduced-motion layer", () => {
    const css = renderTokenCss()
    expect(css.match(/light-dark\(/g)).toHaveLength(colorTokenSource.length * 2)
    expect(css).toContain("[data-theme=\"light\"]")
    expect(css).toContain("@media (forced-colors: active)")
    expect(css).toContain("[data-forced-colors=\"active\"]")
    expect(css).toContain("@media (prefers-reduced-motion: reduce)")
    expect(css).toContain("[data-reduced-motion=\"reduce\"]")
    expect(css).not.toMatch(/generated at|timestamp/i)
  })
})
