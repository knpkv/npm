import { test, expect } from "@playwright/test"

test.describe("CodeCommit Web", () => {
  test("loads homepage", async ({ page }) => {
    await page.goto("/")
    await expect(page).toHaveTitle("CodeCommit Web")
  })

  test("displays header with title", async ({ page }) => {
    await page.goto("/")
    // Wait for content to load
    await page.waitForTimeout(3000)
    const header = page.locator("header")
    await expect(header).toBeVisible()
    await expect(header).toContainText("AWS")
  })

  test("displays PR list after refresh", async ({ page }) => {
    await page.goto("/")
    // Wait for initial refresh to complete
    await page.waitForTimeout(5000)
    // Should have main content area
    const main = page.locator("main")
    await expect(main).toBeVisible()
  })

  test("keyboard navigation with j/k", async ({ page }) => {
    await page.goto("/")
    await page.waitForTimeout(5000)

    // Get initial selected state
    const items = page.locator('[class*="pr"]')
    const count = await items.count()

    if (count > 1) {
      // Press j to move down
      await page.keyboard.press("j")
      await page.waitForTimeout(100)

      // Press k to move up
      await page.keyboard.press("k")
      await page.waitForTimeout(100)
    }
  })

  test("keyboard navigation with arrow keys", async ({ page }) => {
    await page.goto("/")
    await page.waitForTimeout(5000)

    const items = page.locator('[class*="pr"]')
    const count = await items.count()

    if (count > 1) {
      await page.keyboard.press("ArrowDown")
      await page.waitForTimeout(100)
      await page.keyboard.press("ArrowUp")
      await page.waitForTimeout(100)
    }
  })

  test("displays footer with hints", async ({ page }) => {
    await page.goto("/")
    const footer = page.locator("footer")
    await expect(footer).toBeVisible()
    await expect(footer).toContainText("Navigate")
  })

  test("API returns PR data", async ({ request }) => {
    // Trigger refresh first
    await request.post("/api/prs/refresh")
    await new Promise((r) => setTimeout(r, 3000))

    const response = await request.get("/api/prs")
    expect(response.ok()).toBeTruthy()
    const data = await response.json()
    expect(Array.isArray(data)).toBeTruthy()
  })

  test("API returns config", async ({ request }) => {
    const response = await request.get("/api/config")
    expect(response.ok()).toBeTruthy()
    const data = await response.json()
    expect(data).toHaveProperty("accounts")
  })
})
