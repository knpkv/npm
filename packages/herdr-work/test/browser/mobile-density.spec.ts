import { expect, test } from "@playwright/test"

const iPhoneViewports = [
  { height: 844, width: 390 },
  { height: 852, width: 393 }
]

for (const viewport of iPhoneViewports) {
  test(`${viewport.width}x${viewport.height} bounds and compacts 47 goals`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.goto("/test/browser/fixture.html")

    const rows = page.locator(".work-board-row")
    await expect(rows).toHaveCount(10)
    await expect(page.getByText("Showing 10 of 47 goals")).toBeVisible()
    await expect(page.getByRole("group", { name: "Filter goals by status" })).toBeVisible()

    const measurements = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      rowHeights: [...document.querySelectorAll(".work-board-row")].map(({ clientHeight }) => clientHeight),
      scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth
    }))
    expect(measurements.scrollWidth).toBeLessThanOrEqual(measurements.clientWidth)
    expect(Math.max(...measurements.rowHeights)).toBeLessThanOrEqual(132)
    expect(measurements.scrollHeight).toBeLessThanOrEqual(2_800)

    await page.getByRole("button", { name: "Load 10 more" }).click()
    await expect(rows).toHaveCount(20)
    await expect(page.getByText("Showing 20 of 47 goals")).toBeVisible()
  })
}

test("393x852 keeps a deep-linked goal outside the first page selected", async ({ page }) => {
  await page.setViewportSize({ height: 852, width: 393 })
  await page.goto("/test/browser/fixture.html?goal=goal-47")

  await expect(page.locator(".work-board-row")).toHaveCount(10)
  await expect(page.getByRole("button", { name: /Goal 47/ })).toHaveAttribute("aria-pressed", "true")
  await expect(page.getByRole("complementary", { name: "Goal details" })).toContainText(
    "Goal 47 has one focused detail"
  )
})

test("crowded desktop toolbar keeps the goal count fixed-width", async ({ page }) => {
  await page.setViewportSize({ height: 852, width: 800 })
  await page.goto("/test/browser/fixture.html")

  const goalCount = page.getByText("Showing 10 of 47 goals")
  await expect(goalCount).toBeVisible()
  await expect(goalCount).toHaveCSS("flex-shrink", "0")
})
