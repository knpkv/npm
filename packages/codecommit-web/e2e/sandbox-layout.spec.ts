import { expect, type Page, test } from "@playwright/test"

const sandboxState = (logs: string) =>
  JSON.stringify({
    accounts: [],
    currentUser: "reviewer",
    pendingReviewCount: 0,
    pullRequests: [],
    sandboxes: [
      {
        awsAccountId: "111111111111",
        containerId: "container-1",
        createdAt: "2026-08-12T09:00:00.000Z",
        error: null,
        id: "sandbox-1",
        lastActivityAt: "2026-08-12T09:30:00.000Z",
        logs,
        port: 8080,
        pullRequestId: "42",
        repositoryName: "payments-api",
        sourceBranch: "feature/safe-retries",
        status: "running",
        statusDetail: null
      }
    ],
    status: "idle"
  })

const openSandbox = async (page: Page, logs: string, view: "editor" | "logs") => {
  const payload = sandboxState(logs)
  await page.route("**/api/events/", async (route) => {
    await route.fulfill({
      body: `data: ${payload}\n\n`,
      contentType: "text/event-stream",
      status: 200
    })
  })
  await page.goto(`/sandbox/sandbox-1${view === "logs" ? "?view=logs" : ""}`)
  await expect(page.getByText("payments-api / feature/safe-retries")).toBeVisible()
}

const workspaceBounds = async (page: Page, contentSelector: "iframe" | "[role=log]") =>
  page.locator(contentSelector).evaluate((content) => {
    const workspace = content.closest("main > div")
    if (workspace === null) throw new Error("Sandbox workspace is missing")
    const contentRect = content.getBoundingClientRect()
    const workspaceRect = workspace.getBoundingClientRect()
    return {
      contentBottom: contentRect.bottom,
      contentClientHeight: content.clientHeight,
      contentScrollHeight: content.scrollHeight,
      documentClientHeight: document.documentElement.clientHeight,
      documentScrollHeight: document.documentElement.scrollHeight,
      workspaceBottom: workspaceRect.bottom
    }
  })

const appState = JSON.stringify({
  accounts: [
    {
      enabled: true,
      profile: "production",
      region: "eu-west-1"
    }
  ],
  currentUser: "reviewer",
  lastUpdated: "2026-08-12T09:30:00.000Z",
  pendingReviewCount: 1,
  pullRequests: [
    {
      account: {
        awsAccountId: "111111111111",
        profile: "production",
        region: "eu-west-1"
      },
      approvalRules: [],
      approvedBy: [],
      approvedByArns: [],
      author: "andrey",
      commentCount: 3,
      commentedBy: [],
      creationDate: "2026-08-07T09:30:00.000Z",
      description: "Keeps provider callbacks idempotent while preserving the existing public API.",
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
  ],
  sandboxes: [],
  status: "idle"
})

const routeAppState = async (page: Page) => {
  await page.route("**/api/events/", async (route) => {
    await route.fulfill({
      body: `data: ${appState}\n\n`,
      contentType: "text/event-stream",
      status: 200
    })
  })
}

test("keeps long sandbox logs inside an independently scrolling mobile panel", async ({ page }) => {
  await page.setViewportSize({ height: 667, width: 390 })
  const logs = Array.from(
    { length: 400 },
    (_, index) => `[09:30:${String(index).padStart(3, "0")}] line ${index}`
  ).join("\n")
  await openSandbox(page, logs, "logs")

  const bounds = await workspaceBounds(page, "[role=log]")
  expect(bounds.documentScrollHeight).toBe(bounds.documentClientHeight)
  expect(bounds.contentScrollHeight).toBeGreaterThan(bounds.contentClientHeight)
  expect(bounds.contentBottom).toBeLessThanOrEqual(bounds.workspaceBottom)
})

test("fills the desktop workspace in both editor and short-log views", async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 1280 })
  await openSandbox(page, "[09:30] workspace ready", "editor")

  const editorBounds = await workspaceBounds(page, "iframe")
  expect(editorBounds.documentScrollHeight).toBe(editorBounds.documentClientHeight)
  expect(editorBounds.contentBottom).toBe(editorBounds.workspaceBottom)

  await page.getByRole("button", { name: "Logs", exact: true }).click()
  await expect(page.getByRole("log", { name: "Sandbox logs" })).toBeVisible()
  const logBounds = await workspaceBounds(page, "[role=log]")
  expect(logBounds.documentScrollHeight).toBe(logBounds.documentClientHeight)
  expect(logBounds.contentBottom).toBeLessThanOrEqual(logBounds.workspaceBottom)
})

test("resets push navigation, restores history, and preserves queue position for query changes", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1280 })
  await routeAppState(page)
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "What needs a decision." })).toBeVisible()

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  const queueY = await page.evaluate(() => window.scrollY)
  expect(queueY).toBeGreaterThan(0)
  await page.getByRole("searchbox", { name: "Search pull requests" }).fill("payments")
  expect(await page.evaluate(() => window.scrollY)).toBe(queueY)

  await page.getByRole("link", { name: /PR #42/ }).click()
  await expect(page).toHaveURL(/\/accounts\/111111111111\/prs\/42/)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)

  await page.goBack()
  await expect(page).toHaveURL(/q=payments/)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(queueY)
})

test("keeps active mobile navigation destinations visible", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 })
  await routeAppState(page)
  await page.goto("/settings/about")

  const within = async (linkName: string, navName: string) => {
    const link = page.getByRole("link", { name: linkName, exact: true })
    const nav = page.getByRole("navigation", { name: navName })
    const [linkBox, navBox] = await Promise.all([link.boundingBox(), nav.boundingBox()])
    if (linkBox === null || navBox === null) throw new Error(`Missing ${linkName} navigation bounds`)
    expect(linkBox.x).toBeGreaterThanOrEqual(navBox.x)
    expect(linkBox.x + linkBox.width).toBeLessThanOrEqual(navBox.x + navBox.width)
  }

  await within("Settings", "Primary")
  await within("About", "Settings")
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
})
