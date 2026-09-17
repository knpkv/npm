import { expect, test } from "@playwright/test"

const pullRequest = (profile: string, id: string) => ({
  account: { profile, region: "eu-west-1", awsAccountId: "111122223333" },
  approvalRules: [],
  approvedBy: [],
  approvedByArns: [],
  author: "author",
  commentedBy: [],
  creationDate: "2026-08-01T00:00:00.000Z",
  destinationBranch: "main",
  id,
  isApproved: false,
  isMergeable: true,
  lastModifiedDate: "2026-08-02T00:00:00.000Z",
  link: `https://example.invalid/pr/${id}`,
  repositoryName: "example-repository",
  sourceBranch: "feature",
  status: "OPEN",
  title: `Change from ${profile}`
})

// Cross the wire decoder and real queue/sidebar components with the same cache
// throughout. A missing enabledProfiles field must differ from an empty array.
test("filters queues and facets without losing disabled-account detail routes", async ({ page }) => {
  let enabledProfiles: ReadonlyArray<string> | undefined = ["kept-profile"]
  const pullRequests = [pullRequest("kept-profile", "11"), pullRequest("disabled-profile", "22")]
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
          pendingReviewCount: 0,
          pullRequests,
          sandboxes: [],
          status: "idle",
          enabledProfiles
        })
      }\n\n`,
      contentType: "text/event-stream"
    }))

  await page.goto("/")
  await expect(page.getByRole("link", { name: "Change from kept-profile" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Change from disabled-profile" })).toHaveCount(0)
  await page.getByRole("button", { name: "Account", exact: true }).click()
  await expect(page.getByRole("option", { name: "Not selected kept-profile", exact: true })).toBeVisible()
  await expect(page.getByRole("option", { name: "Not selected disabled-profile", exact: true })).toHaveCount(0)
  await page.keyboard.press("Escape")

  await page.goto("/accounts/disabled-profile/prs/22?repository=example-repository&region=eu-west-1")
  await expect(page.getByRole("heading", { name: "Change from disabled-profile" })).toBeVisible()

  enabledProfiles = ["kept-profile", "disabled-profile"]
  await page.goto("/")
  await expect(page.getByRole("link", { name: "Change from disabled-profile" })).toBeVisible()

  enabledProfiles = []
  await page.reload()
  // Mine appears only after the wire snapshot supplies currentUser, so an
  // initial empty client state cannot satisfy the empty-queue assertions.
  await expect(page.getByRole("button", { name: "Mine", exact: true })).toBeVisible()
  await expect(page.getByRole("link", { name: "Change from kept-profile" })).toHaveCount(0)
  await expect(page.getByRole("link", { name: "Change from disabled-profile" })).toHaveCount(0)
  await page.getByRole("button", { name: "Account", exact: true }).click()
  await expect(page.getByText("No matching options.")).toBeVisible()
  await page.keyboard.press("Escape")

  enabledProfiles = undefined
  await page.reload()
  await expect(page.getByRole("link", { name: "Change from kept-profile" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Change from disabled-profile" })).toBeVisible()
})
