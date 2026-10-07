import { expect, type Page, test } from "@playwright/test"

const managedRule = {
  poolMemberArns: ["arn:aws:iam::111122223333:user/viewer"],
  poolMembers: ["viewer"],
  requiredApprovals: 1,
  ruleName: "Required approvers",
  satisfied: false
}

const pullRequest = (approvalRules: ReadonlyArray<typeof managedRule>) => ({
  account: { profile: "production", region: "eu-west-1", awsAccountId: "111122223333" },
  approvalRules,
  approvedBy: [],
  approvedByArns: [],
  author: "author",
  commentedBy: [],
  creationDate: "2026-08-01T00:00:00.000Z",
  destinationBranch: "main",
  id: "51",
  isApproved: false,
  isMergeable: true,
  lastModifiedDate: "2026-08-02T00:00:00.000Z",
  link: "https://example.invalid/pr/51",
  repositoryName: "example-repository",
  sourceBranch: "feature",
  status: "OPEN",
  title: "Rule to remove"
})

const detail = "/accounts/production/prs/51?repository=example-repository&region=eu-west-1"

/** Serves the detail page; the stream reconnects after each event, and serves whatever `rules()` says now. */
const serve = async (page: Page, rules: () => ReadonlyArray<typeof managedRule>) => {
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
          enabledProfiles: ["production"],
          pullRequests: [pullRequest(rules())],
          sandboxes: [],
          status: "idle"
        })
      }\n\n`,
      contentType: "text/event-stream"
    }))
}

// Removing the page's own rule refreshes the pull request once the provider deleted it, so the rule
// and its Remove button go away without waiting on a background refresh; a failed delete keeps both.
test("refreshes after removing its own approval rule", async ({ page }) => {
  let deleted = false
  let refreshes = 0
  await serve(page, () => (deleted ? [] : [managedRule]))
  await page.route("**/api/prs/approval-rules", (route) => {
    deleted = true
    return route.fulfill({ json: "ok" })
  })
  await page.route("**/api/prs/*/51/refresh*", (route) => {
    refreshes += 1
    return route.fulfill({ json: { headCommit: "c".repeat(40), revisionId: "revision-1" } })
  })

  await page.goto(detail)
  const remove = page.getByRole("button", { name: "Remove rule" })
  await expect(remove).toBeVisible()
  const before = refreshes
  await remove.click()
  await expect.poll(() => refreshes).toBeGreaterThan(before)
  await expect(remove).toHaveCount(0)
})

test("keeps the rule and says why when removing it fails", async ({ page }) => {
  await serve(page, () => [managedRule])
  await page.route(
    "**/api/prs/approval-rules",
    (route) => route.fulfill({ json: { _tag: "ApiError", message: "AccessDenied" }, status: 500 })
  )

  await page.goto(detail)
  await page.getByRole("button", { name: "Remove rule" }).click()
  await expect(page.getByRole("alert").filter({ hasText: "Couldn't remove the rule" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Remove rule" })).toBeEnabled()
})

test("says the rule is gone when only the refresh after removing it fails, and refreshes on request", async ({ page }) => {
  let deleted = false
  let refreshes = 0
  let failRefresh = true
  await serve(page, () => [managedRule])
  await page.route("**/api/prs/approval-rules", (route) => {
    deleted = true
    return route.fulfill({ json: "ok" })
  })
  await page.route("**/api/prs/*/51/refresh*", (route) => {
    refreshes += 1
    return deleted && failRefresh
      ? route.fulfill({ json: { _tag: "ApiError", message: "Throttled" }, status: 500 })
      : route.fulfill({ json: { headCommit: "c".repeat(40), revisionId: "revision-1" } })
  })

  await page.goto(detail)
  await page.getByRole("button", { name: "Remove rule" }).click()
  const notice = page.getByRole("alert").filter({ hasText: "Removed the rule, but this page couldn't refresh" })
  await expect(notice).toBeVisible()
  // The rule is already deleted: removing again is off, refreshing is the way forward.
  await expect(page.getByRole("button", { name: "Remove rule" })).toBeDisabled()
  failRefresh = false
  const before = refreshes
  await notice.getByRole("button", { name: "Refresh" }).click()
  await expect.poll(() => refreshes).toBeGreaterThan(before)
  await expect(notice).toHaveCount(0)
})
