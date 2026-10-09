import { expect, test } from "@playwright/test"
import { Schema } from "effect"
import { FONT_SWAP_LAUNCH_OPTIONS, measureFontSwapShift } from "../../../../playwright-font-swap.ts"

test.use({ launchOptions: FONT_SWAP_LAUNCH_OPTIONS })

const decodeSetup = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))

// A late Geist stays on its metric-matched fallback without moving the week (rly font-swap budget).
for (const viewport of [{ height: 1000, width: 1440 }, { height: 844, width: 390 }]) {
  test(`a late Geist never moves the week at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.context().addInitScript(() => window.localStorage.setItem("jcf_web_week", "2026-09-07"))
    const setup = decodeSetup(await (await page.request.post("/__test/reset")).json())
    const swap = await measureFontSwapShift(page, { probe: "h1", ready: "h1", url: setup.url })
    expect(swap.sum, swap.report).toBeLessThanOrEqual(0.05)
  })
}
