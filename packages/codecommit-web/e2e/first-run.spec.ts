import { expect, type Page, test } from "@playwright/test"

// First run, as a new user meets it: every state names its cause and its one action, and no count
// the page can't vouch for reads 0.

const emptySnapshot = {
  accounts: [],
  pullRequests: [],
  sandboxes: [],
  status: "idle",
  enabledProfiles: [],
  lastUpdated: "2026-10-06T20:00:00.000Z"
}

const config = {
  accounts: [],
  autoDetect: true,
  autoRefresh: false,
  refreshIntervalSeconds: 300,
  review: { defaultProfileId: "synthetic", profiles: [] }
}

const routeCommon = async (page: Page) => {
  await page.route("**/api/subscriptions", (route) => route.fulfill({ json: [] }))
  await page.route("**/api/prs/comments*", (route) => route.fulfill({ json: [] }))
}

test("says this browser isn't signed in when the session is refused, with no zero counts", async ({ page }) => {
  await routeCommon(page)
  await page.route("**/api/events/", (route) => route.fulfill({ status: 401 }))
  await page.route("**/api/config", (route) => route.fulfill({ status: 401 }))

  await page.goto("/")
  await expect(page.getByText("This browser isn't signed in", { exact: true })).toBeVisible()
  await expect(page.getByText("Open the sign-in link that codecommit web printed.", { exact: false })).toBeVisible()
  await expect(page.getByRole("status").filter({ hasText: "Not signed in" })).toBeVisible()
  const facets = page.getByRole("group", { name: "Pull request facets" })
  await expect(facets.getByLabel("unknown")).toHaveCount(4)
  await expect(facets.getByText("0", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("searchbox")).toHaveCount(0)
})

test("names an unreachable server and retries on request", async ({ page }) => {
  await routeCommon(page)
  let streamCalls = 0
  await page.route("**/api/events/", (route) => {
    streamCalls += 1
    return route.fulfill({ status: 503 })
  })
  await page.route("**/api/config", (route) => route.fulfill({ status: 503 }))

  await page.goto("/")
  await expect(page.getByText("Can't reach the CodeCommit server", { exact: true })).toBeVisible()
  await expect(page.getByText("The CodeCommit server answered 503.", { exact: false }).first()).toBeVisible()
  const before = streamCalls
  await page.getByRole("button", { name: "Retry now" }).click()
  await expect.poll(() => streamCalls).toBeGreaterThan(before)
})

test("sends a first run with no AWS profiles to setup, which shows where it looked", async ({ page }) => {
  await routeCommon(page)
  await page.route(
    "**/api/events/",
    (route) => route.fulfill({ body: `data: ${JSON.stringify(emptySnapshot)}\n\n`, contentType: "text/event-stream" })
  )
  await page.route("**/api/config", (route) => route.fulfill({ json: config }))
  await page.route("**/api/config/path", (route) =>
    route.fulfill({
      json: {
        awsProfileSources: { config: "/home/new/.aws/config", credentials: "/home/new/.aws/credentials" },
        exists: false,
        path: "/home/new/.codecommit/config.json"
      }
    }))

  await page.goto("/")
  await expect(page.getByText("No AWS profiles yet", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Set up accounts" }).click()

  await expect(page.getByText("No AWS profiles found", { exact: true })).toBeVisible()
  await expect(page.getByText("/home/new/.aws/config", { exact: true })).toBeVisible()
  await expect(page.getByText("aws configure sso", { exact: false })).toBeVisible()
  await expect(page.getByText("Not logged in")).toBeHidden()
  await page.getByRole("button", { name: "Detect again" }).click()
  await expect(page.getByRole("status").filter({ hasText: "still no profiles" })).toBeVisible()
})
