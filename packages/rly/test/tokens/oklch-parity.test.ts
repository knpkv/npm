import { describe, expect, it } from "vitest"

import { deltaEOk, hexToOklab, oklchToHex, oklchToOklab } from "../../scripts/tokens/oklch.js"
import { colorTokenSource } from "../../src/tokens/colors.js"

// The sRGB values rly's palette had before it moved to OKLCH; every token must still display as them.
const previous: ReadonlyArray<readonly [string, `#${string}`, `#${string}`]> = [
  ["canvas", "#F6F6F8", "#101114"],
  ["surface-1", "#FFFFFF", "#17181C"],
  ["surface-2", "#F0F1F4", "#1E2025"],
  ["surface-3", "#E8E9ED", "#282A31"],
  ["text-1", "#17181B", "#F4F4F6"],
  ["text-2", "#5E6068", "#B7B9C1"],
  ["text-3", "#6E717A", "#9396A0"],
  ["border-1", "#DADCE2", "#30323A"],
  ["border-2", "#B9BCC5", "#4C4F5A"],
  ["action-background", "#17181B", "#F4F4F6"],
  ["action-foreground", "#FFFFFF", "#17181B"],
  ["focus", "#006DFF", "#89B7FF"],
  ["agent", "#6741A5", "#BD9CF0"],
  ["success-ink", "#16753A", "#66D38B"],
  ["success-tint", "#EAF6ED", "#153222"],
  ["blocked-ink", "#B42318", "#FF8B82"],
  ["blocked-tint", "#FDECEA", "#3A1918"],
  ["held-ink", "#7A5100", "#F0C66A"],
  ["held-tint", "#FFF5DC", "#33270F"],
  ["deploying-ink", "#075EBC", "#75AEFF"],
  ["deploying-tint", "#EAF3FF", "#112B49"],
  ["service-codecommit", "#C45500", "#FF9B55"],
  ["service-codepipeline", "#8A42C2", "#D69CFF"],
  ["service-jira", "#0C66E4", "#75AEFF"],
  ["service-confluence", "#4758D6", "#9EA9FF"],
  ["service-clockify", "#0087C7", "#64CCF2"],
  ["series-1", "#2A78D6", "#3987E5"],
  ["series-2", "#008300", "#2E9E2E"],
  ["series-3", "#C24F7C", "#D55181"],
  ["series-4", "#9C6A00", "#C98500"],
  ["series-5", "#118259", "#199E70"],
  ["series-6", "#C4501E", "#D95926"],
  ["series-7", "#4A3AA7", "#9085E9"],
  ["series-8", "#D23D3C", "#E66767"],
  ["series-other", "#777672", "#7E7D79"]
]

describe("OKLCH palette", () => {
  it("displays every token, in both themes, as exactly the sRGB colour it replaced", () => {
    expect(colorTokenSource.map(({ name }) => name)).toEqual(previous.map(([name]) => name))
    for (const [name, light, dark] of previous) {
      const token = colorTokenSource.find((candidate) => candidate.name === name)
      expect(token).toBeDefined()
      if (token === undefined) continue
      expect([name, oklchToHex(token.light), oklchToHex(token.dark)]).toEqual([name, light, dark])
      // Well under one just-noticeable difference (about 0.02 ΔEOK).
      expect(deltaEOk(oklchToOklab(token.light), hexToOklab(light))).toBeLessThan(0.001)
      expect(deltaEOk(oklchToOklab(token.dark), hexToOklab(dark))).toBeLessThan(0.001)
    }
  })

  it("writes neutrals with hue none", () => {
    for (const token of colorTokenSource) {
      for (const value of [token.light, token.dark]) {
        if (value.endsWith(" 0 none)")) continue
        expect(value).toMatch(/^oklch\([\d.]+% [\d.]+ [\d.]+\)$/)
      }
    }
  })
})
