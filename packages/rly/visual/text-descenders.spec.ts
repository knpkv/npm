import { expect, test } from "./fixtures.ts"

// Display type (verdict, page-title) sits on a line height under 1, so descenders hang below the line box.
// The box must still reach them, so a focus ring drawn just outside it never cuts through a glyph, and the
// matching negative margin must give the space back so the layout doesn't move.
test("display headings' boxes reach their descenders without moving the layout", async ({ page }) => {
  await page.goto(
    "/iframe.html?id=primitives-text--gallery&viewMode=story&globals=theme:light;forcedColors:auto;reducedMotion:system;locale:en;density:comfortable"
  )
  await expect(page.locator("[data-text-variant='page-title']")).toBeVisible()
  const measured = await page.evaluate(async () => {
    await document.fonts.ready
    return ["verdict", "page-title"].map((variant) => {
      const element = document.querySelector<HTMLElement>(`[data-text-variant='${variant}']`)
      if (element === null) return { variant, missing: true }
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
      const inkDescent = context.measureText(element.textContent ?? "").actualBoundingBoxDescent
      return {
        variant,
        boxBottom: element.getBoundingClientRect().bottom,
        inkBottom: baseline + inkDescent,
        marginEnd: Number.parseFloat(styles.marginBlockEnd),
        paddingEnd: Number.parseFloat(styles.paddingBlockEnd)
      }
    })
  })
  for (const entry of measured) {
    expect(entry, `${entry.variant} is in the gallery`).not.toHaveProperty("missing")
    if ("missing" in entry) continue
    expect(entry.boxBottom, `${entry.variant} box reaches its descenders`).toBeGreaterThanOrEqual(entry.inkBottom - 0.5)
    expect(entry.paddingEnd, `${entry.variant} grows by the overhang`).toBeGreaterThan(0)
    expect(entry.marginEnd, `${entry.variant} gives the overhang back`).toBeCloseTo(-entry.paddingEnd, 3)
  }
})
