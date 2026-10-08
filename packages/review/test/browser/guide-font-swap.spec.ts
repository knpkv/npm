import { expect, test } from "@playwright/test"
import * as Effect from "effect/Effect"
import { readFileSync, writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import {
  externaliseInlineFonts,
  FONT_SWAP_LAUNCH_OPTIONS,
  measureFontSwapShift
} from "../../../../playwright-font-swap.ts"
import { exportGuide } from "../../dist/guide/export.js"

test.use({ launchOptions: FONT_SWAP_LAUNCH_OPTIONS })

/** The illustrative guide as exported, its fonts inlined. */
const guideHtml = () =>
  Effect.runPromise(
    exportGuide({
      findings: JSON.parse(readFileSync("examples/approval-guide/findings.json", "utf8")),
      guide: JSON.parse(readFileSync("examples/approval-guide/guide.json", "utf8")),
      patch: readFileSync("examples/approval-guide/guide.patch", "utf8")
    })
  ).then((page) => page.html)

for (const width of [390, 1440]) {
  // The guide no longer hides itself until its inlined fonts decode: the metric-matched fallback it
  // paints first must hold every line and row when Geist arrives (rly font-swap budget).
  test(`Geist swaps in without moving the guide at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    const { fonts, text } = externaliseInlineFonts(await guideHtml())
    const file = testInfo.outputPath("guide.html")
    writeFileSync(file, text)
    const swap = await measureFontSwapShift(page, {
      inlineFonts: fonts,
      load: async () => {
        await page.goto(pathToFileURL(file).href, { waitUntil: "commit" })
      },
      probe: "h1",
      // Hydrated and the diagram drawn, so only the fonts can move the page after the release.
      ready: ".mermaid[data-processed=\"true\"] svg"
    })
    expect(swap.sum, swap.report).toBeLessThanOrEqual(0.05)
  })
}
