import { expect, test } from "./fixtures.ts"

// Display type (verdict, page-title) sits on a line height under 1, so accented capitals rise above the box
// and descenders hang below it. The box must still reach both, so a focus ring drawn just outside it never
// cuts through a glyph, and the matching negative margins must give the space back so nothing moves.
// Service and release names are user text, so the sample carries the tallest accents and deep descenders.
test("display headings' boxes reach accented capitals and descenders without moving the layout", async ({ page }) => {
  await page.goto(
    "/iframe.html?id=primitives-text--gallery&viewMode=story&globals=theme:light;forcedColors:auto;reducedMotion:system;locale:en;density:comfortable"
  )
  await expect(page.locator("[data-text-variant='page-title']")).toBeVisible()
  const measured = await page.evaluate(async () => {
    await document.fonts.ready
    return ["verdict", "page-title"].map((variant) => {
      const element = document.querySelector<HTMLElement>(`[data-text-variant='${variant}']`)
      if (element === null) return { variant, missing: true }
      element.textContent = "ÅÉÜ payments-api gjpqy"
      const styles = getComputedStyle(element)
      // An empty inline-block aligned to the baseline marks where the baseline sits.
      const probe = document.createElement("span")
      probe.style.display = "inline-block"
      probe.style.blockSize = "0"
      element.append(probe)
      const baseline = probe.getBoundingClientRect().top
      probe.remove()
      const context = document.createElement("canvas").getContext("2d")
      if (context === null) return { variant, missing: true }
      context.font = `${styles.fontWeight} ${styles.fontSize} ${styles.fontFamily}`
      const ink = context.measureText(element.textContent)
      const box = element.getBoundingClientRect()
      return {
        variant,
        boxBottom: box.bottom,
        boxTop: box.top,
        inkBottom: baseline + ink.actualBoundingBoxDescent,
        inkTop: baseline - ink.actualBoundingBoxAscent,
        marginEnd: Number.parseFloat(styles.marginBlockEnd),
        marginStart: Number.parseFloat(styles.marginBlockStart),
        paddingEnd: Number.parseFloat(styles.paddingBlockEnd),
        paddingStart: Number.parseFloat(styles.paddingBlockStart)
      }
    })
  })
  for (const entry of measured) {
    expect(entry, `${entry.variant} is in the gallery`).not.toHaveProperty("missing")
    if ("missing" in entry) continue
    expect(entry.boxTop, `${entry.variant} box reaches its accented capitals`).toBeLessThanOrEqual(entry.inkTop + 0.5)
    expect(entry.boxBottom, `${entry.variant} box reaches its descenders`).toBeGreaterThanOrEqual(entry.inkBottom - 0.5)
    expect(entry.marginStart, `${entry.variant} gives the top overhang back`).toBeCloseTo(-entry.paddingStart, 3)
    expect(entry.paddingEnd, `${entry.variant} grows by the overhang`).toBeGreaterThan(0)
    expect(entry.marginEnd, `${entry.variant} gives the overhang back`).toBeCloseTo(-entry.paddingEnd, 3)
  }
})
