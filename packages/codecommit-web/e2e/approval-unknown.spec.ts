import { expect, test } from "@playwright/test"

const pullRequest = (id: string, title: string, approval: Record<string, unknown>) => ({
  account: { profile: "production", region: "eu-west-1", awsAccountId: "111122223333" },
  approvalRules: [],
  approvedBy: [],
  approvedByArns: [],
  author: "author",
  commentedBy: [],
  creationDate: "2026-08-01T00:00:00.000Z",
  destinationBranch: "main",
  id,
  isMergeable: true,
  lastModifiedDate: "2026-08-02T00:00:00.000Z",
  link: `https://example.invalid/pr/${id}`,
  repositoryName: "example-repository",
  sourceBranch: "feature",
  status: "OPEN",
  title,
  ...approval
})

// Cross the wire decoder and the real queue: an unknown approval is labelled as such, with a last
// known approval that must not leak into the label or the approved filter.
test("labels an unknown approval and keeps it out of the approved filter", async ({ page }) => {
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
          pullRequests: [
            pullRequest("31", "Unknown approval", { isApproved: true, approvalUnknown: { _tag: "NotPermitted" } }),
            pullRequest("32", "Known approval", { isApproved: true })
          ],
          sandboxes: [],
          status: "idle",
          enabledProfiles: ["production"]
        })
      }\n\n`,
      contentType: "text/event-stream"
    }))

  await page.goto("/")
  const unknownRow = page.locator("article, li, div").filter({
    has: page.getByRole("link", { name: "Unknown approval" })
  })
    .last()
  await expect(unknownRow.getByText("Approval unknown")).toBeVisible()

  await page.goto("/?f=status:approved")
  await expect(page.getByRole("link", { name: "Known approval" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Unknown approval" })).toHaveCount(0)
})
