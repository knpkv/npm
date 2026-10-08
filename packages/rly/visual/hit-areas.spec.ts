import { expect, test } from "./fixtures.ts"

// Controls that stay visually small carry data-rly-hit-area: an invisible ::after grows each short side to
// 44px. A tap just outside the visible box, but inside that 44px band, must still land on the control, and no
// two controls' hit areas may overlap, or a tap between neighbours could land on the wrong one.
const stories = [
  "patterns-entitytable--states",
  "patterns-relayfindings--review-findings",
  "diff-diffworkbench--compact-forced-colors",
  "patterns-agentdrawer--compact-forced-colors"
]

for (const id of stories) {
  test(`small controls in ${id} answer taps across a 44px area`, async ({ page }) => {
    await page.goto(
      `/iframe.html?id=${id}&viewMode=story&globals=theme:light;forcedColors:auto;reducedMotion:system;locale:en;density:comfortable`
    )
    await expect(page.locator("[data-rly-hit-area]").first()).toBeVisible()
    const misses = await page.evaluate(() => {
      const found: Array<string> = []
      const areas: Array<
        {
          readonly name: string
          readonly top: number
          readonly right: number
          readonly bottom: number
          readonly left: number
        }
      > = []
      for (const element of document.querySelectorAll<HTMLElement>("[data-rly-hit-area]")) {
        // elementFromPoint only sees the viewport, so bring each control into it first.
        element.scrollIntoView({ block: "center", inline: "center" })
        const box = element.getBoundingClientRect()
        if (box.width === 0 || box.height === 0) continue
        const reach = (side: number): number => Math.max(0, (44 - side) / 2 - 1)
        const centreX = box.left + box.width / 2
        const centreY = box.top + box.height / 2
        // A control the layout hides (a compact table's visually hidden header row) takes no taps at all.
        const centre = document.elementFromPoint(centreX, centreY)
        if (centre === null || !element.contains(centre)) continue
        const name = element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "?"
        // The hit area in document coordinates, since each control is scrolled to before it is measured.
        const growY = Math.max(0, (44 - box.height) / 2)
        const growX = Math.max(0, (44 - box.width) / 2)
        areas.push({
          bottom: box.bottom + growY + window.scrollY,
          left: box.left - growX + window.scrollX,
          name,
          right: box.right + growX + window.scrollX,
          top: box.top - growY + window.scrollY
        })
        const points: Array<readonly [string, number, number]> = []
        if (box.height < 44) {
          points.push(["above", centreX, box.top - reach(box.height)], [
            "below",
            centreX,
            box.bottom + reach(box.height)
          ])
        }
        if (box.width < 44) {
          points.push(["before", box.left - reach(box.width), centreY], [
            "after",
            box.right + reach(box.width),
            centreY
          ])
        }
        for (const [where, x, y] of points) {
          const hit = document.elementFromPoint(x, y)
          if (hit === null || !element.contains(hit)) {
            found.push(`${name} ${where}`)
          }
        }
      }
      // Touching edges are fine; any shared area (beyond half a pixel of rounding) is not.
      areas.forEach((area, index) => {
        for (const other of areas.slice(index + 1)) {
          const overlapX = Math.min(area.right, other.right) - Math.max(area.left, other.left)
          const overlapY = Math.min(area.bottom, other.bottom) - Math.max(area.top, other.top)
          if (overlapX > 0.5 && overlapY > 0.5) found.push(`${area.name} overlaps ${other.name}`)
        }
      })
      return found
    })
    expect(misses).toEqual([])
  })
}
