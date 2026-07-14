import { type BrowserContext, expect, test } from "@playwright/test"

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

test.beforeEach(async ({ context }) => installReleaseMocks(context))

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

test("keeps direct full routes stable across refresh and never substitutes an unknown release", async ({ page }) => {
  await page.goto(fullPath)
  await expect(page.getByRole("heading", { level: 1, name: "payments-api" })).toBeVisible()
  await page.reload()
  await expect(page).toHaveURL(fullPath)
  await expect(page.getByText("Copper Finch", { exact: true })).toBeVisible()

  const unknownReleasePath = `/w/${snapshot.workspaceId}/releases/01890f6f-6d6a-7cc0-98d2-000000000098`
  await page.goto(unknownReleasePath)
  await expect(page).toHaveURL(unknownReleasePath)
  await expect(page.getByText("Release not found")).toBeVisible()
  await expect(page.getByText("Copper Finch")).toHaveCount(0)
})
