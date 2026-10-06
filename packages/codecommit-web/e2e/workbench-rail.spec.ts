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

const detail = (id: string) => `/accounts/production/prs/${id}?repository=infra-core&region=eu-west-1`

// The rail sits beside the open pull request in windows 800px and wider, groups the queue by what the viewer has
// to do, and marks the open pull request; a phone shows the pull request alone.
test("shows the queue rail beside the pull request on wide screens", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1280 })
  await serve(page)
  await page.goto(detail("12"))

  const rail = page.getByRole("region", { name: /^Queue/ })
  await expect(rail.getByText("2 pull requests wait on your review.")).toBeVisible()
  await expect(rail.getByRole("heading", { level: 3 })).toHaveText(["Needs your review 2", "Yours 1"])
  await expect(rail.getByRole("link", { name: /Bound patch reads/ })).toHaveAttribute("aria-current", "page")
  await expect(rail.getByText("conflicts with the destination")).toBeVisible()
  await expect(page.getByRole("heading", { level: 1, name: "Bound patch reads" })).toBeVisible()
})

test("hides the rail on a phone and keeps the pull request", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 })
  await serve(page)
  await page.goto(detail("12"))

  await expect(page.getByRole("heading", { level: 1, name: "Bound patch reads" })).toBeVisible()
  await expect(page.getByRole("region", { name: /^Queue/ })).toBeHidden()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})

test("walks the rail with the arrow keys and opens a row with Enter", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1280 })
  await serve(page)
  await page.goto(detail("12"))

  const rail = page.getByRole("region", { name: /^Queue/ })
  await rail.getByRole("link", { name: /Bound patch reads/ }).focus()
  await page.keyboard.press("ArrowUp")
  await expect(rail.getByRole("link", { name: /Rotate signing keys/ })).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("heading", { level: 1, name: "Rotate signing keys" })).toBeVisible()
  await expect(rail.getByRole("link", { name: /Rotate signing keys/ })).toHaveAttribute("aria-current", "page")
})

test("shows the rail from an 800px window and keeps a 768px tablet on the phone layout", async ({ page }) => {
  await serve(page)
  const cases: ReadonlyArray<readonly [width: number, visible: boolean]> = [[768, false], [799, false], [800, true]]
  for (const [width, visible] of cases) {
    await page.setViewportSize({ height: 900, width })
    await page.goto(detail("12"))
    await expect(page.getByRole("heading", { level: 1, name: "Bound patch reads" })).toBeVisible()
    const rail = page.getByRole("region", { name: /^Queue/ })
    if (visible) await expect(rail).toBeVisible()
    else await expect(rail).toBeHidden()
  }
})

test("keeps the rail below the sticky header after scrolling, with one and two header rows", async ({ page }) => {
  await serve(page)
  for (const width of [1280, 1024]) {
    await page.setViewportSize({ height: 700, width })
    await page.goto(detail("12"))
    const title = page.getByRole("heading", { level: 2, name: /^Queue/ })
    await expect(title).toBeVisible()
    await page.mouse.wheel(0, 1500)
    await expect
      .poll(async () => {
        const header = await page.locator("header").first().boundingBox()
        const heading = await title.boundingBox()
        return header !== null && heading !== null && heading.y >= header.y + header.height
      })
      .toBe(true)
  }
})

test("marks only the open pull request when two share a number in different regions", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1280 })
  await serve(page)
  await page.route("**/api/events/", (route) =>
    route.fulfill({
      body: `data: ${
        JSON.stringify({
          accounts: [],
          currentUser: "viewer",
          enabledProfiles: ["production"],
          pullRequests: [
            pullRequest("12", { title: "Bound patch reads" }),
            {
              ...pullRequest("12", { title: "Same number in Virginia" }),
              account: { awsAccountId: "111122223333", profile: "production", region: "us-east-1" }
            }
          ],
          sandboxes: [],
          status: "idle"
        })
      }\n\n`,
      contentType: "text/event-stream"
    }))
  await page.goto("/accounts/production/prs/12?repository=infra-core&region=us-east-1")
  const rail = page.getByRole("region", { name: /^Queue/ })
  await expect(rail.locator("a[aria-current='page']")).toHaveCount(1)
  await expect(rail.getByRole("link", { name: /Same number in Virginia/ })).toHaveAttribute("aria-current", "page")
})

// The badge counts with the rail's own rule on the client; a stale server count on the wire must not win.
test("counts the header badge from the queue, not a stale server count", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1280 })
  await serve(page)
  await page.route("**/api/events/", (route) =>
    route.fulfill({
      body: `data: ${
        JSON.stringify({
          accounts: [],
          currentUser: "viewer",
          enabledProfiles: ["production"],
          pendingReviewCount: 0,
          pullRequests: [pullRequest("12", { title: "Bound patch reads" })],
          sandboxes: [],
          status: "idle"
        })
      }\n\n`,
      contentType: "text/event-stream"
    }))
  await page.goto(detail("12"))

  const rail = page.getByRole("region", { name: /^Queue/ })
  await expect(rail.getByText("1 pull request waits on your review.")).toBeVisible()
  await expect(
    page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: /, 1 needing your review$/ })
  )
    .toBeVisible()
})
