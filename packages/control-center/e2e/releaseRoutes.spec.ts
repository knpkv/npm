import { type BrowserContext, expect, type Page, test } from "@playwright/test"

import { releasePortfolioFixture } from "./releasePortfolioFixture.js"

const snapshot = releasePortfolioFixture
const release = snapshot.releases[0]
if (release === undefined) throw new Error("Expected one browser release fixture")

const pairedSession = {
  absoluteExpiresAt: "2026-08-13T10:00:00.000Z",
  actor: { _tag: "human", personId: "01890f6f-6d6a-7cc0-98d2-000000000003" },
  createdAt: "2026-07-14T10:00:00.000Z",
  idleExpiresAt: "2026-07-14T22:00:00.000Z",
  lastSeenAt: "2026-07-14T10:01:00.000Z",
  permission: "workspace-owner",
  revokedAt: null,
  sessionId: "01890f6f-6d6a-7cc0-98d2-000000000002",
  workspaceId: snapshot.workspaceId
}

const overviewPath = `/w/${snapshot.workspaceId}/overview`
const previewPath = `/w/${snapshot.workspaceId}/releases/${release.releaseId}/preview`
const fullPath = `/w/${snapshot.workspaceId}/releases/${release.releaseId}`
const unknownReleaseId = "01890f6f-6d6a-7cc0-98d2-000000000098"

const unauthorizedBody = {
  _tag: "UnauthorizedApiError",
  code: "unauthorized",
  correlationId: "release-route-session-expired",
  message: "The paired session expired"
}

const portfolioInvalidation = {
  schemaVersion: 1,
  eventId: "01890f6f-6d6a-7cc0-98d2-000000000011",
  eventCursor: 11,
  workspaceId: snapshot.workspaceId,
  eventType: "portfolio-invalidated",
  occurredAt: "2026-07-14T10:17:00.000Z",
  ingestedAt: "2026-07-14T10:17:00.001Z",
  causationId: null,
  correlationId: null,
  metadata: { releaseId: release.releaseId },
  payload: { reason: "release-projection" }
}

const installReleaseMocks = async (context: BrowserContext): Promise<void> => {
  await context.route("**/api/v1/session/current", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ csrfToken: "cd".repeat(32), session: pairedSession }),
      contentType: "application/json",
      status: 200
    })
  })
  await context.route("**/api/v1/portfolio/snapshot", async (route) => {
    await route.fulfill({ body: JSON.stringify(snapshot), contentType: "application/json", status: 200 })
  })
  await context.route("**/api/v1/events**", async (route) => route.abort("failed"))
}

const installTransitionProbe = async (page: Page): Promise<void> => {
  await page.addInitScript({
    content: `
      window.__releaseTransitionSnapshots = [];
      const originalStartViewTransition = document.startViewTransition?.bind(document);
      if (originalStartViewTransition) {
        document.startViewTransition = (update) => {
          const collect = () => [...document.querySelectorAll('[data-rly-release-transition-part]')]
            .filter((element) => element.dataset.rlyReleaseTransitionName)
            .map((element) => [element.dataset.rlyReleaseTransitionPart, element.dataset.rlyReleaseTransitionName]);
          const before = collect();
          return originalStartViewTransition(async () => {
            const result = await update();
            await new Promise((resolve) => requestAnimationFrame(() => resolve()));
            window.__releaseTransitionSnapshots.push({ before, after: collect() });
            return result;
          });
        };
      }
    `
  })
}

test.beforeEach(async ({ context }) => installReleaseMocks(context))

test("canonicalizes the root before any release activation renders", async ({ page }) => {
  await page.goto("/")
  await expect(page).toHaveURL(overviewPath)
  await expect(page.getByRole("button", { name: "Preview Copper Finch" })).toBeVisible()
})

test("opens preview first, restores focus, then pushes the canonical full route", async ({ page }) => {
  await page.goto(overviewPath)
  const previewButton = page.getByRole("button", { name: "Preview Copper Finch" })
  await expect(previewButton).toBeVisible()

  await previewButton.focus()
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(previewPath)
  const dialog = page.getByRole("dialog", { name: "Release preview: 2.18.0-rc.1 Copper Finch" })
  await expect(dialog).toBeVisible()
  await expect(page.locator("[data-rly-release-preview-summary]")).toBeFocused()
  await expect(page.locator("[inert]")).not.toHaveCount(0)
  await expect(page.locator("body")).toHaveAttribute("data-scroll-locked", "1")

  await page.keyboard.press("Escape")
  await expect(page).toHaveURL(overviewPath)
  await expect(previewButton).toBeFocused()

  await previewButton.click()
  await page.getByRole("button", { name: "Open Copper Finch full view" }).click()
  await expect(page).toHaveURL(fullPath)
  const fullHeading = page.getByRole("heading", { level: 1, name: "payments-api" })
  await expect(fullHeading).toBeVisible()
  await expect(fullHeading).toBeFocused()
  await expect(page.getByText("Relationship detail not synchronized")).toBeVisible()

  await page.goBack()
  await expect(page).toHaveURL(previewPath)
  await expect(dialog).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page).toHaveURL(overviewPath)
  await expect(previewButton).toBeFocused()
})

test("shares Relay, version, and verdict geometry across the sole orchestrated transition", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await installTransitionProbe(page)
  await page.goto(overviewPath)

  await page.getByRole("button", { name: "Preview Copper Finch" }).click()
  await expect(page.getByRole("dialog", { name: "Release preview: 2.18.0-rc.1 Copper Finch" })).toBeVisible()
  await page.waitForFunction("window.__releaseTransitionSnapshots.length === 1")

  await page.getByRole("button", { name: "Open Copper Finch full view" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "payments-api" })).toBeVisible()
  await page.waitForFunction("window.__releaseTransitionSnapshots.length === 2")

  const expectedNames = [
    ["relay", `release-${release.releaseId}-relay`],
    ["version", `release-${release.releaseId}-version`],
    ["verdict", `release-${release.releaseId}-verdict`]
  ]
  expect(await page.evaluate("window.__releaseTransitionSnapshots")).toEqual([
    { after: expectedNames, before: expectedNames },
    { after: expectedNames, before: expectedNames }
  ])
})

test("renders a compact full-screen sheet and returns direct loads to the semantic parent", async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 320 })
  await page.goto(previewPath)
  await expect(page.locator("[data-rly-release-preview-presentation=\"sheet\"]")).toBeVisible()
  await expect(page.getByText("No demo relationships are substituted.")).toBeVisible()
  expect(await page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")).toBe(true)

  await page.getByRole("button", { name: "Close Release preview: 2.18.0-rc.1 Copper Finch" }).click()
  await expect(page).toHaveURL(overviewPath)
})

test("uses the immediate reduced-motion path at a 200%-zoom-equivalent width", async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 640 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await installTransitionProbe(page)
  await page.goto(overviewPath)

  const previewButton = page.getByRole("button", { name: "Preview Copper Finch" })
  await previewButton.focus()
  await page.keyboard.press("Enter")
  await expect(page.locator("[data-rly-release-preview-presentation=\"sheet\"]")).toBeVisible()
  await expect(page.getByRole("button", { name: "Open Copper Finch full view" })).toBeInViewport()
  expect(await page.evaluate("window.__releaseTransitionSnapshots.length")).toBe(0)
  expect(await page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")).toBe(true)

  await page.getByRole("button", { name: "Open Copper Finch full view" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "payments-api" })).toBeFocused()
  expect(await page.evaluate("window.__releaseTransitionSnapshots.length")).toBe(0)
  expect(await page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")).toBe(true)
})

test("keeps direct full routes stable across refresh and never substitutes an unknown release", async ({ page }) => {
  await page.goto(fullPath)
  await expect(page.getByRole("heading", { level: 1, name: "payments-api" })).toBeVisible()
  await page.reload()
  await expect(page).toHaveURL(fullPath)
  await expect(page.getByText("Copper Finch", { exact: true })).toBeVisible()

  const unknownReleasePath = `/w/${snapshot.workspaceId}/releases/${unknownReleaseId}`
  await page.goto(unknownReleasePath)
  await expect(page).toHaveURL(unknownReleasePath)
  await expect(page.getByText("Release not found")).toBeVisible()
  await expect(page.getByText("Copper Finch")).toHaveCount(0)
})

test("renders only not-found content for unknown previews and wildcard workspace children", async ({ page }) => {
  const unknownPreviewPath = `/w/${snapshot.workspaceId}/releases/${unknownReleaseId}/preview`
  await page.goto(unknownPreviewPath)
  await expect(page).toHaveURL(unknownPreviewPath)
  await expect(page.getByText("Release not found")).toBeVisible()
  await expect(page.locator("[data-release-not-found]")).toBeFocused()
  await expect(page.locator("[data-portfolio-release-id]")).toHaveCount(0)
  await expect(page.getByText("Copper Finch")).toHaveCount(0)

  const wildcardPath = `/w/${snapshot.workspaceId}/not-a-page`
  await page.goto(wildcardPath)
  await expect(page).toHaveURL(wildcardPath)
  await expect(page.getByText("Page not found")).toBeVisible()
  await expect(page.locator("[data-portfolio-release-id]")).toHaveCount(0)
  await expect(page.getByText("Copper Finch")).toHaveCount(0)
})

test("cleans up an open preview when a live snapshot removes its release", async ({ page }) => {
  let snapshotReads = 0
  let publishInvalidation: (() => void) | undefined
  const invalidationRequested = new Promise<void>((resolve) => {
    publishInvalidation = resolve
  })
  await page.route("**/api/v1/portfolio/snapshot", async (route) => {
    snapshotReads += 1
    const currentSnapshot = snapshotReads === 1
      ? snapshot
      : { ...snapshot, eventCursor: 11, generatedAt: "2026-07-14T10:17:00.000Z", releases: [] }
    await route.fulfill({ body: JSON.stringify(currentSnapshot), contentType: "application/json", status: 200 })
  })
  await page.route("**/api/v1/events**", async (route) => {
    await invalidationRequested
    await route.fulfill({
      body: `id: 11\nevent: portfolio.invalidated\ndata: ${JSON.stringify(portfolioInvalidation)}\n\n`,
      contentType: "text/event-stream",
      status: 200
    })
  })

  await page.goto(overviewPath)
  await page.getByRole("button", { name: "Preview Copper Finch" }).click()
  await expect(page.getByRole("dialog")).toBeVisible()
  publishInvalidation?.()

  await expect(page.getByText("Release not found")).toBeVisible()
  await expect(page.locator("[data-release-not-found]")).toBeFocused()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.locator("[data-portfolio-release-id]")).toHaveCount(0)
  await expect(page.locator("[inert]")).toHaveCount(0)
  await expect(page.locator("body")).not.toHaveAttribute("data-scroll-locked", "1")
})

test("cleans up an open preview when its browser session expires", async ({ page }) => {
  let expireSession: (() => void) | undefined
  const expirationRequested = new Promise<void>((resolve) => {
    expireSession = resolve
  })
  await page.route("**/api/v1/events**", async (route) => {
    await expirationRequested
    await route.fulfill({ body: JSON.stringify(unauthorizedBody), contentType: "application/json", status: 401 })
  })

  await page.goto(overviewPath)
  await page.getByRole("button", { name: "Preview Copper Finch" }).click()
  await expect(page.getByRole("dialog")).toBeVisible()
  expireSession?.()

  await expect(page.getByText("Release facts stay private")).toBeVisible()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.locator("[data-portfolio-release-id]")).toHaveCount(0)
  await expect(page.locator("[inert]")).toHaveCount(0)
  await expect(page.locator("body")).not.toHaveAttribute("data-scroll-locked", "1")
  await expect(page.getByRole("heading", { level: 1, name: "Every release. One view." })).toBeFocused()
})
