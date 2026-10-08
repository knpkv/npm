import { expect, test } from "@playwright/test"
import { FONT_SWAP_LAUNCH_OPTIONS, measureFontSwapShift } from "../../../playwright-font-swap.ts"

test.use({ launchOptions: FONT_SWAP_LAUNCH_OPTIONS })

// Geist swaps in over its metric-matched fallback without moving the first screen a new browser
// sees, the private application boundary (rly font-swap budget).
for (const viewport of [{ height: 900, width: 1440 }, { height: 844, width: 390 }]) {
  test(`Geist swaps in without moving the private boundary at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.route("**/api/v1/session/current", (route) =>
      route.fulfill({
        body: JSON.stringify({
          _tag: "UnauthorizedApiError",
          code: "unauthorized",
          correlationId: "font-swap-e2e",
          message: "No active session"
        }),
        contentType: "application/json",
        status: 401
      }))
    const swap = await measureFontSwapShift(page, { probe: "h1", ready: "text=Release facts stay private", url: "/" })
    expect(swap.sum, swap.report).toBeLessThanOrEqual(0.05)
  })
}
