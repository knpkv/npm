import { expect, test } from "@playwright/test"
import { FONT_SWAP_LAUNCH_OPTIONS, measureFontSwapShift } from "../../../../playwright-font-swap.ts"

test.use({ launchOptions: FONT_SWAP_LAUNCH_OPTIONS })

// Geist swaps in over its metric-matched fallback without moving the dashboard (rly font-swap budget).
for (const viewport of [{ height: 1000, width: 1440 }, { height: 844, width: 390 }]) {
  test(`Geist swaps in without moving the dashboard at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport)
    const token = await (await page.request.get("/__test/session")).text()
    await page.context().addCookies([{ name: "agent_usage_owner", value: token, url: "http://127.0.0.1:4180/api" }])
    const swap = await measureFontSwapShift(page, { probe: "h1", ready: "table", url: "/" })
    expect(swap.sum, swap.report).toBeLessThanOrEqual(0.05)
  })
}
