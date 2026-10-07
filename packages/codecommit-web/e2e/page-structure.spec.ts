import { expect, type Page, test } from "@playwright/test"

const pullRequest = {
  account: { profile: "production", region: "eu-west-1", awsAccountId: "111122223333" },
  approvalRules: [],
  approvedBy: [],
  approvedByArns: [],
  author: "andrey",
  commentedBy: [],
  creationDate: "2026-08-01T00:00:00.000Z",
  destinationBranch: "main",
  id: "42",
  isApproved: false,
  isMergeable: true,
  lastModifiedDate: "2026-08-02T00:00:00.000Z",
  link: "https://example.invalid/pr/42",
  repositoryName: "example-repository",
  sourceBranch: "feature",
  status: "OPEN",
  title: "Structured page"
}

/** A signed-in session with one pull request. Endpoints a test does not stub answer with the app's HTML, so they fail to decode. */
const stubSession = async (page: Page) => {
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
  await page.route("**/api/prs/comments*", (route) => route.fulfill({ json: [] }))
  await page.route("**/api/events/", (route) =>
    route.fulfill({
      body: `data: ${
        JSON.stringify({
          accounts: [],
          currentUser: "viewer",
          pullRequests: [pullRequest],
          sandboxes: [],
          status: "idle",
          enabledProfiles: ["production"]
        })
      }\n\n`,
      contentType: "text/event-stream"
    }))
}

const settingsTitles = {
  accounts: "Accounts",
  refresh: "Auto-refresh",
  relay: "Relay review profiles",
  sandbox: "Sandbox",
  notifications: "Notifications",
  permissions: "API Permissions",
  audit: "Audit Log",
  theme: "Theme",
  config: "Configuration",
  about: "About"
}

// QA-164: every settings tab is a page with one level-one heading, inside the app's main landmark.
for (const [tab, title] of Object.entries(settingsTitles)) {
  test(`settings ${tab} has one h1 inside main`, async ({ page }) => {
    await stubSession(page)
    await page.goto(`/settings/${tab}`)
    await expect(page.getByRole("main").getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible()
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1)
  })
}

// A failed config read is stated in the tab, never thrown out of the page.
test("settings accounts says the config failed to load and keeps the page", async ({ page }) => {
  await stubSession(page)
  await page.route("**/api/config", (route) => route.fulfill({ status: 500, json: { _tag: "InternalServerError" } }))
  await page.goto("/settings/accounts")
  await expect(page.getByRole("main").getByRole("heading", { level: 1, name: "Accounts" })).toBeVisible()
  await expect(page.getByText("Failed to load config")).toBeVisible()
})

// QA-164 / the Stats crash: a failed /api/stats keeps the app shell, the h1 and says so.
test("stats keeps its h1 and main when the stats read fails", async ({ page }) => {
  await stubSession(page)
  await page.route("**/api/stats*", (route) => route.fulfill({ status: 502, body: "Bad gateway" }))
  await page.goto("/stats")
  await expect(page.getByRole("main").getByRole("heading", { level: 1, name: "Statistics" })).toBeVisible()
  await expect(page.getByText("Failed to load stats")).toBeVisible()
  await expect(page.getByText("Unexpected Application Error")).toHaveCount(0)
})

// QA-163: links inside a sentence are underlined, not told apart by colour alone.
test("the author link in the pull request sentence is underlined", async ({ page }) => {
  await stubSession(page)
  await page.goto("/accounts/production/prs/42?repository=example-repository&region=eu-west-1")
  const author = page.getByRole("main").getByRole("link", { name: "andrey", exact: true }).first()
  await expect(author).toBeVisible()
  await expect(author).toHaveCSS("text-decoration-line", "underline")
})
