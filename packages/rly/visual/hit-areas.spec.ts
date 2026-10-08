import { expect, test } from "./fixtures.ts"

// Controls that stay visually small carry data-rly-hit-area: an invisible ::after grows each short side to
// 44px. A tap just outside the visible box, but inside that 44px band, must still land on the control.
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
      for (const element of document.querySelectorAll<HTMLElement>("[data-rly-hit-area]")) {
        const box = element.getBoundingClientRect()
        if (box.width === 0 || box.height === 0) continue
        const reach = (side: number): number => Math.max(0, (44 - side) / 2 - 1)
        const centreX = box.left + box.width / 2
        const centreY = box.top + box.height / 2
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
            found.push(`${element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "?"} ${where}`)
          }
        }
      }
      return found
    })
    expect(misses).toEqual([])
  })
}
