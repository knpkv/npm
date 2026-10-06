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

/** Enough added lines that the diff must scroll inside its own viewport. */
const longTail = Array.from({ length: 120 }, (_, line) => `export const line${line} = ${line}\n`).join("")

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
        after: `export const readPatch = (limit: number) => fetchPatch(limit)\n${longTail}`,
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

  // Esc belongs to the dialog: it closes the drawer and must not also take the page's "back to the queue" shortcut.
  await page.keyboard.press("Escape")
  await expect(drawer).toBeHidden()
  await expect(page).toHaveURL(/\/accounts\/production\/prs\/12\?/)
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

// Between the drawer threshold and the 52rem column breakpoint, the stacked layout's fixed diff
// height used to outgrow the drawer grid, so the end of a long diff was clipped and unreachable.
test("keeps the diff inside the workspace in the drawer layout of a narrow column", async ({ page }) => {
  await page.setViewportSize({ height: 720, width: 1000 })
  await serve(page)
  await page.goto(detail)

  await expect(page.locator("[data-findings]")).toHaveAttribute("data-findings", "drawer")
  await expect(page.getByText("export const line0 = 0")).toBeVisible()
  const overflow = await page.evaluate(() => {
    const workbench = document.querySelector("[data-findings]")
    if (workbench === null) return Number.POSITIVE_INFINITY
    const end = workbench.getBoundingClientRect().bottom
    const scrollers = [...workbench.querySelectorAll("*")].filter((element) =>
      ["auto", "scroll"].includes(getComputedStyle(element).overflowY)
    )
    return Math.max(0, ...scrollers.map((element) => element.getBoundingClientRect().bottom - end))
  })
  expect(overflow).toBeLessThanOrEqual(1)
})

// The palette opens in a portal under body; a native modal above it would leave it inert.
test("steps aside for the command palette, so the palette takes input", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1280 })
  await serve(page)
  await page.goto(detail)

  await page.getByRole("button", { name: "Relay", exact: true }).click()
  const drawer = page.getByRole("dialog", { name: "Relay" })
  await expect(drawer).toBeVisible()
  await page.keyboard.press("Control+p")
  await expect(drawer).toBeHidden()
  const input = page.getByPlaceholder("Type a command...")
  await expect(input).toBeFocused()
  await page.keyboard.type("Settings")
  await expect(input).toHaveValue("Settings")
})

// A permission prompt pushed while the drawer is open closes the drawer and can be answered.
test("keeps a permission prompt usable while the drawer is open", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1280 })
  await serve(page)
  await page.goto(detail)

  await page.getByRole("button", { name: "Relay", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Relay" })).toBeVisible()
  await page.unroute("**/api/events/")
  await page.route("**/api/events/", (route) =>
    route.fulfill({
      body: `data: ${
        JSON.stringify({
          accounts: [],
          currentUser: "viewer",
          enabledProfiles: ["production"],
          permissionPrompt: {
            category: "read",
            context: "Refresh pull requests",
            id: "prompt-1",
            operation: "codecommit:GetPullRequest"
          },
          pullRequests,
          sandboxes: [],
          status: "idle"
        })
      }\n\n`,
      contentType: "text/event-stream"
    }))
  await expect(page.getByRole("dialog", { name: "Relay" })).toBeHidden({ timeout: 15_000 })
  const allow = page.getByRole("button", { name: "Allow Once" })
  await expect(allow).toBeVisible({ timeout: 15_000 })
  const answered = page.waitForRequest((request) => request.url().includes("/permissions/respond"))
  await allow.click()
  expect((await answered).postDataJSON()).toEqual({ id: "prompt-1", response: "allow_once" })
})

// A reader inside Relay who narrows the window keeps the pane: it moves into the drawer, open.
test("opens the drawer when the window narrows while focus is in Relay", async ({ page }) => {
  await page.setViewportSize({ height: 1080, width: 1920 })
  await serve(page)
  await page.goto(detail)
  await expect(page.getByRole("complementary", { name: "Relay findings" })).toBeVisible()

  // Run Relay stays disabled without a review profile, so take the first enabled control in the pane.
  const focusedInPane = await page.evaluate(() => {
    const pane = document.querySelector("aside[aria-label='Relay findings']")
    const control = [...(pane?.querySelectorAll<HTMLElement>("button, select, a[href], summary") ?? [])].find(
      (element) => !element.matches(":disabled")
    )
    control?.focus()
    return pane !== null && pane.contains(document.activeElement)
  })
  expect(focusedInPane).toBe(true)
  await page.setViewportSize({ height: 900, width: 1280 })
  await expect(page.getByRole("dialog", { name: "Relay" })).toBeVisible()
})

// Leaving Relay for plain page content (no focus target) must not open the drawer on a later resize.
test("keeps the drawer closed on a resize after focus left Relay for page content", async ({ page }) => {
  await page.setViewportSize({ height: 1080, width: 1920 })
  await serve(page)
  await page.goto(detail)
  await expect(page.getByRole("complementary", { name: "Relay findings" })).toBeVisible()

  const focusedInPane = await page.evaluate(() => {
    const pane = document.querySelector("aside[aria-label='Relay findings']")
    const control = [...(pane?.querySelectorAll<HTMLElement>("button, select, a[href], summary") ?? [])].find(
      (element) => !element.matches(":disabled")
    )
    control?.focus()
    return pane !== null && pane.contains(document.activeElement)
  })
  expect(focusedInPane).toBe(true)
  await page.getByRole("heading", { level: 1, name: "Bound patch reads" }).click()
  await expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(true)
  await page.setViewportSize({ height: 900, width: 1280 })
  await expect(page.getByRole("button", { name: "Relay", exact: true })).toBeVisible()
  await expect(page.getByRole("dialog", { name: "Relay" })).toBeHidden()
})

// A drawer that opened itself on a resize returns focus to its trigger on Escape, and stays shut
// on the next resize once the reader dismissed it.
test("returns focus to the trigger after an auto-opened drawer closes, and does not reopen", async ({ page }) => {
  await page.setViewportSize({ height: 1080, width: 1920 })
  await serve(page)
  await page.goto(detail)
  await expect(page.getByRole("complementary", { name: "Relay findings" })).toBeVisible()

  const focusedInPane = await page.evaluate(() => {
    const pane = document.querySelector("aside[aria-label='Relay findings']")
    const control = [...(pane?.querySelectorAll<HTMLElement>("button, select, a[href], summary") ?? [])].find(
      (element) => !element.matches(":disabled")
    )
    control?.focus()
    return pane !== null && pane.contains(document.activeElement)
  })
  expect(focusedInPane).toBe(true)
  await page.setViewportSize({ height: 900, width: 1280 })
  const drawer = page.getByRole("dialog", { name: "Relay" })
  await expect(drawer).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(drawer).toBeHidden()
  await expect(page.getByRole("button", { name: "Relay", exact: true })).toBeFocused()

  await page.setViewportSize({ height: 1080, width: 1920 })
  await expect(page.getByRole("complementary", { name: "Relay findings" })).toBeVisible()
  await page.setViewportSize({ height: 900, width: 1280 })
  await expect(page.getByRole("button", { name: "Relay", exact: true })).toBeVisible()
  await expect(drawer).toBeHidden()
})

// Widening while the drawer is open moves Relay back into the page with focus inside it.
test("keeps focus in Relay when an open drawer's layout widens into a column", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1280 })
  await serve(page)
  await page.goto(detail)

  await page.getByRole("button", { name: "Relay", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Relay" })).toBeVisible()
  await page.setViewportSize({ height: 1080, width: 1920 })
  const pane = page.getByRole("complementary", { name: "Relay findings" })
  await expect(pane).toBeVisible()
  await expect.poll(() =>
    page.evaluate(() =>
      document.querySelector("aside[aria-label='Relay findings']")?.contains(document.activeElement) ?? false
    )
  ).toBe(true)
})
