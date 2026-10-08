import { expect, test } from "@playwright/test"
import { FONT_SWAP_LAUNCH_OPTIONS, measureFontSwapShift } from "../../../../playwright-font-swap.ts"

test.use({ launchOptions: FONT_SWAP_LAUNCH_OPTIONS })

// Geist (inlined in board.css) swaps in over its metric-matched fallback without moving the
// view-key screen, the monitor's first paint (rly font-swap budget).
for (const viewport of [{ height: 900, width: 1440 }, { height: 844, width: 390 }]) {
  test(`Geist swaps in without moving the first screen at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport)
    const swap = await measureFontSwapShift(page, { probe: "h1", ready: "h1", url: "/" })
    expect(swap.sum, swap.report).toBeLessThanOrEqual(0.05)
  })
}
