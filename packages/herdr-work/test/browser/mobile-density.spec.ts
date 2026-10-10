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
  // The design names the inspector Goal details; the selected goal title remains inside it.
  await expect(page.getByRole("region", { name: "Goal details" })).toContainText("Goal 47 has one focused detail")
})

test("an 800px window keeps the status rail inside the page", async ({ page }) => {
  await page.setViewportSize({ height: 852, width: 800 })
  await page.goto("/test/browser/fixture.html")

  await expect(page.getByText("Showing 10 of 47 goals")).toBeVisible()
  await expect(page.getByRole("group", { name: "Filter goals by status" })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(800)
})

for (const viewport of iPhoneViewports) {
  test(`${viewport.width}x${viewport.height} wraps an unbroken branch inside the page`, async ({ page }) => {
    await page.setViewportSize(viewport)
    const widths = async () =>
      page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth
      }))

    await page.goto("/test/browser/fixture.html?long")
    // Branch belongs to the inspector; the board shows the goal and agent's delivery stage.
    await expect(page.getByText("Work checkpoint recovery and reconciliation for the fleet coordinator")).toBeVisible()
    const board = await widths()
    expect(board.scrollWidth).toBeLessThanOrEqual(board.clientWidth)

    await page.goto("/test/browser/fixture.html?long&goal=goal-2")
    await expect(page.getByRole("region", { name: "Goal details" })).toBeVisible()
    await expect(page.getByText("feat/implementWorkCheckpointRecoveryAndReconciliation")).toBeVisible()
    const detail = await widths()
    expect(detail.scrollWidth).toBeLessThanOrEqual(detail.clientWidth)
  })
}

test("390px keeps Open beside the request title and its age below", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 })
  await page.goto("/test/browser/fixture.html?fidelity=3a")
  await page.evaluate(() => document.fonts.ready)
  const request = page.locator(".work-board-row").filter({ hasText: "Fix offline-backup flake" })
  const positions = await request.evaluate((row) => {
    const badge = row.querySelector(".work-request-line .work-row-state")?.getBoundingClientRect()
    const title = row.querySelector(".work-request-title")?.getClientRects()[0]
    const age = row.querySelector(".work-request-age")?.getBoundingClientRect()
    return badge === undefined || title === undefined || age === undefined
      ? null
      : { ageY: age.y, badgeY: badge.y, titleY: title.y }
  })
  expect(positions).not.toBeNull()
  if (positions === null) return
  expect(Math.abs(positions.badgeY - positions.titleY)).toBeLessThanOrEqual(4)
  expect(positions.ageY).toBeGreaterThan(positions.titleY)
})

test("inspector focus follows pointer and keyboard modality", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 })
  await page.goto("/test/browser/fixture.html")
  const row = page.locator(".work-board-row").first()
  const heading = page.getByRole("heading", { name: "Goal details", exact: true })
  await row.click()
  await expect(heading).toBeFocused()
  expect(await heading.evaluate((element) => element.matches(":focus-visible"))).toBe(false)
  await expect(heading).toHaveCSS("outline-style", "none")

  await page.getByRole("button", { name: "Close", exact: true }).click()
  await row.focus()
  await row.press("Enter")
  await expect(heading).toBeFocused()
  expect(await heading.evaluate((element) => element.matches(":focus-visible"))).toBe(true)
  await expect(heading).toHaveCSS("outline-style", "solid")
})
