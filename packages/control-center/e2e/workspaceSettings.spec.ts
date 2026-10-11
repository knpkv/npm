import { expect, type Page, test, type TestInfo } from "@playwright/test"
import * as Schema from "effect/Schema"

import { RelationshipRepairProposalList, ReleaseDeliveryGraphInspection } from "../src/api/deliveryGraph.js"
import { PortfolioSnapshot } from "../src/api/portfolio.js"
import { UpdateWorkspaceSettingsRequest } from "../src/api/workspaceSettings.js"
import type { WorkspaceSettingsV1 } from "../src/domain/workspaceSettings.js"
import { auditProductionRoutePresentation, seriousAxeViolations } from "./presentationAudit.js"
import { productionRouteAuditCase, requiredProductionRouteAuditsFor } from "./productionRouteInventory.js"
import { releasePortfolioFixture } from "./releasePortfolioFixture.js"

interface TouchControlElement {
  readonly ownerDocument: {
    readonly defaultView: null | {
      readonly getComputedStyle: <Element>(element: Element) => {
        readonly fontSize: string
        readonly borderBlockStartWidth: string
      }
    }
  }
}

const captureTargetAcceptance = async (page: Page, testInfo: TestInfo, name: string): Promise<void> => {
  const editorOnly = name.startsWith("targets-settings-")
  const overviewOnly = name.startsWith("targets-overview-")
  const sectionCapture = editorOnly || overviewOnly
  const metadata = Schema.decodeUnknownSync(Schema.Struct({
    buildRevision: Schema.optionalKey(Schema.String),
    builtAt: Schema.optionalKey(Schema.String)
  }))(testInfo.config.metadata)
  const stamp = `Build ${metadata.buildRevision ?? "local working tree"} · ${
    metadata.builtAt ?? "build time not supplied"
  }`
  await page.evaluate(`(() => {
    let stamp = document.getElementById("target-acceptance-stamp");
    if (!stamp) {
      stamp = document.createElement("p"); stamp.id = "target-acceptance-stamp";
      const root = ${editorOnly} ? document.getElementById("release-targets")?.parentElement?.parentElement
        : ${overviewOnly} ? document.querySelector("[data-portfolio-release-id]") : document.body;
      if (!root) throw new Error("Expected capture surface");
      root.append(stamp);
    }
    stamp.textContent = ${JSON.stringify(stamp)};
    stamp.style.cssText = "display:block;margin:0;padding:.5rem;font:12px monospace;background:Canvas;color:CanvasText;overflow-wrap:break-word"
      + (${sectionCapture} ? "" : ";position:fixed;inset-inline:0;inset-block-end:0;z-index:2147483647");
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  })()`)
  const path = testInfo.outputPath(`${name}.png`)
  if (sectionCapture) {
    const panel = editorOnly
      ? page.getByRole("heading", { name: "Pipeline", exact: true }).locator("../..")
      : page.locator("[data-portfolio-release-id]")
    const viewport = page.viewportSize()
    const bounds = await panel.boundingBox()
    if (viewport === null || bounds === null) throw new Error("Expected target acceptance capture bounds")
    // Layout acceptance runs at the original viewport; give the panel capture enough height to clear sticky chrome.
    await page.setViewportSize({ width: viewport.width, height: Math.ceil(bounds.height) + 300 })
    try {
      await panel.scrollIntoViewIfNeeded()
      await page.evaluate(`(() => {
        const panel = ${editorOnly} ? document.getElementById("release-targets")?.parentElement?.parentElement
          : document.querySelector("[data-portfolio-release-id]");
        if (!panel) throw new Error("Expected capture panel");
        window.scrollTo({ top: Math.max(0, window.scrollY + panel.getBoundingClientRect().top - 96) });
      })()`)
      await panel.screenshot({ path })
    } finally {
      await page.setViewportSize(viewport)
    }
  } else {
    await page.evaluate("window.scrollTo({ top: 0 })")
    await page.screenshot({ path })
  }
  await testInfo.attach(name, { path, contentType: "image/png" })
}

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

for (const width of [390, 1280]) {
  for (const colorScheme of ["light", "dark"] satisfies ReadonlyArray<"light" | "dark">) {
    test.describe(`release targets ${width}px ${colorScheme}`, () => {
      test.use({ viewport: { width, height: 900 }, hasTouch: width === 390, isMobile: width === 390, colorScheme })
      test("accepts target editor and held targetless release presentations", async ({ context, page }, testInfo) => {
        test.setTimeout(60_000)
        const pageErrors: Array<string> = []
        const failedRequests: Array<string> = []
        page.on("pageerror", (error) => pageErrors.push(error.message))
        page.on("requestfailed", (request) => {
          if (!new URL(request.url()).pathname.startsWith("/api/v1/events")) failedRequests.push(request.url())
        })
        await page.clock.install({ time: new Date("2026-07-30T10:00:00.000Z") })
        await context.addCookies([{ name: "cc_session", value: "ab".repeat(32), url: "http://127.0.0.1:4173" }])
        await page.addInitScript((token) => sessionStorage.setItem("cc_csrf", token), csrfToken)
        await context.route("**/api/v1/session/current", (route) =>
          route.fulfill({
            body: JSON.stringify({ csrfToken, session }),
            contentType: "application/json",
            status: 200
          }))
        await context.route("**/api/v1/session", (route) =>
          route.fulfill({
            body: JSON.stringify([session]),
            contentType: "application/json",
            status: 200
          }))
        const pluginConnectionId = "01890f6f-6d6a-7cc0-98d2-000000000091"
        const topologyDigest = `sha256:${"a".repeat(64)}`
        const configured = {
          ...settings,
          pipeline: {
            ...settings.pipeline,
            releaseTargets: [{
              pluginConnectionId,
              pipelineName: "fixture-pipeline",
              topologyDigest,
              environments: [
                {
                  key: "staging",
                  name: "Staging",
                  firstStage: "Build",
                  lastStage: "Verify",
                  requiresManualGate: false
                },
                {
                  key: "production",
                  name: "Production",
                  firstStage: "Approve",
                  lastStage: "Deploy",
                  requiresManualGate: true
                }
              ]
            }]
          }
        }
        await context.route("**/api/v1/settings", (route) =>
          route.fulfill({
            body: JSON.stringify({ ...readModel, settings: configured }),
            contentType: "application/json",
            status: 200
          }))
        await context.route("**/api/v1/settings/release-target-catalog", (route) =>
          route.fulfill({
            body: JSON.stringify({
              complete: true,
              pipelines: [{
                pluginConnectionId,
                pipelineName: "fixture-pipeline",
                displayName: "Fixture delivery",
                topologyDigest,
                state: "current",
                observedAt: "2026-07-30T09:00:00.000Z",
                stages: ["Build", "Verify", "Approve", "Deploy"].map((name) => ({ name, actions: [] }))
              }]
            }),
            contentType: "application/json",
            status: 200
          }))
        const snapshot = Schema.encodeSync(PortfolioSnapshot)({
          ...releasePortfolioFixture,
          releases: releasePortfolioFixture.releases.slice(0, 1).map((release) => ({
            ...release,
            collaborators: [],
            collaboratorCount: 0,
            readiness: null,
            targetEnvironmentIds: [],
            targetConfiguration: {
              state: "unconfigured",
              targets: [],
              verdict: "held",
              reason: "no-target-environment"
            }
          }))
        })
        const release = snapshot.releases[0]
        if (release === undefined) throw new Error("Expected targetless release fixture")
        await context.route("**/api/v1/portfolio/snapshot", (route) =>
          route.fulfill({
            body: JSON.stringify(snapshot),
            contentType: "application/json",
            status: 200
          }))
        await context.route("**/api/v1/events**", (route) => route.abort("failed"))
        await context.route("**/api/v1/relationships/releases/**", (route) => {
          const body = new URL(route.request().url()).pathname.endsWith("/repair-proposals")
            ? Schema.encodeSync(RelationshipRepairProposalList)(
              Schema.decodeUnknownSync(RelationshipRepairProposalList)({
                releaseId: release.releaseId,
                environmentId: null,
                status: null,
                proposals: [],
                applications: [],
                truncated: false
              })
            )
            : Schema.encodeSync(ReleaseDeliveryGraphInspection)(
              Schema.decodeUnknownSync(ReleaseDeliveryGraphInspection)({
                releaseId: release.releaseId,
                environmentId: null,
                truncated: false,
                nodes: [],
                relationships: [],
                entityProjections: [],
                evidenceItems: [],
                evidenceClaims: []
              })
            )
          return route.fulfill({ body: JSON.stringify(body), contentType: "application/json", status: 200 })
        })
        await page.goto(`/w/${workspaceId}/settings#release-targets`)
        const editor = page.locator("#release-targets")
        await expect(editor.getByLabel("Environment name", { exact: true })).toHaveCount(2)
        await expect(editor.getByRole("group", { name: "Staging", exact: true })).toBeVisible()
        await expect(editor.getByRole("group", { name: "Production", exact: true })).toBeVisible()
        await expect(editor.getByRole("list", { name: "fixture-pipeline provider stage order" })).toBeVisible()
        await expect(editor.locator("[class*=\"_fields_\"]")).toHaveCount(0)
        const stagePair = editor.getByRole("group", { name: "Production", exact: true })
        const first = await stagePair.getByRole("combobox", { name: "First stage", exact: true }).boundingBox()
        const last = await stagePair.getByRole("combobox", { name: "Last stage", exact: true }).boundingBox()
        const key = await stagePair.getByLabel("Environment key", { exact: true }).boundingBox()
        const environmentName = await stagePair.getByLabel("Environment name", { exact: true }).boundingBox()
        if (width === 1280) {
          expect(first?.y).toBe(last?.y)
          expect(key?.y).toBe(environmentName?.y)
        } else {
          expect(first?.y).not.toBe(last?.y)
          expect(key?.y).not.toBe(environmentName?.y)
        }
        await editor.getByRole("combobox", { name: "First stage", exact: true }).nth(1).selectOption("Verify")
        const invalid = editor.getByRole("combobox", { name: "First stage", exact: true }).nth(1)
        await expect(invalid).toHaveAttribute("aria-invalid", "true")
        expect(
          await invalid.evaluate((node: TouchControlElement) => {
            const view = node.ownerDocument.defaultView
            if (view === null) throw new Error("Expected a rendered control window")
            return Number.parseFloat(view.getComputedStyle(node).borderBlockStartWidth)
          })
        ).toBe(2)
        const description = await invalid.getAttribute("aria-describedby")
        expect(description).not.toBeNull()
        await expect(page.locator(`[id="${description}"]`)).toHaveText(
          "Production starts at Verify, which Staging already covers."
        )
        await expect(editor.getByText("Overlap · Staging · Production", { exact: true })).toBeVisible()
        if (width === 1280) {
          expect((await invalid.boundingBox())?.y).toBe(
            (await stagePair.getByRole("combobox", { name: "Last stage", exact: true }).boundingBox())?.y
          )
        }
        await editor.getByRole("button", { name: "Review Production", exact: true }).click()
        await expect(invalid).toBeFocused()
        expect(await seriousAxeViolations(page)).toEqual([])
        if (width === 390) {
          expect(await page.evaluate<boolean>("matchMedia('(pointer: coarse)').matches")).toBe(true)
          const controls = editor.locator("input:not([type=checkbox]), select, button")
          expect(await controls.count()).toBeGreaterThan(0)
          for (const control of await controls.all()) {
            const box = await control.boundingBox()
            expect(box?.height).toBeGreaterThanOrEqual(44)
            expect(box?.width).toBeGreaterThanOrEqual(44)
          }
          for (const input of await editor.locator("input:not([type=checkbox]), select").all()) {
            expect(
              await input.evaluate((node: TouchControlElement) => {
                const view = node.ownerDocument.defaultView
                if (view === null) throw new Error("Expected a rendered control window")
                return Number.parseFloat(view.getComputedStyle(node).fontSize)
              })
            )
              .toBeGreaterThanOrEqual(16)
          }
          const gates = editor.getByText("Require manual approval gate", { exact: true }).locator("..")
          await expect(gates).toHaveCount(2)
          for (const gate of await gates.all()) expect((await gate.boundingBox())?.height).toBeGreaterThanOrEqual(44)
        }
        expect(await page.evaluate<boolean>("document.documentElement.scrollWidth <= window.innerWidth")).toBe(true)
        await captureTargetAcceptance(page, testInfo, `targets-settings-${width}-${colorScheme}`)
        await page.goto(`/w/${workspaceId}/overview`)
        const row = page.locator(`[data-portfolio-release-id="${release.releaseId}"]`)
        await expect(row).toBeVisible()
        await expect(row.getByText("Held", { exact: true })).toBeVisible()
        await expect(row.getByText("No target environment", { exact: true })).toBeVisible()
        await expect(row.getByRole("link", { name: "Configure targets" })).toHaveAttribute(
          "href",
          `/w/${workspaceId}/settings#release-targets`
        )
        const configure = row.getByRole("link", { name: "Configure targets" })
        await expect(configure.locator("xpath=ancestor::article")).toHaveCount(1)
        const preview = row.getByRole("button", { name: /^Preview /u })
        expect((await configure.boundingBox())?.height).toBe((await preview.boundingBox())?.height)
        if (width === 390) {
          const box = await row.getByRole("link", { name: "Configure targets" }).boundingBox()
          expect(box?.height).toBeGreaterThanOrEqual(44)
          expect(box?.width).toBeGreaterThanOrEqual(44)
        }
        expect(await seriousAxeViolations(page)).toEqual([])
        await captureTargetAcceptance(page, testInfo, `targets-overview-${width}-${colorScheme}`)
        await page.goto(`/w/${workspaceId}/releases/${release.releaseId}`)
        const full = page.locator(`[data-release-full-id="${release.releaseId}"]`)
        await expect(full.getByText("No target environment", { exact: true })).toBeVisible()
        await expect(full.getByRole("link", { name: "Configure targets" })).toBeVisible()
        await expect(full.getByRole("link", { name: "Configure targets" })).toHaveClass(/releaseAction/u)
        await expect(full.getByRole("link", { name: "Repair missing links" })).toHaveClass(/back/u)
        if (width === 390) {
          const box = await full.getByRole("link", { name: "Configure targets" }).boundingBox()
          expect(box?.height).toBeGreaterThanOrEqual(44)
          expect(box?.width).toBeGreaterThanOrEqual(44)
        }
        expect(await seriousAxeViolations(page)).toEqual([])
        expect(await page.evaluate<boolean>("document.documentElement.scrollWidth <= window.innerWidth")).toBe(true)
        await captureTargetAcceptance(page, testInfo, `targets-release-${width}-${colorScheme}`)
        await expect(full.locator("h1")).not.toBeFocused()
        await full.getByRole("link", { name: "Configure targets" }).click()
        await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/settings#release-targets$`))
        await expect(page.getByRole("heading", { name: "Release targets", exact: true })).toBeVisible()
        expect(pageErrors).toEqual([])
        expect(failedRequests).toEqual([])
      })
    })
  }
}

test("configures ordered environment ranges through the governed pipeline settings flow", async ({ context, page }) => {
  await context.addCookies([{ name: "cc_session", value: "ab".repeat(32), url: "http://127.0.0.1:4173" }])
  await page.addInitScript((token) => sessionStorage.setItem("cc_csrf", token), csrfToken)
  await context.route("**/api/v1/session/current", (route) =>
    route.fulfill({
      body: JSON.stringify({ csrfToken, session }),
      contentType: "application/json",
      status: 200
    }))
  const connectionId = "01890f6f-6d6a-7cc0-98d2-000000000091"
  const digest = `sha256:${"a".repeat(64)}`
  let stale = false
  let rejectOnce = true
  let saved = settings
  await context.route("**/api/v1/settings/release-target-catalog", (route) =>
    route.fulfill({
      body: JSON.stringify({
        complete: true,
        pipelines: [{
          pluginConnectionId: connectionId,
          displayName: "Fixture delivery",
          pipelineName: "fixture-pipeline",
          topologyDigest: digest,
          state: stale ? "stale" : "current",
          observedAt: "2026-07-30T09:00:00.000Z",
          stages: ["Build", "Verify", "Approve", "Deploy"].map((name) => ({ name, actions: [] }))
        }]
      }),
      contentType: "application/json",
      status: 200
    }))
  await context.route("**/api/v1/settings", async (route) => {
    if (route.request().method() === "PUT") {
      const request = Schema.decodeUnknownSync(UpdateWorkspaceSettingsRequest)(route.request().postDataJSON())
      expect(request.acknowledgedGovernedSections).toEqual(["pipeline"])
      if (rejectOnce) {
        rejectOnce = false
        await route.fulfill({
          status: 422,
          contentType: "application/json",
          body: JSON.stringify({
            _tag: "ReleaseTargetConfigurationError",
            reason: "unknown-stage",
            mappingIndex: 0,
            environmentIndex: 1,
            field: "firstStage"
          })
        })
        return
      }
      saved = request.settings
    }
    await route.fulfill({
      body: JSON.stringify({ ...readModel, settings: saved }),
      contentType: "application/json",
      status: 200
    })
  })
  await page.goto(`/w/${workspaceId}/settings#release-targets`)
  await expect(page.getByText("No target environments configured. Select a followed pipeline after synchronization."))
    .toBeVisible()
  await page.getByLabel("Add followed pipeline").selectOption(`${connectionId}:fixture-pipeline`)
  await page.getByLabel("Environment key", { exact: true }).fill("staging")
  await page.getByLabel("Environment name", { exact: true }).fill("Staging")
  await page.getByRole("combobox", { name: "Last stage", exact: true }).selectOption("Verify")
  await page.getByRole("button", { name: "Add environment range" }).click()
  await expect(page.getByText("Environment 2 starts at Build, which Staging already covers.")).toBeVisible()
  await expect(page.getByRole("button", { name: "Save settings" })).toBeDisabled()
  await page.getByLabel("Environment key", { exact: true }).nth(1).fill("production")
  await page.getByLabel("Environment name", { exact: true }).nth(1).fill("Production")
  await page.getByRole("combobox", { name: "First stage", exact: true }).nth(1).selectOption("Approve")
  await page.getByLabel("Require manual approval gate").nth(0).uncheck()
  await page.getByRole("button", { name: "Save settings" }).click()
  await expect(page.getByRole("dialog", { name: "Review governed changes" })).toBeVisible()
  await page.getByRole("button", { name: "Save governed changes" }).click()
  await expect(page.getByText("Production: Approve is absent from the current pipeline.")).toBeVisible()
  await expect(page.getByRole("combobox", { name: "First stage", exact: true }).nth(1)).toHaveAttribute(
    "aria-invalid",
    "true"
  )
  await page.getByLabel("Environment name", { exact: true }).nth(1).fill("Production target")
  await page.getByRole("button", { name: "Save settings" }).click()
  await page.getByRole("button", { name: "Save governed changes" }).click()
  await expect(page.getByText("Saved", { exact: true })).toBeVisible()
  expect(
    saved.pipeline.releaseTargets?.[0]?.environments.map(({ firstStage, lastStage, requiresManualGate }) => ({
      firstStage,
      lastStage,
      requiresManualGate
    }))
  )
    .toEqual([{ firstStage: "Build", lastStage: "Verify", requiresManualGate: false }, {
      firstStage: "Approve",
      lastStage: "Deploy",
      requiresManualGate: true
    }])
  expect(await seriousAxeViolations(page)).toEqual([])
  await page.setViewportSize({ width: 320, height: 900 })
  expect(await page.evaluate<boolean>("document.documentElement.scrollWidth <= window.innerWidth")).toBe(true)
  stale = true
  await page.getByRole("button", { name: "Refresh pipeline catalogue" }).click()
  await expect(page.getByText("Saved pipeline topology is stale", { exact: true })).toBeVisible()
  expect(await seriousAxeViolations(page)).toEqual([])
})

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
  // Nothing to save yet: the state alone, with no disabled primary button beside it.
  await expect(page.getByText("Saved", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Save settings" })).toHaveCount(0)

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

  const profilePolicy = page.getByLabel("Profile policy")
  await expect(profilePolicy).toHaveValue("isolated")
  await expect(profilePolicy.locator("option[value=\"local-profile\"]")).toHaveCount(0)

  await page.getByLabel("Theme").selectOption("dark")
  await expect.poll(() => page.evaluate(() => localStorage.getItem("cc_theme"))).toBe("dark")

  // At 320px the stacked gutters once left the Browsers card no room: its Retry button poked past the
  // card edge, and with rly's shrinkable reset the heading split mid-word ("Brows/ers").
  await page.setViewportSize({ width: 320, height: 900 })
  const browsersHeading = page.getByRole("heading", { name: "Browsers" })
  const browsersCard = browsersHeading.locator("xpath=ancestor::section[1]")
  const escaping = await browsersCard.evaluate((card) => {
    const edge = card.getBoundingClientRect().right
    return [...card.querySelectorAll("*")].filter((element) => element.getBoundingClientRect().right > edge + 0.5)
      .map((element) => element.tagName.toLowerCase())
  })
  expect(escaping).toEqual([])
  const headingLines = await browsersHeading.evaluate((heading) => {
    const lineHeight = heading.ownerDocument.defaultView?.getComputedStyle(heading).lineHeight
    return lineHeight === undefined
      ? Number.NaN
      : Math.round(heading.getBoundingClientRect().height / Number.parseFloat(lineHeight))
  })
  expect(headingLines).toBe(1)
  await page.setViewportSize({ width: 1280, height: 900 })

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

test.describe("on a touch phone", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { height: 844, width: 390 } })

  // iOS zooms the page into a field whose text is under 16px; the permission select is label-sized otherwise.
  test("the browser permission select reads at 16px", async ({ context, page }) => {
    await context.addCookies([{ name: "cc_session", value: "ab".repeat(32), url: "http://127.0.0.1:4173" }])
    await page.addInitScript((token) => sessionStorage.setItem("cc_csrf", token), csrfToken)
    await context.route(
      "**/api/v1/session/current",
      (route) =>
        route.fulfill({ body: JSON.stringify({ csrfToken, session }), contentType: "application/json", status: 200 })
    )
    await context.route(
      "**/api/v1/settings",
      (route) =>
        route.fulfill({
          body: JSON.stringify({ ...readModel, settings }),
          contentType: "application/json",
          status: 200
        })
    )
    await page.goto(`/w/${workspaceId}/settings`)
    expect(await page.evaluate<boolean>("matchMedia('(pointer: coarse)').matches")).toBe(true)
    const select = page.getByLabel("New browser access")
    await expect(select).toBeVisible()
    expect(await select.evaluate((field) => field.ownerDocument.defaultView?.getComputedStyle(field).fontSize)).toBe(
      "16px"
    )
  })
})
