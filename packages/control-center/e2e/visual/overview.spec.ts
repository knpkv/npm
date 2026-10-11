import { expect } from "@playwright/test"
import * as DateTime from "effect/DateTime"

import type { ReadinessVerdict } from "../../src/domain/readiness/projections.js"
import { captureState } from "./capture.js"
import { expectNoProviderSecrets, JIRA_TOKEN_A } from "./jiraUi.js"
import { setupSixVerdicts } from "./overviewSetup.js"
import { test } from "./visualRuntimeFixture.js"

const capitalized = (state: string) =>
  state.split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ")

/** This held fixture has an unconfirmed runbook link; other held causes have different labels. */
const fixtureVerdictLabels = {
  blocked: "Can't ship",
  ready: "Can ship",
  deploying: "Deploying",
  building: "Building",
  shipped: "Shipped",
  held: "Needs links"
} satisfies Readonly<Record<ReadinessVerdict, string>>

const deliveryStages: ReadonlyArray<"build" | "verify" | "production"> = ["build", "verify", "production"]

/** Six decisions come from real plugins and the supervised readiness producer, never page routes or seeded assessments. */
test("P0-3 six first-party readiness verdicts and keyboard portfolio filters", async ({ page, visualRuntime }) => {
  await visualRuntime.pairThroughUi(page)
  const snapshot = await setupSixVerdicts(page, visualRuntime)
  expect(snapshot.plugins).toHaveLength(4)
  expect(snapshot.plugins.every((plugin) => plugin.health?._tag === "healthy")).toBe(true)
  expect(DateTime.formatIso(snapshot.generatedAt)).toBe("2026-07-14T12:00:00.000Z")
  await page.goto(visualRuntime.origin)
  await expectNoProviderSecrets(page, [JIRA_TOKEN_A, "fixture-confluence-token", "fixture-secret-invalid-for-aws"])
  const rows = page.locator("[data-portfolio-release-id]")
  await expect(rows).toHaveCount(6)
  for (const release of snapshot.releases) {
    const row = page.locator(`[data-portfolio-release-id="${release.releaseId}"]`)
    const readiness = release.readiness
    expect(readiness?.authority).toBe("authoritative")
    if (readiness === null) return
    if (readiness.verdict === "held") {
      expect(readiness.primaryFinding?.code).toBe("relationship-unverified")
      await expect(row.getByText("A delivery link still needs verification.", { exact: true })).toBeVisible()
    }
    await expect(row.getByRole("heading", { name: fixtureVerdictLabels[readiness.verdict], exact: true })).toBeVisible()
    await expect(row.getByText(release.version, { exact: true })).toBeVisible()
    expect(release.relationships).toMatchObject({ issues: 1, pullRequests: 1, pipelineExecutions: 1, truncated: false })
    expect(release.collaborators).toEqual([])
    expect(release.collaboratorCount).toBe(0)
    await expect(row.getByText("Unassigned", { exact: true })).toBeVisible()
    await expect(row.getByText("Approver", { exact: true })).toHaveCount(0)
    expect(release.freshness._tag).toBe("current")
    expect(release.freshness.sourceObservedAt).not.toBeNull()
    if (release.freshness.sourceObservedAt === null) return
    await expect(row.locator("time")).toHaveAttribute(
      "datetime",
      DateTime.formatIso(release.freshness.sourceObservedAt)
    )
    await expect(row.getByText(/^Current,/u)).toBeVisible()
    const delivery = row.getByRole("region", { name: "Delivery", exact: true })
    for (const stage of deliveryStages) {
      const item = delivery.getByRole("listitem").filter({
        has: page.getByRole("heading", { name: capitalized(stage), exact: true })
      })
      await expect(item.getByText(capitalized(readiness.stages[stage].state), { exact: true })).toBeVisible()
    }
  }
  const filters = page.getByRole("navigation", { name: "Release filters" })
  for (
    const filter of [
      {
        label: "All",
        count: 6,
        status: null,
        verdicts: ["blocked", "ready", "deploying", "building", "shipped", "held"]
      },
      { label: "Need attention", count: 2, status: "attention", verdicts: ["blocked", "held"] },
      { label: "Deploying", count: 2, status: "deploying", verdicts: ["deploying", "building"] },
      { label: "Shipped", count: 1, status: "shipped", verdicts: ["shipped"] }
    ] satisfies ReadonlyArray<{
      readonly label: string
      readonly count: number
      readonly status: string | null
      readonly verdicts: ReadonlyArray<ReadinessVerdict>
    }>
  ) {
    const link = filters.getByRole("link", {
      name: `${filter.label} ${filter.count} ${filter.count === 1 ? "release" : "releases"}`,
      exact: true
    })
    await expect(link).toBeVisible()
    for (let tab = 0; tab < 200 && (await link.evaluate((element) => element.matches(":focus"))) === false; tab++) {
      await page.keyboard.press("Tab")
    }
    await expect(link).toBeFocused()
    await page.keyboard.press("Enter")
    await expect(link).toHaveAttribute("aria-current", "page")
    expect(new URL(page.url()).searchParams.get("status")).toBe(filter.status)
    await expect(rows).toHaveCount(filter.count)
    for (const release of snapshot.releases) {
      const visible = filter.verdicts.some((verdict) => verdict === release.readiness?.verdict)
      await expect(page.locator(`[data-portfolio-release-id="${release.releaseId}"]`)).toHaveCount(visible ? 1 : 0)
    }
    await captureState(page, `overview-${filter.label.toLowerCase().replaceAll(" ", "-")}`, {
      evidence: link,
      landmark: page.getByRole("heading", { name: "Every release. One view." }),
      primaryAction: link,
      exercise: async (action) => {
        await action.press("Enter")
      },
      expectOutcome: async () => {
        await expect(link).toHaveAttribute("aria-current", "page")
        await expect(rows).toHaveCount(filter.count)
      }
    })
  }
})
