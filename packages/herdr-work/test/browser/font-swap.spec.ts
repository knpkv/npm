import { expect, test } from "@playwright/test"
import { FONT_SWAP_LAUNCH_OPTIONS, measureFontSwapShift } from "../../../../playwright-font-swap.ts"

test.use({ launchOptions: FONT_SWAP_LAUNCH_OPTIONS })

// A late Geist stays on its metric-matched fallback without moving the goal board, Work's screen
// inside Approvals (rly font-swap budget).
for (const viewport of [{ height: 900, width: 1440 }, { height: 844, width: 390 }]) {
  test(`a late Geist never moves the goal board at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport)
    const swap = await measureFontSwapShift(page, {
      probe: ".work-board-row",
      ready: ".work-board-row",
      url: "/test/browser/fixture.html"
    })
    expect(swap.sum, swap.report).toBeLessThanOrEqual(0.05)
  })
}
