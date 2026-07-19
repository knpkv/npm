import { type BrowserContext, expect, type Page, test } from "@playwright/test"
import * as Schema from "effect/Schema"

import { ReleaseDeliveryGraphInspection, WorkspaceEntityInspection } from "../src/api/deliveryGraph.js"
import { RelationshipRepairProposal } from "../src/domain/relationshipRepair.js"
import { releaseWorksetFixture } from "../test/fixtures/releaseWorkset.js"
import { releasePortfolioFixture } from "./releasePortfolioFixture.js"

interface ReleaseTransitionGeometry {
  readonly bottom: number
  readonly clientRectCount: number
  readonly computedName: string
  readonly display: string
  readonly height: number
  readonly isPaintVisible: boolean
  readonly left: number
  readonly name: string
  readonly opacity: number
  readonly part: string
  readonly right: number
  readonly top: number
  readonly visibility: string
  readonly viewportHeight: number
  readonly viewportWidth: number
  readonly width: number
}

interface ReleaseTransitionSnapshot {
  readonly after: ReadonlyArray<ReleaseTransitionGeometry>
  readonly before: ReadonlyArray<ReleaseTransitionGeometry>
}

interface ReleaseTransitionReadiness {
  readonly reason?: string
  readonly state: "pending" | "rejected" | "resolved"
}

interface BrowserTransitionNameSemantics {
  readonly accepted: ReadonlyArray<{
    readonly computedName: string
    readonly inlineName: string
    readonly name: string
  }>
  readonly rootCollision: BrowserTransitionNameCollision
  readonly surrogateCollision: BrowserTransitionNameCollision
  readonly uppercaseRoot: BrowserTransitionNameCollision
}

interface BrowserTransitionNameCollision {
  readonly computedNames: ReadonlyArray<string>
  readonly readiness: string
}

const snapshot = releasePortfolioFixture
const release = snapshot.releases[0]
if (release === undefined) throw new Error("Expected one browser release fixture")
const heldRelease = snapshot.releases[5]
if (heldRelease === undefined) throw new Error("Expected one held browser release fixture")
const proposalAuthor = release.collaborators[0]
if (proposalAuthor === undefined) throw new Error("Expected one release proposal author")

const ReviewPayload = Schema.Struct({
  decision: Schema.Literals(["approved", "rejected"]),
  rationale: Schema.String,
  reviewId: Schema.String
})

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
const heldFullPath = `/w/${snapshot.workspaceId}/releases/${heldRelease.releaseId}`
const agentPath = `${fullPath}/agent`
const unknownReleaseId = "01890f6f-6d6a-7cc0-98d2-000000000098"
const encodedWorkset = Schema.encodeSync(ReleaseDeliveryGraphInspection)(releaseWorksetFixture)
const canonicalEntityEntry = encodedWorkset.entityProjections[0]
if (canonicalEntityEntry === undefined) throw new Error("Expected one canonical entity browser fixture")
const canonicalEntityId = canonicalEntityEntry.projection.entityId
const canonicalEntityPath = `/w/${snapshot.workspaceId}/items/${canonicalEntityId}`
const canonicalEntityInspection = Schema.encodeSync(WorkspaceEntityInspection)(
  Schema.decodeUnknownSync(WorkspaceEntityInspection)({
    activity: { events: [], truncated: false },
    entity: {
      ...canonicalEntityEntry,
      canonicalReleaseId: encodedWorkset.releaseId,
      owners: [],
      ownersTruncated: false,
      releaseIds: [encodedWorkset.releaseId],
      releaseMembershipsTruncated: false
    },
    freshness: null,
    graph: {
      evidenceClaims: encodedWorkset.evidenceClaims,
      evidenceItems: encodedWorkset.evidenceItems,
      nodes: encodedWorkset.nodes,
      relatedEntityProjections: encodedWorkset.entityProjections.slice(1),
      relationships: encodedWorkset.relationships,
      truncated: false
    },
    isSourceCurrent: true,
    source: {
      firstObservedAt: "2026-07-14T10:00:00.000Z",
      lastObservedAt: "2026-07-14T10:00:00.000Z",
      normalizationSchemaVersion: 1,
      pluginConnectionId: "01890f6f-6d6a-7cc0-98d2-000000000081",
      providerId: "jira",
      revision: "rev-8",
      sourceUrl: "https://jira.example.test/browse/OPS-428",
      synchronizedAt: "2026-07-14T10:01:00.000Z",
      vendorImmutableId: "jira-issue-ops-428"
    }
  })
)

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
  const proposal = Schema.decodeUnknownSync(RelationshipRepairProposal)({
    schemaVersion: 2,
    proposalId: "01890f6f-6d6a-7cc0-98d2-000000000081",
    workspaceId: snapshot.workspaceId,
    releaseId: release.releaseId,
    environmentId: null,
    relationshipId: "01890f6f-6d6a-7cc0-98d5-000000000006",
    expectedRevision: 1,
    disposition: "link",
    rationale: "OPS-428 needs a verified CodeCommit relationship before the release can move.",
    origin: {
      actor: { _tag: "human", personId: proposalAuthor.personId },
      sessionId: "01890f6f-6d6a-7cc0-98d2-000000000091"
    },
    status: "pending",
    proposedAt: "2026-07-14T10:00:00.000Z",
    review: null
  })
  const encodedProposal = Schema.encodeSync(RelationshipRepairProposal)(proposal)
  let currentProposal = proposal
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
  await context.route("**/api/v1/items/*", async (route) => {
    await route.fulfill({
      body: JSON.stringify(canonicalEntityInspection),
      contentType: "application/json",
      status: 200
    })
  })
  await context.route("**/api/v1/relationships/repair-proposals/*/reviews", async (route) => {
    const payload = Schema.decodeUnknownSync(ReviewPayload)(route.request().postDataJSON())
    currentProposal = Schema.decodeUnknownSync(RelationshipRepairProposal)({
      ...encodedProposal,
      status: payload.decision === "approved" ? "approved" : "rejected",
      review: {
        reviewId: payload.reviewId,
        decision: payload.decision,
        rationale: payload.rationale,
        origin: { actor: pairedSession.actor, sessionId: pairedSession.sessionId },
        reviewedAt: "2026-07-14T10:18:00.000Z"
      }
    })
    await route.fulfill({ body: JSON.stringify(currentProposal), contentType: "application/json", status: 200 })
  })
  await context.route("**/api/v1/relationships/releases/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname.endsWith("/repair-proposals")) {
      await route.fulfill({
        body: JSON.stringify({
          applications: [],
          environmentId: null,
          proposals: [currentProposal],
          releaseId: release.releaseId,
          status: null,
          truncated: false
        }),
        contentType: "application/json",
        status: 200
      })
      return
    }
    if (pathname.endsWith("/repair-candidates")) {
      await route.fulfill({
        body: JSON.stringify({
          candidates: [],
          environmentId: null,
          releaseId: release.releaseId,
          truncated: false
        }),
        contentType: "application/json",
        status: 200
      })
      return
    }
    await route.fulfill({ body: JSON.stringify(releaseWorksetFixture), contentType: "application/json", status: 200 })
  })
  await context.route("**/api/v1/events**", async (route) => route.abort("failed"))
  await context.route("**/api/v1/agent/releases/*/turns", async (route) => {
    expect(route.request().headers()["x-csrf-token"]).toBe("cd".repeat(32))
    await route.fulfill({
      body: JSON.stringify({
        eventCursor: snapshot.eventCursor,
        provider: "codex",
        release,
        releaseId: release.releaseId,
        reply: "Approval is current. Production deployment evidence is still missing."
      }),
      contentType: "application/json",
      status: 200
    })
  })
}

const installTransitionProbe = async (page: Page): Promise<void> => {
  await page.addInitScript({
    content: `
      window.__releaseTransitionSnapshots = [];
      window.__releaseTransitionReadiness = [];
      const originalStartViewTransition = document.startViewTransition?.bind(document);
      if (originalStartViewTransition) {
        document.startViewTransition = (update) => {
          const collect = () => [...document.querySelectorAll('[data-rly-release-transition-part]')]
            .filter((element) => element.dataset.rlyReleaseTransitionName)
            .map((element) => {
              const bounds = element.getBoundingClientRect();
              const computedStyle = getComputedStyle(element);
              return {
                bottom: bounds.bottom,
                clientRectCount: element.getClientRects().length,
                computedName: computedStyle.viewTransitionName,
                display: computedStyle.display,
                height: bounds.height,
                isPaintVisible: element.checkVisibility({
                  checkOpacity: true,
                  checkVisibilityCSS: true
                }),
                left: bounds.left,
                name: element.dataset.rlyReleaseTransitionName,
                opacity: Number.parseFloat(computedStyle.opacity),
                part: element.dataset.rlyReleaseTransitionPart,
                right: bounds.right,
                top: bounds.top,
                visibility: computedStyle.visibility,
                viewportHeight: innerHeight,
                viewportWidth: innerWidth,
                width: bounds.width
              };
            });
          const before = collect();
          const transition = originalStartViewTransition(async () => {
            const result = await update();
            window.__releaseTransitionSnapshots.push({ before, after: collect() });
            return result;
          });
          const readiness = { state: 'pending' };
          window.__releaseTransitionReadiness.push(readiness);
          transition.ready.then(
            () => { readiness.state = 'resolved'; },
            (error) => {
              readiness.reason = String(error);
              readiness.state = 'rejected';
            }
          );
          return transition;
        };
      }
    `
  })
}

test.beforeEach(async ({ context }) => installReleaseMocks(context))

const expectVisibleTransitionGeometry = (geometry: ReleaseTransitionGeometry): void => {
  expect(geometry.clientRectCount).toBeGreaterThan(0)
  expect(geometry.display).not.toBe("none")
  expect(geometry.width).toBeGreaterThan(0)
  expect(geometry.height).toBeGreaterThan(0)
  expect(geometry.isPaintVisible).toBe(true)
  expect(geometry.opacity).toBeGreaterThan(0)
  expect(geometry.right).toBeGreaterThan(0)
  expect(geometry.bottom).toBeGreaterThan(0)
  expect(geometry.left).toBeLessThan(geometry.viewportWidth)
  expect(geometry.top).toBeLessThan(geometry.viewportHeight)
  expect(geometry.visibility).toBe("visible")
  expect(geometry.computedName).toBe(geometry.name)
}

const transitionIdentity = (
  geometry: ReleaseTransitionGeometry
): { readonly name: string; readonly part: string } => ({ name: geometry.name, part: geometry.part })

test("canonicalizes the root before any release activation renders", async ({ page }) => {
  await page.goto("/")
  await expect(page).toHaveURL(overviewPath)
  await expect(page.getByRole("button", { name: "Preview Solar Grove" })).toBeVisible()
})

test("filters all six release states through keyboard-accessible persistent URLs", async ({ page }) => {
  await page.goto(overviewPath)
  await expect(page.locator("[data-portfolio-release-id]")).toHaveCount(6)
  await expect(page.getByRole("link", { name: /All 6 releases/u })).toHaveAttribute("aria-current", "page")

  const attention = page.getByRole("link", { name: /Need attention 2 releases/u })
  await attention.focus()
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(`${overviewPath}?status=attention`)
  await expect(page.locator("[data-portfolio-release-id]")).toHaveCount(2)
  await expect(page.locator("[data-rly-release-state=\"blocked\"]")).toBeVisible()
  await expect(page.locator("[data-rly-release-state=\"held\"]")).toBeVisible()

  await page.reload()
  await expect(page).toHaveURL(`${overviewPath}?status=attention`)
  await expect(page.locator("[data-portfolio-release-id]")).toHaveCount(2)

  await page.goBack()
  await expect(page).toHaveURL(overviewPath)
  await expect(page.locator("[data-portfolio-release-id]")).toHaveCount(6)
})

test("opens preview first, restores focus, then pushes the canonical full route", async ({ page }) => {
  await page.goto(overviewPath)
  const previewButton = page.getByRole("button", { name: "Preview Solar Grove" })
  await expect(previewButton).toBeVisible()

  await previewButton.focus()
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(previewPath)
  const dialog = page.getByRole("dialog", { name: "Release preview: 2.18.0-rc.1 Solar Grove" })
  await expect(dialog).toBeVisible()
  await expect(page.locator("[data-rly-release-preview-summary]")).toBeFocused()
  await expect(page.locator("[inert]")).not.toHaveCount(0)
  await expect(page.locator("body")).toHaveAttribute("data-scroll-locked", "1")

  await page.keyboard.press("Escape")
  await expect(page).toHaveURL(overviewPath)
  await expect(previewButton).toBeFocused()

  await previewButton.click()
  await page.getByRole("button", { name: "Open Solar Grove full view" }).click()
  await expect(page).toHaveURL(fullPath)
  const fullHeading = page.getByRole("heading", { level: 1, name: "payments-api" })
  await expect(fullHeading).toBeVisible()
  await expect(fullHeading).toBeFocused()
  await expect(page.locator("[data-rly-workset-jira-id]")).toHaveCount(6)

  await page.goBack()
  await expect(page).toHaveURL(previewPath)
  await expect(dialog).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page).toHaveURL(overviewPath)
  await expect(previewButton).toBeFocused()
})

test("preserves a filtered overview origin through a preview verdict action", async ({ page }) => {
  const filteredOverviewPath = `${overviewPath}?status=attention`
  await page.goto(filteredOverviewPath)
  const heldRow = page.locator(`[data-portfolio-release-id="${heldRelease.releaseId}"]`)
  await heldRow.getByRole("button", { name: /^Preview /u }).click()

  await page.getByRole("link", { name: "Repair missing links" }).click()
  await expect(page).toHaveURL(`${heldFullPath}#release-work`)
  await page.getByRole("link", { name: "Back to overview" }).click()
  await expect(page).toHaveURL(filteredOverviewPath)
})

test("preserves the exact overview origin through preview and canonical entity Back actions", async ({ page }) => {
  const filteredOverviewPath = `${overviewPath}?status=attention#release-list`
  await page.goto(filteredOverviewPath)
  await page.getByRole("button", { name: "Preview Solar Grove" }).click()

  const preview = page.getByRole("dialog", { name: "Release preview: 2.18.0-rc.1 Solar Grove" })
  await preview.locator(`[data-rly-workset-jira-id="${canonicalEntityId}"] a`).click()
  await expect(page).toHaveURL(canonicalEntityPath)
  await expect(page.locator(`[data-workspace-entity-id="${canonicalEntityId}"]`)).toBeVisible()

  await page.getByRole("link", { name: "Back to release" }).click()
  await expect(page).toHaveURL(previewPath)
  await page.getByRole("button", { name: "Close preview" }).click()
  await expect(page).toHaveURL(filteredOverviewPath)
})

test("returns a directly loaded canonical entity to Items", async ({ page }) => {
  await page.goto(canonicalEntityPath)
  await expect(page.locator(`[data-workspace-entity-id="${canonicalEntityId}"]`)).toBeVisible()

  await page.getByRole("link", { name: "Back to items" }).click()
  await expect(page).toHaveURL(`/w/${snapshot.workspaceId}/items`)
})

test("preserves a filtered overview through Active work and the full release", async ({ page }) => {
  const filteredOverviewPath = `${overviewPath}?status=attention`
  await page.goto(filteredOverviewPath)
  const blockedRow = page.locator(`[data-portfolio-release-id="${release.releaseId}"]`)
  await blockedRow.getByRole("button", { name: /^Preview /u }).click()

  await page.getByRole("link", { name: "Review blocker" }).click()
  await expect(page).toHaveURL(`/w/${snapshot.workspaceId}/work?release=${release.releaseId}`)
  await expect
    .poll(() => page.evaluate<string | undefined>("window.history.state?.usr?.origin?.search"))
    .toBe("?status=attention")
  await page.getByRole("link", { name: "Open full release" }).click()
  await expect(page).toHaveURL(fullPath)
  await expect
    .poll(() => page.evaluate<string | undefined>("window.history.state?.usr?.origin?.search"))
    .toBe("?status=attention")
  await page.getByRole("link", { name: "Back to overview" }).click()
  await expect(page).toHaveURL(filteredOverviewPath)
})

test("preserves a filtered overview through every release-work object link", async ({ page }) => {
  const filteredOverviewPath = `${overviewPath}?status=attention`
  const objectLinks = [
    { kind: "Jira", selector: "[data-rly-workset-jira-id] a" },
    { kind: "pull request", selector: "[data-rly-workset-pr-id] a" },
    { kind: "pipeline", selector: "[data-rly-workset-pipeline-id] a" },
    { kind: "runbook", selector: null }
  ]

  for (const objectLink of objectLinks) {
    await page.goto(filteredOverviewPath)
    const blockedRow = page.locator(`[data-portfolio-release-id="${release.releaseId}"]`)
    await blockedRow.getByRole("button", { name: /^Preview /u }).click()
    const preview = page.getByRole("dialog", { name: "Release preview: 2.18.0-rc.1 Solar Grove" })
    const link = objectLink.selector === null
      ? preview.getByRole("link", { name: /Payments release runbook/u })
      : preview.locator(objectLink.selector).first()
    const href = await link.getAttribute("href")
    if (href === null) throw new Error(`${objectLink.kind} link must expose its canonical entity URL`)
    expect(href).toMatch(new RegExp(`^/w/${snapshot.workspaceId}/items/`))

    await link.click()
    await expect(page, `${objectLink.kind} link opens its canonical full entity`).toHaveURL(href)
    await page.getByRole("link", { name: "Back to release" }).click()
    await expect(page, `${objectLink.kind} link returns to its release preview`).toHaveURL(previewPath)
    await page.getByRole("button", { name: "Close preview" }).click()
    await expect(page, `${objectLink.kind} link retains the filtered origin`).toHaveURL(filteredOverviewPath)
  }
})

test("shows six Jira items as one release workset with PR and pipeline dimensions", async ({ page }) => {
  await page.goto(fullPath)

  await expect(page.locator("[data-rly-workset-jira-id]")).toHaveCount(6)
  await expect(page.locator("[data-rly-workset-pr-id]")).toHaveCount(2)
  await expect(page.locator("[data-rly-workset-gap-id]")).toHaveCount(1)
  await expect(page.locator("[data-rly-workset-pipeline-id]")).toHaveCount(1)
  await expect(page.getByText("OPS-433 has no CodeCommit pull request")).toBeVisible()
  await expect(page.getByRole("link", { name: /Payments release runbook/u })).toBeVisible()
  await expect(page.locator("[data-rly-workset-jira-id] a")).toHaveCount(6)
  await expect(page.locator("[data-rly-workset-pr-id] a")).toHaveCount(2)
  await expect(page.locator("[data-rly-workset-pipeline-id] a")).toHaveCount(1)

  const firstJiraItem = page.locator("[data-rly-workset-jira-id]").first()
  const firstJiraId = await firstJiraItem.getAttribute("data-rly-workset-jira-id")
  if (firstJiraId === null) throw new Error("Expected the first Jira work item to expose its entity id")
  await firstJiraItem.getByRole("link").click()
  await expect(page).toHaveURL(`/w/${snapshot.workspaceId}/items/${firstJiraId}`)
  await expect(page.locator(`[data-workspace-entity-id="${firstJiraId}"]`)).toBeVisible()
  await expect(page.getByRole("heading", { name: "Review payment capture safeguards" })).toBeVisible()
  await page.getByRole("link", { name: "Back to release" }).click()
  await expect(page).toHaveURL(fullPath)
  await page.getByRole("link", { name: "Back to overview" }).click()
  await expect(page).toHaveURL(overviewPath)
})

test("keeps the complete release context and persists its relationship-repair review", async ({ page }) => {
  await page.goto(`/w/${snapshot.workspaceId}/work?release=${release.releaseId}`)

  await expect(page.getByRole("heading", { name: /Decisions, not tickets/u })).toBeVisible()
  await expect(page.locator("[data-rly-workset-jira-id]")).toHaveCount(6)
  await expect(page.locator("[data-rly-workset-pr-id]")).toHaveCount(2)
  await expect(page.locator("[data-rly-workset-pipeline-id]")).toHaveCount(1)
  await expect(page.getByRole("link", { name: /Payments release runbook/u })).toBeVisible()
  await expect(page.getByRole("link", { name: "Review blocker" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Ask about this release" })).toBeVisible()
  await expect(page.getByText(/OPS-428 needs a verified CodeCommit relationship/u)).toBeVisible()
  await page.getByRole("button", { name: "Review proposal" }).click()
  await page.getByRole("textbox", { name: "Review note" }).fill("The implementation evidence is ready.")
  await page.getByRole("button", { name: "Approve" }).click()
  await expect(page.getByText("Ready to apply")).toBeVisible()

  await page.reload()
  await expect(page.getByText("Ready to apply")).toBeVisible()
  await expect(page.getByText("The implementation evidence is ready.")).toBeVisible()

  await page.getByRole("link", { name: "Open full release" }).click()
  await page.getByRole("link", { name: "Back to overview" }).click()
  await expect(page).toHaveURL(overviewPath)
})

test("keeps the complete release workset readable on a compact viewport", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 640 })
  await page.goto(fullPath)

  await expect(page.locator("[data-rly-workset-jira-id]")).toHaveCount(6)
  await expect(page.locator("[data-rly-workset-dimension]")).toHaveCount(3)
  await expect.poll(() => page.evaluate<boolean>("document.documentElement.scrollWidth <= window.innerWidth")).toBe(
    true
  )
})

test("keeps one human-first Relay thread per canonical release", async ({ page }) => {
  await page.goto(fullPath)
  await page.getByRole("button", { name: "Ask about this release" }).click()
  await expect(page).toHaveURL(agentPath)
  await expect(page.getByRole("heading", { level: 1, name: "Ask Solar Grove." })).toBeVisible()
  await expect(page.getByText("Avery Bell")).toBeVisible()
  await expect(page.getByText("Mara Singh")).toBeVisible()

  await page.getByRole("button", { name: "Which evidence is still missing?" }).click()
  await expect(page.getByRole("textbox", { name: "What do you need?" })).toHaveValue(
    "Which evidence is still missing?"
  )
  await page.getByRole("button", { name: "Ask Relay" }).click()
  await expect(page.getByText("Approval is current. Production deployment evidence is still missing.")).toBeVisible()
  await expect(page.getByText("Local codex")).toBeVisible()

  await page.reload()
  const restoredMessages = page.getByLabel("Release thread messages")
  await expect(restoredMessages.getByText("Which evidence is still missing?")).toBeVisible()
  await expect(
    restoredMessages.getByText("Approval is current. Production deployment evidence is still missing.")
  ).toBeVisible()

  await page.getByRole("link", { name: "Back to release" }).click()
  await page.getByRole("link", { name: "Back to overview" }).click()
  await expect(page).toHaveURL(overviewPath)
})

test("retains the filtered overview through Active work and the release agent", async ({ page }) => {
  const filteredOverviewPath = `${overviewPath}?status=attention`
  await page.goto(filteredOverviewPath)
  await page.getByRole("button", { name: "Preview Solar Grove" }).click()
  await page.getByRole("link", { name: "Review blocker" }).click()
  await expect(page).toHaveURL(`/w/${snapshot.workspaceId}/work?release=${release.releaseId}`)

  await page.getByRole("button", { name: "Ask about this release" }).click()
  await expect(page).toHaveURL(agentPath)
  await page.getByRole("link", { name: "Back to release" }).click()
  await expect(page).toHaveURL(fullPath)
  await page.getByRole("link", { name: "Back to overview" }).click()
  await expect(page).toHaveURL(filteredOverviewPath)
})

test("rebinds a filtered overview origin when Active work changes release", async ({ page }) => {
  const filteredOverviewPath = `${overviewPath}?status=attention`
  await page.goto(filteredOverviewPath)
  await page.getByRole("button", { name: "Preview Solar Grove" }).click()
  await page.getByRole("link", { name: "Review blocker" }).click()

  await page.getByRole("link", { name: new RegExp(heldRelease.relay.codename, "u") }).click()
  await expect(page).toHaveURL(`/w/${snapshot.workspaceId}/work?release=${heldRelease.releaseId}`)
  await page.getByRole("link", { name: "Open full release" }).click()
  await expect(page).toHaveURL(heldFullPath)
  await page.getByRole("link", { name: "Back to overview" }).click()
  await expect(page).toHaveURL(filteredOverviewPath)
})

test("uses semantic fallback when direct Active work changes release", async ({ page }) => {
  await page.goto(`/w/${snapshot.workspaceId}/work?release=${release.releaseId}`)
  await page.getByRole("link", { name: new RegExp(heldRelease.relay.codename, "u") }).click()
  await page.getByRole("link", { name: "Open full release" }).click()
  await page.getByRole("link", { name: "Back to overview" }).click()
  await expect(page).toHaveURL(overviewPath)
})

test("opens the selected Active work release from the shell agent control", async ({ page }) => {
  await page.goto(`/w/${snapshot.workspaceId}/work?release=${heldRelease.releaseId}`)
  await page.getByRole("link", { name: "Ask Relay" }).click()
  await expect(page).toHaveURL(`${heldFullPath}/agent`)
  await expect(page.getByRole("heading", { level: 1, name: `Ask ${heldRelease.relay.codename}.` })).toBeVisible()
})

test("keeps an invalid Active work agent context on the safe generic fallback", async ({ page }) => {
  await page.goto(`/w/${snapshot.workspaceId}/work?release=invalid`)
  await page.getByRole("link", { name: "Ask Relay" }).click()
  await expect(page).toHaveURL(/\/agent\?from=/u)
  await expect(page.getByRole("heading", { level: 2, name: "Context unavailable" })).toBeVisible()
})

test("shares Relay, version, and verdict geometry across the sole orchestrated transition", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await installTransitionProbe(page)
  await page.goto(overviewPath)
  // Stretch intrinsic entry motion so a post-transition animation restart stays observably transparent.
  await page.addStyleTag({
    content: "[role=\"dialog\"][data-state=\"open\"] { animation-duration: 10s !important; }"
  })

  await page.getByRole("button", { name: "Preview Solar Grove" }).click()
  await expect(page.getByRole("dialog", { name: "Release preview: 2.18.0-rc.1 Solar Grove" })).toBeVisible()
  await page.waitForFunction("window.__releaseTransitionSnapshots.length === 1")
  await page.waitForFunction("!document.documentElement.matches(':active-view-transition')")
  await expect(page.getByRole("dialog", { name: "Release preview: 2.18.0-rc.1 Solar Grove" })).toHaveCSS(
    "animation-name",
    "none"
  )
  await expect(page.locator("[data-rly-dialog-overlay]")).toHaveCSS("animation-name", "none")

  // Bypass actionability waiting so transition two captures the immediate post-transition paint state.
  await page.getByRole("button", { name: "Open Solar Grove full view" }).dispatchEvent("click")
  await expect(page.getByRole("heading", { level: 1, name: "payments-api" })).toBeVisible()
  await page.waitForFunction("window.__releaseTransitionSnapshots.length === 2")
  await page.waitForFunction(
    "window.__releaseTransitionReadiness.length === 2 && window.__releaseTransitionReadiness.every((entry) => entry.state !== 'pending')"
  )

  const expectedIdentities = [
    { name: `release-${release.releaseId}-relay`, part: "relay" },
    { name: `release-${release.releaseId}-version`, part: "version" },
    { name: `release-${release.releaseId}-verdict`, part: "verdict" }
  ]
  const snapshots = await page.evaluate<ReadonlyArray<ReleaseTransitionSnapshot>>(
    "window.__releaseTransitionSnapshots"
  )
  expect(snapshots).toHaveLength(2)
  for (const snapshot of snapshots) {
    expect(snapshot.before.map(transitionIdentity)).toEqual(expectedIdentities)
    expect(snapshot.after.map(transitionIdentity)).toEqual(expectedIdentities)
    for (const geometry of [...snapshot.before, ...snapshot.after]) expectVisibleTransitionGeometry(geometry)
  }
  const readiness = await page.evaluate<ReadonlyArray<ReleaseTransitionReadiness>>(
    "window.__releaseTransitionReadiness"
  )
  expect(readiness).toEqual([{ state: "resolved" }, { state: "resolved" }])
})

test("gives a compact View Transition sole ownership of sheet entry motion", async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 640 })
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await installTransitionProbe(page)
  await page.goto(overviewPath)
  await page.addStyleTag({
    content: `
      [data-rly-sheet-overlay][data-state="open"],
      [data-rly-sheet-side][data-state="open"] {
        animation-duration: 10s !important;
      }
    `
  })

  await page.getByRole("button", { name: "Preview Solar Grove" }).click()
  const sheet = page.getByRole("dialog", { name: "Release preview: 2.18.0-rc.1 Solar Grove" })
  await expect(sheet).toBeVisible()
  await page.waitForFunction("window.__releaseTransitionSnapshots.length === 1")
  await page.waitForFunction("!document.documentElement.matches(':active-view-transition')")
  await page.waitForFunction(
    "window.__releaseTransitionReadiness.length === 1 && window.__releaseTransitionReadiness[0].state !== 'pending'"
  )
  await expect(page.locator("[data-rly-sheet-layer]")).toHaveAttribute(
    "data-rly-sheet-entry-motion",
    "external"
  )
  await expect(sheet).toHaveCSS("animation-name", "none")
  await expect(page.locator("[data-rly-sheet-overlay]")).toHaveCSS("animation-name", "none")

  const snapshots = await page.evaluate<ReadonlyArray<ReleaseTransitionSnapshot>>(
    "window.__releaseTransitionSnapshots"
  )
  expect(snapshots).toHaveLength(1)
  const snapshot = snapshots[0]
  if (snapshot === undefined) throw new Error("Compact release transition snapshot was unavailable")
  expect(snapshot.before.map(transitionIdentity)).toEqual(snapshot.after.map(transitionIdentity))
  for (const geometry of snapshot.after) expectVisibleTransitionGeometry(geometry)
  expect(await page.evaluate<ReadonlyArray<ReleaseTransitionReadiness>>("window.__releaseTransitionReadiness")).toEqual(
    [
      { state: "resolved" }
    ]
  )
  await expect(page.getByRole("button", { name: "Open Solar Grove full view" })).toBeInViewport()
  expect(await page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")).toBe(true)
})

test("matches Chromium CSSOM semantics for accepted edge names and rejected collisions", async ({ page }) => {
  const semantics = await page.evaluate<BrowserTransitionNameSemantics>(`(async () => {
    const replacementCharacter = String.fromCodePoint(0xfffd);
    const accepted = ["--", replacementCharacter, "ROOT"].map((name) => {
      const element = document.createElement("div");
      document.body.append(element);
      element.style.viewTransitionName = name;
      const computedName = getComputedStyle(element).viewTransitionName;
      const inlineName = element.style.viewTransitionName;
      element.remove();
      return { computedName, inlineName, name };
    });

    const collisionReadiness = async (firstName, secondName) => {
      const host = document.createElement("div");
      const first = document.createElement("div");
      const second = document.createElement("div");
      host.append(first, second);
      document.body.append(host);
      first.style.viewTransitionName = firstName;
      second.style.viewTransitionName = secondName;
      const computedNames = [getComputedStyle(first).viewTransitionName, getComputedStyle(second).viewTransitionName];
      const transition = document.startViewTransition(() => undefined);
      let readiness = "resolved";
      try {
        await transition.ready;
      } catch {
        readiness = "rejected";
      }
      await transition.finished;
      host.remove();
      return { computedNames, readiness };
    };

    const uppercaseRoot = await collisionReadiness("ROOT", "release-other-name");
    const surrogateCollision = await collisionReadiness(String.fromCharCode(0xd800), replacementCharacter);
    const rootChild = document.createElement("div");
    document.body.append(rootChild);
    rootChild.style.viewTransitionName = "root";
    const rootNames = [
      getComputedStyle(document.documentElement).viewTransitionName,
      getComputedStyle(rootChild).viewTransitionName
    ];
    const rootTransition = document.startViewTransition(() => undefined);
    let rootReadiness = "resolved";
    try {
      await rootTransition.ready;
    } catch {
      rootReadiness = "rejected";
    }
    await rootTransition.finished;
    rootChild.remove();
    return {
      accepted,
      rootCollision: { computedNames: rootNames, readiness: rootReadiness },
      surrogateCollision,
      uppercaseRoot
    };
  })()`)

  expect(semantics.accepted).toEqual([
    { computedName: "--", inlineName: "--", name: "--" },
    { computedName: "\uFFFD", inlineName: "\uFFFD", name: "\uFFFD" },
    { computedName: "ROOT", inlineName: "ROOT", name: "ROOT" }
  ])
  expect(semantics.uppercaseRoot).toEqual({
    computedNames: ["ROOT", "release-other-name"],
    readiness: "resolved"
  })
  expect(semantics.surrogateCollision).toEqual({ computedNames: ["\uFFFD", "\uFFFD"], readiness: "rejected" })
  expect(semantics.rootCollision).toEqual({ computedNames: ["root", "root"], readiness: "rejected" })
})

test("renders a compact full-screen sheet and returns direct loads to the semantic parent", async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 320 })
  await page.goto(previewPath)
  await expect(page.locator("[data-rly-release-preview-presentation=\"sheet\"]")).toBeVisible()
  await expect(page.locator("[data-rly-workset-jira-id]")).toHaveCount(6)
  await expect(page.locator("[data-rly-workset-dimension]")).toHaveCount(3)
  expect(await page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")).toBe(true)

  await page.getByRole("button", { name: "Close Release preview: 2.18.0-rc.1 Solar Grove" }).click()
  await expect(page).toHaveURL(overviewPath)
})

test("uses the immediate reduced-motion path at a 200%-zoom-equivalent width", async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 640 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await installTransitionProbe(page)
  await page.goto(overviewPath)

  const previewButton = page.getByRole("button", { name: "Preview Solar Grove" })
  await previewButton.focus()
  await page.keyboard.press("Enter")
  await expect(page.locator("[data-rly-release-preview-presentation=\"sheet\"]")).toBeVisible()
  await expect(page.getByRole("button", { name: "Open Solar Grove full view" })).toBeInViewport()
  expect(await page.evaluate("window.__releaseTransitionSnapshots.length")).toBe(0)
  expect(await page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")).toBe(true)

  await page.getByRole("button", { name: "Open Solar Grove full view" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "payments-api" })).toBeFocused()
  expect(await page.evaluate("window.__releaseTransitionSnapshots.length")).toBe(0)
  expect(await page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")).toBe(true)
})

// The 40px spacing token preserves one readable dossier row while the decision rail stays fixed.
test("keeps the decision rail and dossier usable in short desktop viewports", async ({ page }) => {
  const viewports = [
    { height: 240, width: 641 },
    { height: 320, width: 960 },
    { height: 400, width: 1_280 }
  ]

  for (const viewport of viewports) {
    await page.setViewportSize(viewport)
    await page.goto(previewPath)
    const dialog = page.getByRole("dialog", { name: "Release preview: 2.18.0-rc.1 Solar Grove" })
    const footer = page.locator("[data-rly-release-preview-footer='dialog']")
    const dossier = page.locator("[data-rly-release-preview-scroll='dialog']")
    const fullViewButton = page.getByRole("button", { name: "Open Solar Grove full view" })
    await expect(dialog).toBeVisible()
    await expect(page.locator("[data-rly-release-preview-presentation='dialog']")).toBeVisible()
    await expect(fullViewButton).toBeInViewport({ ratio: 1 })

    const geometry = await page.evaluate<
      {
        readonly dialogBottom: number
        readonly dialogLeft: number
        readonly dialogRight: number
        readonly dialogTop: number
        readonly dossierClientHeight: number
        readonly dossierScrollHeight: number
        readonly footerBottom: number
        readonly footerTop: number
        readonly fullViewButtonBottom: number
        readonly fullViewButtonLeft: number
        readonly fullViewButtonRight: number
        readonly fullViewButtonTop: number
        readonly readableDossierMinBlockSize: number
        readonly viewportHeight: number
        readonly viewportWidth: number
      } | null
    >(`(() => {
      const dialogElement = document.querySelector("[role='dialog']");
      const footerElement = document.querySelector("[data-rly-release-preview-footer='dialog']");
      const dossierElement = document.querySelector("[data-rly-release-preview-scroll='dialog']");
      const fullViewButtonElement = footerElement?.querySelector("button");
      if (
        dialogElement === null ||
        footerElement === null ||
        dossierElement === null ||
        fullViewButtonElement === null ||
        fullViewButtonElement === undefined
      ) return null;
      const dialogBounds = dialogElement.getBoundingClientRect();
      const footerBounds = footerElement.getBoundingClientRect();
      const fullViewButtonBounds = fullViewButtonElement.getBoundingClientRect();
      const readableDossierMinBlockSize = Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--rly-space-40")
      );
      return {
        dialogBottom: dialogBounds.bottom,
        dialogLeft: dialogBounds.left,
        dialogRight: dialogBounds.right,
        dialogTop: dialogBounds.top,
        dossierClientHeight: dossierElement.clientHeight,
        dossierScrollHeight: dossierElement.scrollHeight,
        footerBottom: footerBounds.bottom,
        footerTop: footerBounds.top,
        fullViewButtonBottom: fullViewButtonBounds.bottom,
        fullViewButtonLeft: fullViewButtonBounds.left,
        fullViewButtonRight: fullViewButtonBounds.right,
        fullViewButtonTop: fullViewButtonBounds.top,
        readableDossierMinBlockSize,
        viewportHeight: innerHeight,
        viewportWidth: innerWidth
      };
    })()`)
    expect(geometry).not.toBeNull()
    if (geometry === null) throw new Error(`Release preview geometry was unavailable at ${viewport.width}px`)
    expect(geometry.dialogTop).toBeGreaterThanOrEqual(0)
    expect(geometry.dialogLeft).toBeGreaterThanOrEqual(0)
    expect(geometry.dialogBottom).toBeLessThanOrEqual(geometry.viewportHeight)
    expect(geometry.dialogRight).toBeLessThanOrEqual(geometry.viewportWidth)
    expect(geometry.footerTop).toBeGreaterThanOrEqual(geometry.dialogTop)
    expect(geometry.footerBottom).toBeLessThanOrEqual(geometry.dialogBottom)
    expect(geometry.fullViewButtonTop).toBeGreaterThanOrEqual(0)
    expect(geometry.fullViewButtonLeft).toBeGreaterThanOrEqual(0)
    expect(geometry.fullViewButtonBottom).toBeLessThanOrEqual(geometry.viewportHeight)
    expect(geometry.fullViewButtonRight).toBeLessThanOrEqual(geometry.viewportWidth)
    expect(geometry.readableDossierMinBlockSize).toBeGreaterThan(0)
    expect(geometry.dossierClientHeight).toBeGreaterThanOrEqual(geometry.readableDossierMinBlockSize)
    expect(geometry.dossierScrollHeight).toBeGreaterThan(geometry.dossierClientHeight)
    await expect(footer).toBeVisible()
    await expect(dossier).toBeVisible()
    const dossierScrollTop = await page.evaluate<number>(`(() => {
      const element = document.querySelector("[data-rly-release-preview-scroll='dialog']");
      if (element === null) return 0;
      element.scrollTop = element.scrollHeight;
      return element.scrollTop;
    })()`)
    expect(dossierScrollTop).toBeGreaterThan(0)
    const scrolledFooter = await footer.boundingBox()
    expect(scrolledFooter).not.toBeNull()
    expect(scrolledFooter?.y).toBe(geometry.footerTop)
    await fullViewButton.click()
    await expect(page).toHaveURL(fullPath)
  }
})

test("keeps direct full routes stable across refresh and never substitutes an unknown release", async ({ page }) => {
  await page.goto(fullPath)
  await expect(page.getByRole("heading", { level: 1, name: "payments-api" })).toBeVisible()
  await page.reload()
  await expect(page).toHaveURL(fullPath)
  await expect(page.getByText("Solar Grove", { exact: true })).toBeVisible()

  const unknownReleasePath = `/w/${snapshot.workspaceId}/releases/${unknownReleaseId}`
  await page.goto(unknownReleasePath)
  await expect(page).toHaveURL(unknownReleasePath)
  await expect(page.getByText("Release not found")).toBeVisible()
  await expect(page.getByText("Solar Grove")).toHaveCount(0)
})

test("renders only not-found content for unknown previews and wildcard workspace children", async ({ page }) => {
  const unknownPreviewPath = `/w/${snapshot.workspaceId}/releases/${unknownReleaseId}/preview`
  await page.goto(unknownPreviewPath)
  await expect(page).toHaveURL(unknownPreviewPath)
  await expect(page.getByText("Release not found")).toBeVisible()
  await expect(page.locator("[data-release-not-found]")).toBeFocused()
  await expect(page.locator("[data-portfolio-release-id]")).toHaveCount(0)
  await expect(page.getByText("Solar Grove")).toHaveCount(0)

  const wildcardPath = `/w/${snapshot.workspaceId}/not-a-page`
  await page.goto(wildcardPath)
  await expect(page).toHaveURL(wildcardPath)
  await expect(page.getByText("Page not found")).toBeVisible()
  await expect(page.locator("[data-portfolio-release-id]")).toHaveCount(0)
  await expect(page.getByText("Solar Grove")).toHaveCount(0)
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
  await page.getByRole("button", { name: "Preview Solar Grove" }).click()
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
  await page.getByRole("button", { name: "Preview Solar Grove" }).click()
  await expect(page.getByRole("dialog")).toBeVisible()
  expireSession?.()

  await expect(page.getByText("Release facts stay private")).toBeVisible()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.locator("[data-portfolio-release-id]")).toHaveCount(0)
  await expect(page.locator("[inert]")).toHaveCount(0)
  await expect(page.locator("body")).not.toHaveAttribute("data-scroll-locked", "1")
  await expect(page.getByRole("heading", { level: 1, name: "Every release. One view." })).toBeFocused()
})
