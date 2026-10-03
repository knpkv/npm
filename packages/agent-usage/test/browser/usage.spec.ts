import { expect, type Page, test } from "@playwright/test"

/** Signs in with the owner cookie the fixture hands out, as the bootstrap exchange would. */
const signIn = async (page: Page) => {
  const token = await (await page.request.get("/__test/session")).text()
  await page.context().addCookies([{ name: "agent_usage_owner", value: token, url: "http://127.0.0.1:4180/api" }])
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "Agent usage" })).toBeVisible()
}

test("the printed URL signs in once and leaves no code in the address bar", async ({ page }) => {
  const url = await (await page.request.get("/__test/bootstrap")).text()
  await page.goto(url)
  await expect(page.getByRole("heading", { name: "Agent usage" })).toBeVisible()
  expect(page.url()).toBe("http://127.0.0.1:4180/")
})

test("usage is stacked by booking, with typed non-project keys listed rather than booked", async ({ page }) => {
  await signIn(page)
  const table = page.getByRole("table", { name: "Bookings in this range" })
  await expect(table.getByRole("button", { name: "RPS-12" })).toBeVisible()
  await expect(table.getByRole("button", { name: "tools (repo)" })).toBeVisible()
  await expect(table.getByRole("button", { name: "GPT-6" })).toHaveCount(0)
  await expect(page.getByText("GPT (1 requests)", { exact: false })).toBeVisible()
  await expect(page.getByRole("img", { name: "Usage per day, stacked by booking" })).toBeVisible()
})

test("unpriced tokens are called out, and the booking shows ? instead of a number", async ({ page }) => {
  await signIn(page)
  await expect(page.getByText("tokens have no price", { exact: false })).toContainText("claude-unreleased-9")
  const row = page.getByRole("row").filter({ has: page.getByRole("button", { name: "RPS-12" }) })
  await expect(row).toContainText("+ ?")
})

test("tiles show the observed limit window and balance", async ({ page }) => {
  await signIn(page)
  const tiles = page.getByRole("region", { name: "Current limits and balances" })
  await expect(tiles.getByRole("heading", { name: "Claude 5h" })).toBeVisible()
  await expect(tiles).toContainText("42%")
  await expect(tiles).toContainText("5K credits")
})

test("picking a booking draws only it, and Show all brings the rest back", async ({ page }) => {
  await signIn(page)
  await page.getByRole("button", { name: "RPS-12" }).click()
  await expect(page.getByRole("heading", { name: "Usage by booking — RPS-12 only" })).toBeVisible()
  await page.getByRole("button", { name: "Show all" }).click()
  await expect(page.getByRole("heading", { name: "Usage by booking", exact: true })).toBeVisible()
})

test("the page fits a phone without horizontal page scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await signIn(page)
  await expect(page.getByRole("img", { name: "Usage per day, stacked by booking" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Claude 5h" })).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})
