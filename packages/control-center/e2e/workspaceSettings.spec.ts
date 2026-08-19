import { expect, test } from "@playwright/test"
import * as Schema from "effect/Schema"

import { UpdateWorkspaceSettingsRequest } from "../src/api/workspaceSettings.js"
import type { WorkspaceSettingsV1 } from "../src/domain/workspaceSettings.js"
import { auditProductionRoutePresentation } from "./presentationAudit.js"
import { productionRouteAuditCase, requiredProductionRouteAuditsFor } from "./productionRouteInventory.js"

const workspaceId = "01890f6f-6d6a-7cc0-98d2-000000000001"
const personId = "01890f6f-6d6a-7cc0-98d2-000000000003"
const sessionId = "01890f6f-6d6a-7cc0-98d2-000000000002"
const csrfToken = "cd".repeat(32)

const session = {
  absoluteExpiresAt: "2026-08-30T09:00:00.000Z",
  actor: { _tag: "human", personId },
  createdAt: "2026-07-30T09:00:00.000Z",
  idleExpiresAt: "2026-07-31T09:00:00.000Z",
  lastSeenAt: "2026-07-30T09:01:00.000Z",
  permission: "workspace-owner",
  revokedAt: null,
  sessionId,
  workspaceId
}

const settings: WorkspaceSettingsV1 = {
  schemaVersion: 1,
  inference: { enabled: true, minimumConfidencePercent: 80 },
  synchronization: {
    cadence: "manual",
    intervalMinutes: null,
    staleAfterMinutes: 1_440
  },
  retention: {
    evidenceDays: 365,
    contentDays: 90,
    auditDays: 365,
    agentActivityDays: 30,
    sandboxArtifactDays: 7
  },
  investigation: {
    mode: "manual",
    consecutiveFailureThreshold: 3
  },
  jira: {
    commentMode: "manual-only",
    includeControlCenterAttribution: true
  },
  pipeline: { retryMode: "manual-only", maximumAttempts: 1 },
  agent: {
    allowedProviders: [],
    defaultProvider: null,
    defaultModel: null,
    toolPolicy: "read-only",
    profilePolicy: "isolated"
  },
  presentation: { density: "comfortable", defaultLanding: "overview" }
}

const readModel = {
  workspaceId,
  revision: 1,
  etag: "\"workspace-settings-v1-1\"",
  settings,
  createdAt: "2026-07-30T09:00:00.000Z",
  updatedAt: "2026-07-30T09:00:00.000Z",
  updatedByPersonId: null
}

test("validates, persists, and reflows workspace settings in a real browser", async ({ context, page }) => {
  await context.addCookies([
    {
      name: "cc_session",
      value: "ab".repeat(32),
      url: "http://127.0.0.1:4173"
    }
  ])
  await page.addInitScript((token) => {
    sessionStorage.setItem("cc_csrf", token)
    localStorage.setItem("cc_theme", "invalid-theme-value")
  }, csrfToken)
  await context.route("**/api/v1/session/current", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ csrfToken, session }),
      contentType: "application/json",
      status: 200
    })
  })

  let savedSettings: WorkspaceSettingsV1 = settings
  await context.route("**/api/v1/settings", async (route) => {
    if (route.request().method() === "PUT") {
      const request = Schema.decodeUnknownSync(UpdateWorkspaceSettingsRequest)(route.request().postDataJSON())
      savedSettings = request.settings
      await route.fulfill({
        body: JSON.stringify({
          ...readModel,
          revision: 2,
          etag: "\"workspace-settings-v1-2\"",
          settings: savedSettings,
          updatedAt: "2026-07-30T09:02:00.000Z",
          updatedByPersonId: personId
        }),
        contentType: "application/json",
        status: 200
      })
      return
    }
    await route.fulfill({
      body: JSON.stringify({ ...readModel, settings: savedSettings }),
      contentType: "application/json",
      status: 200
    })
  })

  await page.goto(`/w/${workspaceId}/settings`)
  await expect(page.getByRole("heading", { level: 1, name: "Workspace settings" })).toBeVisible()
  await expect(page.getByLabel("Theme")).toHaveValue("system")

  const evidence = page.getByLabel("Evidence (days)")
  await evidence.fill("0")
  await expect(evidence).toHaveAttribute("aria-invalid", "true")
  await expect(page.getByText("Evidence (days) must be a whole number from 1 to 3650.")).toBeVisible()
  await expect(page.getByRole("button", { name: "Save settings" })).toBeDisabled()
  await evidence.fill("365")

  await page.getByLabel("Density").selectOption("compact")
  await expect(page.getByText("Unsaved changes")).toBeVisible()
  await page.getByRole("button", { name: "Save settings" }).click()
  await expect(page.getByText("Saved", { exact: true })).toBeVisible()
  expect(savedSettings.presentation.density).toBe("compact")
  await expect(page.locator("[data-workspace-density]")).toHaveAttribute("data-workspace-density", "compact")

  await page.getByLabel("Profile policy").selectOption("local-profile")
  const localProfileNotices = page.getByText(/Local profile is unavailable/)
  await expect(localProfileNotices).toHaveCount(1)
  await expect(localProfileNotices).toContainText("hooks, plugins, MCP servers")
  await expect(page.getByRole("button", { name: "Save settings" })).toBeDisabled()

  await page.getByLabel("Theme").selectOption("dark")
  await expect.poll(() => page.evaluate(() => localStorage.getItem("cc_theme"))).toBe("dark")

  const presentationAudit = productionRouteAuditCase(
    "workspace-settings",
    "settings",
    "authenticated",
    "settings"
  )
  await auditProductionRoutePresentation(page, {
    exercise: async (primaryAction) => {
      await primaryAction.selectOption("light")
    },
    expectOutcome: async () => expect.poll(() => page.evaluate(() => localStorage.getItem("cc_theme"))).toBe("light"),
    landmark: page.getByRole("heading", { level: 1, name: "Workspace settings" }),
    primaryAction: page.getByLabel("Theme")
  })
  expect([presentationAudit]).toEqual(requiredProductionRouteAuditsFor("workspace-settings"))
})

test("does not load or mutate settings for a route outside the browser session workspace", async ({ context, page }) => {
  const otherWorkspaceId = "01890f6f-6d6a-7cc0-98d2-000000000099"
  await context.addCookies([
    {
      name: "cc_session",
      value: "ab".repeat(32),
      url: "http://127.0.0.1:4173"
    }
  ])
  await page.addInitScript((token) => {
    sessionStorage.setItem("cc_csrf", token)
  }, csrfToken)
  await context.route("**/api/v1/session/current", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ csrfToken, session }),
      contentType: "application/json",
      status: 200
    })
  })
  await context.route("**/api/v1/portfolio", async (route) => {
    await route.fulfill({ status: 503 })
  })
  let settingsRequests = 0
  await context.route("**/api/v1/settings", async (route) => {
    settingsRequests += 1
    await route.fulfill({
      body: JSON.stringify(readModel),
      contentType: "application/json",
      status: 200
    })
  })

  await page.goto(`/w/${otherWorkspaceId}/settings`)
  await expect(page.getByText("Workspace not found", { exact: true })).toBeVisible()
  await expect.poll(() => settingsRequests).toBe(0)
})
