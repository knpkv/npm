import { expect, type Page, test } from "@playwright/test"

const DAY = 86_400_000
const now = Date.now()

/** The fields these tests vary on a wire pull request. */
interface PullRequestOverrides {
  readonly author?: string
  readonly creationDate?: string
  readonly isMergeable?: boolean
  readonly title?: string
}

const pullRequest = (id: string, overrides: PullRequestOverrides = {}) => ({
  account: { awsAccountId: "111122223333", profile: "production", region: "eu-west-1" },
  approvalRules: [{
    poolMemberArns: [],
    poolMembers: ["viewer"],
    requiredApprovals: 1,
    ruleName: "Approvals",
    satisfied: false
  }],
  approvedBy: [],
  approvedByArns: [],
  author: "ana",
  commentedBy: [],
  creationDate: new Date(now - DAY).toISOString(),
  destinationBranch: "main",
  id,
  isApproved: false,
  isMergeable: true,
  lastModifiedDate: new Date(now - 3_600_000).toISOString(),
  link: `https://example.invalid/pr/${id}`,
  repositoryName: "infra-core",
  sourceBranch: "feature",
  status: "OPEN",
  title: `Change ${id}`,
  ...overrides
})

const pullRequests = [
  pullRequest("11", { creationDate: new Date(now - 2 * DAY).toISOString(), title: "Rotate signing keys" }),
  pullRequest("12", { title: "Bound patch reads" }),
  pullRequest("21", { author: "viewer", isMergeable: false, title: "Split the usage chunk" })
]

const serve = async (page: Page) => {
  await page.route(
    "**/api/prs/*/*/refresh*",
    (route) => route.fulfill({ json: { headCommit: "b".repeat(40), revisionId: "revision-1" } })
  )
  await page.route("**/api/prs/*/12/diff*", (route) =>
    route.fulfill({
      json: {
        baseCommit: "a".repeat(40),
        files: [{
          afterMode: "100644",
          beforeMode: "100644",
          index: 0,
          path: "src/patch-reader.ts",
          previousPath: null,
          status: "modified"
        }],
        headCommit: "b".repeat(40),
        pullRequestId: "12",
        revisionId: "revision-1"
      }
    }))
  await page.route("**/api/prs/*/12/diff/0?*", (route) =>
    route.fulfill({
      json: {
        after: "export const readPatch = (limit: number) => fetchPatch(limit)\n",
        before: "export const readPatch = () => fetchPatch()\n",
        fileIndex: 0,
        revisionId: "revision-1",
        state: "text"
      }
    }))
  await page.route("**/api/session/current", (route) => route.fulfill({ status: 204 }))
  await page.route("**/api/config", (route) =>
    route.fulfill({
      json: {
        accounts: [{ enabled: true, profile: "production", regions: ["eu-west-1"] }],
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
          pullRequests,
          sandboxes: [],
          status: "idle"
        })
      }\n\n`,
      contentType: "text/event-stream"
    }))
}

const detail = "/accounts/production/prs/12?repository=infra-core&region=eu-west-1"

// Relay findings sit beside the diff when the review grid is wide, move into a drawer opened from
// the workspace header on mid-width columns (here, beside the queue rail), and stack on phones.
test("opens Relay in a drawer beside the rail and returns focus on Escape", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1280 })
  await serve(page)
  await page.goto(detail)

  const trigger = page.getByRole("button", { name: "Relay", exact: true })
  await expect(trigger).toBeVisible()
  await expect(page.getByRole("complementary", { name: "Relay findings" })).toBeHidden()

  await trigger.click()
  const drawer = page.getByRole("dialog", { name: "Relay" })
  await expect(drawer).toBeVisible()
  await expect(drawer.getByRole("button", { name: "Run Relay" })).toBeVisible()

  await page.keyboard.press("Escape")
  await expect(drawer).toBeHidden()
  await expect(trigger).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280)
})

test("keeps Relay in the grid on a wide screen and on a phone", async ({ page }) => {
  for (const viewport of [{ height: 1080, width: 1920 }, { height: 844, width: 390 }]) {
    await page.setViewportSize(viewport)
    await serve(page)
    await page.goto(detail)
    await expect(page.getByRole("complementary", { name: "Relay findings" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Relay", exact: true })).toHaveCount(0)
  }
})
