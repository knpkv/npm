import { expect, test } from "@playwright/test"

test("keeps the foundation catalog readable at 320 CSS pixels", async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 320 })
  await page.goto(
    "/iframe.html?id=foundations-icon--catalog&viewMode=story&globals=theme:dark;forcedColors:auto;reducedMotion:system;locale:en;density:comfortable"
  )
  await expect(page.getByRole("heading", { name: "Interface glyphs" })).toBeVisible()
  const dimensions = await page.locator("html").evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth
  }))
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client)
})
