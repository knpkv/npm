import { expect, type Page, test } from "@playwright/test"

const story = (id: string, forcedColors = "auto"): string =>
  `/iframe.html?id=${id}&viewMode=story&globals=theme:dark;forcedColors:${forcedColors};reducedMotion:reduce;locale:en;density:comfortable`

const expectNoHorizontalOverflow = async (page: Page): Promise<void> => {
  const dimensions = await page.locator("html").evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth
  }))
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client)
}

test("preserves persisted relay identity and exact geometry in forced colors", async ({ page }, testInfo) => {
  await page.setViewportSize({ height: 700, width: 320 })
  await page.goto(story("patterns-releaserelay--geometry-forced-colors", "active"))

  const compact = page.getByRole("img", {
    name: "Release relay, Copper Orbit, symbols bridge, wave, beacon."
  })
  const hero = page.getByRole("img", {
    name: "Release relay, Layered Anchor, symbols stack, brace, anchor."
  })
  await expect(compact).toBeVisible()
  await expect(hero).toBeVisible()
  expect(Math.round((await compact.boundingBox())?.width ?? 0)).toBe(80)
  expect(Math.round((await hero.boundingBox())?.width ?? 0)).toBe(140)
  await expect(compact.locator("[data-rly-release-symbol-index]")).toHaveCount(3)
  await expect(hero.locator("[data-rly-release-symbol-index]")).toHaveCount(3)
  await expect(page.locator("[data-rly-release-relay-handoff]")).toHaveCount(2)
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ animations: "disabled", fullPage: true, path: testInfo.outputPath("relay-320.png") })
})

test("keeps giant verdict words neutral and reasons explicit at 320 pixels", async ({ page }, testInfo) => {
  await page.setViewportSize({ height: 1_100, width: 320 })
  await page.goto(story("patterns-verdict--states"))

  for (const verdict of ["Held.", "Blocked.", "Unavailable.", "Ready.", "Deploying."]) {
    await expect(page.getByRole("heading", { exact: true, name: verdict })).toBeVisible()
  }
  const verdictColors = await page.locator("[data-rly-verdict-tone] > h2").evaluateAll((headings) =>
    headings.map((heading) => getComputedStyle(heading).color)
  )
  expect(new Set(verdictColors).size).toBe(1)
  await expect(page.getByText("Every required check and approval matches the current release head.")).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ animations: "disabled", fullPage: true, path: testInfo.outputPath("verdict-320.png") })
})
