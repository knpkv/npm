import { expect, type Page, test } from "@playwright/test"

/** A signed-in session whose queue holds nothing: the route's pull request is not cached. */
const emptySession = async (page: Page) => {
  await page.route("**/api/session/current", (route) => route.fulfill({ status: 204 }))
  await page.route("**/api/config", (route) =>
    route.fulfill({
      json: {
        accounts: [],
        autoDetect: false,
        autoRefresh: false,
        refreshIntervalSeconds: 300,
        review: { defaultProfileId: "synthetic", profiles: [] }
      }
    }))
  await page.route("**/api/subscriptions", (route) => route.fulfill({ json: [] }))
  await page.route("**/api/events/", (route) =>
    route.fulfill({
      body: `data: ${
        JSON.stringify({
          accounts: [],
          currentUser: "viewer",
          pullRequests: [],
          sandboxes: [],
          status: "idle",
          enabledProfiles: []
        })
      }\n\n`,
      contentType: "text/event-stream"
    }))
}

const route = "/accounts/590183972381/prs/44?repository=payments&region=eu-central-1"

// QA-168: a pull request URL for a switched-off account spun on "Loading pull request" forever.
test("a switched-off account says so and links to Settings → Accounts", async ({ page }) => {
  await emptySession(page)
  const message = "dev-administratoraccess is switched off, so this pull request can't be read. " +
    "Switch it on in Settings → Accounts."
  await page.route("**/api/prs/590183972381/44/refresh*", (request) =>
    request.fulfill({
      status: 409,
      json: { _tag: "AccountSwitchedOffApiError", message, profile: "dev-administratoraccess" }
    }))
  await page.goto(route)

  const main = page.getByRole("main")
  await expect(main.getByText("Can't read this pull request")).toBeVisible()
  await expect(main.getByText(message)).toBeVisible()
  await expect(main.getByText("Loading pull request")).toHaveCount(0)
  await main.getByRole("button", { name: "Open Settings → Accounts" }).click()
  await expect(page).toHaveURL(/\/settings\/accounts$/)
})

test("any other failed first read shows its reason and a retry, never an endless spinner", async ({ page }) => {
  await emptySession(page)
  let reads = 0
  await page.route("**/api/prs/590183972381/44/refresh*", (request) => {
    reads += 1
    return request.fulfill({ status: 500, json: { _tag: "ApiError", message: "Throttled: Rate exceeded" } })
  })
  await page.goto(route)

  const main = page.getByRole("main")
  await expect(main.getByText("Throttled: Rate exceeded")).toBeVisible()
  await expect(main.getByRole("button", { name: "Open Settings → Accounts" })).toHaveCount(0)
  const before = reads
  await main.getByRole("button", { name: "Try again" }).click()
  await expect.poll(() => reads).toBeGreaterThan(before)
})
