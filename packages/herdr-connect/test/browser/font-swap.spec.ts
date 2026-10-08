import { expect, test } from "@playwright/test"
import { FONT_SWAP_LAUNCH_OPTIONS, measureFontSwapShift } from "../../../../playwright-font-swap.ts"

test.use({ launchOptions: FONT_SWAP_LAUNCH_OPTIONS })

// A late Geist stays on its metric-matched fallback without moving the agent picker, Connect's first
// screen inside Approvals (rly font-swap budget).
for (const viewport of [{ height: 900, width: 1440 }, { height: 844, width: 390 }]) {
  test(`a late Geist never moves the agent picker at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.request.post("/__test/reset")
    const swap = await measureFontSwapShift(page, { probe: "button", ready: "text=fixture-pane", url: "/" })
    expect(swap.sum, swap.report).toBeLessThanOrEqual(0.05)
  })
}
