import { expect, test } from "@playwright/test"
import { FONT_SWAP_LAUNCH_OPTIONS, measureFontSwapShift } from "../../../playwright-font-swap.ts"

test.use({ launchOptions: FONT_SWAP_LAUNCH_OPTIONS })

const story = (id: string, theme: "light" | "dark") =>
  `/iframe.html?id=${id}&viewMode=story&globals=theme:${theme};forcedColors:auto;reducedMotion:reduce;locale:en;density:comfortable`

// The type specimen, a page of headings and body copy, and a dense table: the fonts' own share of the
// family's shift budget, so Geist swapping in over its metric-matched fallback moves rly by ≤0.02.
const stories = [
  { id: "foundations-tokens--overview", probe: "h2" },
  { id: "catalog-overview--default", probe: "h1" },
  { id: "patterns-entitytable--states", probe: "th" }
] as const

for (const { id, probe } of stories) {
  for (const width of [320, 1280]) {
    for (const theme of ["light", "dark"] as const) {
      test(`${id} keeps its layout when Geist swaps in at ${width}px, ${theme}`, async ({ page }) => {
        await page.setViewportSize({ height: 900, width })
        const swap = await measureFontSwapShift(page, {
          probe: `#storybook-root ${probe}`,
          ready: `#storybook-root ${probe}`,
          url: story(id, theme)
        })
        expect(swap.sum, swap.report).toBeLessThanOrEqual(0.02)
      })
    }
  }
}
