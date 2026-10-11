import { expect, test } from "@playwright/test"
import { FONT_SWAP_LAUNCH_OPTIONS, measureFontSwapShift } from "../../../../playwright-font-swap.ts"

test.use({ launchOptions: FONT_SWAP_LAUNCH_OPTIONS })

// A late Geist (inlined in board.css) stays on its metric-matched fallback without moving the
// view-key screen, the monitor's first paint (rly font-swap budget).
for (const viewport of [{ height: 900, width: 1440 }, { height: 844, width: 390 }]) {
  test(`a late Geist never moves the first screen at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport)
    const swap = await measureFontSwapShift(page, { probe: "h1", ready: "h1", url: "/" })
    expect(swap.sum, swap.report).toBeLessThanOrEqual(0.05)
  })
}

// The h1 is static HTML, laid out before board.css applies; a slow stylesheet must not reach the
// measurement before the fallback @font-face exists (a CI flake: 'Geist Mono Fallback' did not load).
test("a slow stylesheet still measures the fallback faces", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 })
  const swap = await measureFontSwapShift(page, {
    probe: "h1",
    ready: "h1",
    // Registered after the helper's routes, so this handler runs first and holds board.css.
    load: async () => {
      await page.route("**/board.css", async (route) => {
        await page.waitForTimeout(1_000)
        await route.fallback()
      })
      await page.goto("/", { waitUntil: "commit" })
    }
  })
  expect(swap.sum, swap.report).toBeLessThanOrEqual(0.05)
})

// A failed stylesheet must not leave the stylesheet wait hanging: the missing fallback face is
// reported at once instead of as a Playwright timeout.
test("a failed stylesheet reports the missing fallback instead of hanging", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 })
  const swap = measureFontSwapShift(page, {
    probe: "h1",
    ready: "h1",
    load: async () => {
      await page.route("**/board.css", (route) => route.abort())
      await page.goto("/", { waitUntil: "commit" })
    }
  })
  await expect(swap).rejects.toThrow("'Geist Mono Fallback' did not load")
})
