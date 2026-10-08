import { expect, test } from "@playwright/test"
import { FONT_SWAP_LAUNCH_OPTIONS, measureFontSwapShift } from "../../../playwright-font-swap.ts"

test.use({ launchOptions: FONT_SWAP_LAUNCH_OPTIONS })

const pullRequest = (id: string, title: string) => ({
  account: { profile: "work", region: "eu-west-1", awsAccountId: "111122223333" },
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
  title
})

const pullRequests = [
  pullRequest("11", "Approval not required is its own state, and health decays saturating"),
  pullRequest("12", "Sandbox recreation keeps the generated password in the owner-only cache"),
  pullRequest("13", "Queue hides accounts the user switched off")
]

// A late Geist stays on its metric-matched fallback without moving the queue (rly font-swap budget).
for (const viewport of [{ height: 1000, width: 1440 }, { height: 844, width: 390 }]) {
  test(`a late Geist never moves the queue at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport)
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
          JSON.stringify({ accounts: [], currentUser: "viewer", pullRequests, sandboxes: [], status: "idle" })
        }\n\n`,
        contentType: "text/event-stream"
      }))
    const swap = await measureFontSwapShift(page, { probe: "h1", ready: "text=Queue hides accounts", url: "/" })
    expect(swap.sum, swap.report).toBeLessThanOrEqual(0.05)
  })
}
