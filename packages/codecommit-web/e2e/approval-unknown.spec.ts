import type { PullRequest } from "@knpkv/codecommit-core/Domain.js"
import { expect, test } from "@playwright/test"

const pullRequest = (id: string, title: string, approval: Pick<PullRequest, "approvalUnknown" | "isApproved">) => ({
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
            // Approved means a rule exists and is satisfied; with no rules it would read "No approval required".
            {
              ...pullRequest("32", "Known approval", { isApproved: true }),
              approvalRules: [{ ruleName: "r", requiredApprovals: 1, poolMembers: [], satisfied: true }]
            },
            {
              ...pullRequest("33", "Conflicted unknown", {
                isApproved: false,
                approvalUnknown: { _tag: "NotPermitted" }
              }),
              isMergeable: false
            },
            // CodeCommit gave no creation date: the score is Unknown, never a red 0.
            { ...pullRequest("34", "Undated change", { isApproved: false }), creationDate: "1970-01-01T00:00:00.000Z" }
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
  // The reason is the row link's description (heard after its name) and the label's hover text.
  const unknownLink = page.getByRole("link").filter({ hasText: "Unknown approval" }).first()
  await expect(unknownLink).toHaveAccessibleDescription(
    "Not allowed to check approval rules (codecommit:EvaluatePullRequestApprovalRules)."
  )
  await expect(unknownRow.locator("[title^='Not allowed to check approval rules']")).toContainText("Approval unknown")

  await page.goto("/?f=status:approved")
  await expect(page.getByRole("link", { name: "Known approval" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Unknown approval" })).toHaveCount(0)

  const undatedRow = page.locator("article, li, div").filter({
    has: page.getByRole("link", { name: "Undated change" })
  })
    .last()
  await page.goto("/")
  await expect(undatedRow.getByLabel("unknown")).toHaveText("—")
  await expect(undatedRow.getByTitle("Not enough data to score: CodeCommit gave no creation date.")).toBeVisible()
  await page.goto("/accounts/production/prs/34?repository=example-repository&region=eu-west-1")
  await expect(page.getByText("Health —", { exact: true })).toBeVisible()

  // A conflict decides the verdict, but the detail page still says why approval is unknown.
  await page.goto("/accounts/production/prs/33?repository=example-repository&region=eu-west-1")
  // The verdict is the bold lead of the review-state sentence, not a heading.
  await expect(page.getByRole("main").getByText("Resolve conflicts.", { exact: true })).toBeVisible()
  await expect(page.getByText("codecommit:EvaluatePullRequestApprovalRules")).toBeVisible()
})
