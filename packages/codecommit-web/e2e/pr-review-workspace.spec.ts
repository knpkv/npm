import { expect, type Page, test } from "@playwright/test"

const pullRequest = {
  account: {
    awsAccountId: "111111111111",
    profile: "production",
    region: "eu-west-1"
  },
  approvalRules: [],
  approvedBy: [],
  approvedByArns: [],
  author: "andrey",
  commentCount: 0,
  commentedBy: [],
  creationDate: "2026-08-07T09:30:00.000Z",
  description: "Keeps provider callbacks idempotent.",
  destinationBranch: "main",
  fetchedAt: "2026-08-12T09:30:00.000Z",
  healthScore: 10,
  id: "42",
  isApproved: false,
  isMergeable: true,
  lastModifiedDate: "2026-08-12T09:30:00.000Z",
  link: "https://console.aws.amazon.com/codesuite/codecommit/repositories/payments-api/pull-requests/42",
  repositoryName: "payments-api",
  sourceBranch: "feature/safe-retries",
  status: "OPEN",
  title: "feat(payments): make retry handling idempotent"
}

const routeReviewWorkspace = async (page: Page) => {
  const appState = JSON.stringify({
    accounts: [{ ...pullRequest.account, enabled: true }],
    currentUser: "reviewer",
    lastUpdated: "2026-08-12T09:30:00.000Z",
    pendingReviewCount: 1,
    pullRequests: [pullRequest],
    sandboxes: [],
    status: "idle"
  })
  await page.route("**/api/events/", async (route) => {
    await route.fulfill({
      body: `data: ${appState}\n\n`,
      contentType: "text/event-stream",
      status: 200
    })
  })
  await page.route("**/api/prs/111111111111/42/diff", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        pullRequestId: "42",
        revisionId: "revision-1",
        baseCommit: "a".repeat(40),
        headCommit: "b".repeat(40),
        files: [{ index: 0, status: "modified", path: "src/retry.ts", previousPath: null }]
      }),
      contentType: "application/json",
      status: 200
    })
  })
  await page.route("**/api/prs/111111111111/42/diff/0?*", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        fileIndex: 0,
        revisionId: "revision-1",
        state: "text",
        before: "export const retries = 2\n",
        after: "export const retries = 3\n"
      }),
      contentType: "application/json",
      status: 200
    })
  })
  await page.route("**/api/prs/111111111111/42/relay-review", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        pullRequestId: "42",
        revisionId: "revision-1",
        baseCommit: "a".repeat(40),
        headCommit: "b".repeat(40),
        kind: "review",
        result: {
          verdict: "One retry regression needs attention.",
          findings: [{
            id: "F1",
            priority: "P2",
            title: "Retry amplification",
            summary: "The extra retry can duplicate a non-idempotent request.",
            details: "The changed constant expands retries without an idempotency guard.",
            recommendation: "Require an idempotency key before retrying.",
            verification: "Static patch review only.",
            publicationTarget: "line-comment",
            location: { scope: "line", filePath: "src/retry.ts", line: 1, side: "after" }
          }]
        }
      }),
      contentType: "application/json",
      status: 200
    })
  })
}

test("reviews an exact CodeCommit diff with Relay", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 })
  await routeReviewWorkspace(page)
  await page.goto("/accounts/111111111111/prs/42")

  await expect(page.getByRole("heading", { name: "Diff & Relay" })).toBeVisible()
  await expect(page.getByText("export const retries = 3")).toBeVisible()
  await page.getByRole("button", { name: "Run Relay" }).click()
  await expect(page.getByRole("button", { name: /Retry amplification/ })).toBeVisible()
  await expect(page.getByText("P2 · Retry amplification")).toBeVisible()

  await page.screenshot({ fullPage: true, path: "test-results/codecommit-web/pr-review-workspace.png" })
  await page.setViewportSize({ height: 844, width: 390 })
  await expect(page.getByRole("heading", { name: "Diff & Relay" })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
})
