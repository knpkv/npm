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
  const table = page.getByRole("table", { name: "Bookings" })
  await expect(table.getByRole("button", { name: "RPS-12" })).toBeVisible()
  await expect(table.getByRole("button", { name: "tools (repo)" })).toBeVisible()
  await expect(table.getByRole("button", { name: "GPT-6" })).toHaveCount(0)
  const status = page.getByRole("contentinfo", { name: "Ingest status" })
  await status.getByText("Ignored ticket-like keys").click()
  await expect(status.getByText("GPT (1 requests)", { exact: false })).toBeVisible()
  await expect(page.getByRole("group", { name: "Usage per day, stacked by booking" })).toBeVisible()
})

test("unpriced tokens are called out, and the booking shows ? instead of a number", async ({ page }) => {
  await signIn(page)
  await expect(page.getByText("tokens have no price", { exact: false })).toContainText("claude-unreleased-9")
  const row = page.getByRole("row").filter({ has: page.getByRole("button", { name: "RPS-12" }) })
  await expect(row).toContainText("+ ?")
})

test("limits now groups each agent's windows with a meter, a tone word and the balances", async ({ page }) => {
  await signIn(page)
  const claude = page.getByRole("region", { name: "Claude limits" })
  await expect(claude.getByRole("meter", { name: "Claude 5-hour used" })).toHaveAttribute("aria-valuenow", "42")
  // A healthy window shows its level and reading age, not a badge.
  await expect(claude.getByText("OK", { exact: true })).toHaveCount(0)
  await expect(claude).toContainText("read")
  await expect(page.getByRole("region", { name: "Limits now" })).toContainText("5K credits")
})

test("the usage panel leads with the range total and explains API-equivalent cost on demand", async ({ page }) => {
  await signIn(page)
  const panel = page.getByRole("region", { name: /^Usage by booking/ })
  await expect(panel.getByTestId("usage-total")).toHaveText(/^\$[\d,.]+$/)
  await expect(panel.getByText("not what a subscription charges", { exact: false })).toBeHidden()
  await panel.getByText("What is API-equivalent?").click()
  await expect(panel.getByText("not what a subscription charges", { exact: false })).toBeVisible()
})

test("picking a booking draws only it, and Show all brings the rest back", async ({ page }) => {
  await signIn(page)
  await page.getByRole("button", { name: "RPS-12" }).click()
  await expect(page.getByRole("heading", { name: "Usage by booking — RPS-12 only" })).toBeVisible()
  await page.getByRole("button", { name: "Show all" }).click()
  await expect(page.getByRole("heading", { name: "Usage by booking", exact: true })).toBeVisible()
})

test("changing the agent filter drops a picked booking, so the chart is never left empty", async ({ page }) => {
  await signIn(page)
  await page.getByRole("button", { name: "tools (repo)" }).click()
  await expect(page.getByRole("heading", { name: "Usage by booking — tools (repo) only" })).toBeVisible()
  await page.getByRole("radiogroup", { name: "Agent" }).getByRole("radio", { name: "Codex" }).click()
  await expect(page.getByRole("heading", { name: "Usage by booking", exact: true })).toBeVisible()
})

test("a reload without a working session says how to get back in instead of showing empty charts", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByText("Could not sign in")).toBeVisible()
})

test("every limit reading is also available as a table, without hovering", async ({ page }) => {
  await signIn(page)
  await page.getByText("Limit readings as a table").click()
  const table = page.locator(".usage-readings table")
  await expect(table.getByRole("rowheader", { name: "Claude 5-hour" })).toBeVisible()
  await expect(table).toContainText("42%")
})

test("the page fits a phone without horizontal page scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await signIn(page)
  await expect(page.getByRole("group", { name: "Usage per day, stacked by booking" })).toBeVisible()
  await expect(page.getByRole("region", { name: "Claude limits" }).getByRole("meter")).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})

test("the filters are named radio groups that arrow keys move through", async ({ page }) => {
  await signIn(page)
  const range = page.getByRole("radiogroup", { name: "Range" })
  await expect(range.getByRole("radio", { name: "7d" })).toHaveAttribute("aria-checked", "true")
  await range.getByRole("radio", { name: "7d" }).focus()
  await page.keyboard.press("ArrowRight")
  await expect(range.getByRole("radio", { name: "30d" })).toBeFocused()
})

test("each usage column can be reached by keyboard and says its total and bookings", async ({ page }) => {
  await signIn(page)
  const chart = page.getByRole("group", { name: "Usage per day, stacked by booking" })
  const columns = chart.getByRole("img")
  const last = columns.last()
  await last.focus()
  await expect(last).toHaveAccessibleName(/total/)
  await expect(page.getByRole("status").filter({ hasText: "Total" })).toBeVisible()
  await page.keyboard.press("ArrowLeft")
  await expect(columns.nth((await columns.count()) - 2)).toBeFocused()
  await page.keyboard.press("Home")
  await expect(columns.first()).toBeFocused()
})
