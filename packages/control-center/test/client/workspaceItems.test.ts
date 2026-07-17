import * as Schema from "effect/Schema"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { filterWorkspaceItems, formatItemFreshness, itemsLocationWithSearch } from "../../src/client/items/ItemsPage.js"
import { presentWorkspaceItems } from "../../src/client/items/presentWorkspaceItems.js"
import { selectReleaseWorksetObject } from "../../src/client/releases/presentReleaseWorkset.js"
import { SelectedReleaseWorksetObjectPanel } from "../../src/client/releases/ReleaseWorkset.js"
import { DeliveryEntityProjection } from "../../src/domain/deliveryGraph.js"
import { releaseWorksetFixture, WORKSET_WORKSPACE_ID } from "../fixtures/releaseWorkset.js"

const items = presentWorkspaceItems(WORKSET_WORKSPACE_ID, [releaseWorksetFixture, releaseWorksetFixture])

describe("workspace items", () => {
  it("deduplicates normalized entities across release slices and maps their services", () => {
    expect(items).toHaveLength(10)
    expect(items.filter(({ service }) => service === "jira")).toHaveLength(6)
    expect(items.filter(({ service }) => service === "codecommit")).toHaveLength(2)
    expect(items.filter(({ service }) => service === "codepipeline")).toHaveLength(1)
    expect(items.filter(({ service }) => service === "confluence")).toHaveLength(1)

    const issue = items.find(({ key }) => key === "OPS-428")
    if (issue === undefined) throw new Error("Expected OPS-428 in the workspace item fixture")
    expect(issue).toMatchObject({
      kind: "issue",
      owner: "Unassigned",
      status: "In review",
      statusGroup: "active",
      title: "Review payment capture safeguards",
      tone: "progress"
    })
    expect(issue.href).toBe(
      `/w/${WORKSET_WORKSPACE_ID}/releases/${releaseWorksetFixture.releaseId}?object=${issue.entityId}#release-work`
    )
    expect(issue.freshness).toBe("2026-07-14T10:02:00.000Z")
    expect(formatItemFreshness(issue.freshness)).toBe("14 Jul 2026, 10:02")
  })

  it("combines text, service, type, and status filters without substituting results", () => {
    expect(
      filterWorkspaceItems(items, { query: "ops-428", service: "all", status: "all", type: "all" }).map(
        ({ key }) => key
      )
    ).toEqual(["OPS-428"])

    expect(
      filterWorkspaceItems(items, { query: "", service: "codecommit", status: "all", type: "all" })
    ).toHaveLength(2)

    expect(
      filterWorkspaceItems(items, { query: "", service: "all", status: "failed", type: "issue" }).map(
        ({ key }) => key
      )
    ).toEqual(["OPS-433"])

    expect(
      filterWorkspaceItems(items, { query: "does-not-exist", service: "all", status: "all", type: "all" })
    ).toEqual([])
  })

  it("preserves the exact Items fragment while replacing or clearing filters", () => {
    const filtered = new URLSearchParams("service=jira&status=failed")
    expect(itemsLocationWithSearch({ hash: "#results", pathname: `/w/${WORKSET_WORKSPACE_ID}/items` }, filtered))
      .toEqual({
        hash: "#results",
        pathname: `/w/${WORKSET_WORKSPACE_ID}/items`,
        search: "?service=jira&status=failed"
      })
    expect(
      itemsLocationWithSearch({ hash: "", pathname: `/w/${WORKSET_WORKSPACE_ID}/items` }, new URLSearchParams())
    ).toEqual({ hash: "", pathname: `/w/${WORKSET_WORKSPACE_ID}/items`, search: "" })
  })

  it("preserves selection for deployment and time-entry objects outside the primary workset dimensions", () => {
    const source = releaseWorksetFixture.entityProjections[0]
    if (source === undefined) throw new Error("Expected a source projection")
    const deployment = Schema.decodeUnknownSync(DeliveryEntityProjection)({
      ...source.projection,
      entityId: "01890f6f-6d6a-7cc0-98d3-000000000091",
      entityType: "deployment",
      displayKey: "production/capture-1842",
      title: "Capture production deployment",
      details: {
        _tag: "deployment",
        environmentId: "01890f6f-6d6a-7cc0-98d2-000000000091",
        revision: "capture-1842",
        status: "deploying"
      }
    })
    const timeEntry = Schema.decodeUnknownSync(DeliveryEntityProjection)({
      ...source.projection,
      entityId: "01890f6f-6d6a-7cc0-98d3-000000000092",
      entityType: "time-entry",
      displayKey: "CLOCK-902",
      title: "Release verification",
      details: { _tag: "time-entry", durationMinutes: 45, billable: true, approvalState: "not-required" }
    })
    const pendingTimeEntry = Schema.decodeUnknownSync(DeliveryEntityProjection)({
      ...source.projection,
      entityId: "01890f6f-6d6a-7cc0-98d3-000000000093",
      entityType: "time-entry",
      displayKey: "CLOCK-903",
      title: "Release follow-up",
      details: { _tag: "time-entry", durationMinutes: 15, billable: false, approvalState: "pending" }
    })
    const inspection = {
      ...releaseWorksetFixture,
      entityProjections: [
        ...releaseWorksetFixture.entityProjections,
        { recordedAt: source.recordedAt, projection: deployment },
        { recordedAt: source.recordedAt, projection: timeEntry },
        { recordedAt: source.recordedAt, projection: pendingTimeEntry }
      ]
    }

    const selectedDeployment = selectReleaseWorksetObject(inspection, "01890f6f-6d6a-7cc0-98d3-000000000091")
    expect(selectedDeployment).toMatchObject({
      facts: [
        { label: "Environment", value: "01890f6f-6d6a-7cc0-98d2-000000000091" },
        { label: "Revision", value: "capture-1842" }
      ],
      kind: "deployment",
      label: "production/capture-1842",
      service: "codepipeline",
      status: "Deploying",
      title: "Capture production deployment",
      tone: "progress"
    })
    if (selectedDeployment === null) throw new Error("Expected the selected deployment")
    const selectedMarkup = renderToStaticMarkup(
      createElement(SelectedReleaseWorksetObjectPanel, { selectedObject: selectedDeployment })
    )
    expect(selectedMarkup).toContain("production/capture-1842")
    expect(selectedMarkup).toContain("Capture production deployment")
    expect(selectedMarkup).toContain("Deploying")
    expect(selectedMarkup).toContain("deployment")
    expect(selectedMarkup).toContain("capture-1842")
    expect(selectReleaseWorksetObject(inspection, "01890f6f-6d6a-7cc0-98d3-000000000092")).toMatchObject({
      facts: [
        { label: "Duration", value: "45 minutes" },
        { label: "Billing", value: "Billable" }
      ],
      kind: "time-entry",
      label: "CLOCK-902",
      service: "clockify",
      status: "Not Required",
      title: "Release verification",
      tone: "positive"
    })
    expect(selectReleaseWorksetObject(inspection, "not-an-entity")).toBeNull()

    const extendedItems = presentWorkspaceItems(WORKSET_WORKSPACE_ID, [inspection])
    expect(extendedItems.find(({ key }) => key === "CLOCK-902")).toMatchObject({
      status: "Not Required",
      statusGroup: "done",
      tone: "positive"
    })
    expect(extendedItems.find(({ key }) => key === "CLOCK-903")).toMatchObject({
      status: "Pending",
      statusGroup: "active",
      tone: "progress"
    })
    expect(
      filterWorkspaceItems(extendedItems, { query: "", service: "clockify", status: "done", type: "time-entry" }).map(
        ({ key }) => key
      )
    ).toEqual(["CLOCK-902"])
  })

  it("treats superseded documentation as needing attention", () => {
    const source = releaseWorksetFixture.entityProjections[0]
    if (source === undefined) throw new Error("Expected a source projection")
    const page = (status: "current" | "superseded", suffix: string) =>
      Schema.decodeUnknownSync(DeliveryEntityProjection)({
        ...source.projection,
        entityId: `01890f6f-6d6a-7cc0-98d3-0000000000${suffix}`,
        entityType: "page",
        displayKey: `RUN-${suffix}`,
        title: `${titleCaseForTest(status)} runbook`,
        details: { _tag: "page", revision: `rev-${suffix}`, spaceKey: "OPS", status }
      })
    const inspection = {
      ...releaseWorksetFixture,
      entityProjections: [
        { recordedAt: source.recordedAt, projection: page("current", "94") },
        { recordedAt: source.recordedAt, projection: page("superseded", "95") }
      ]
    }
    const documentation = presentWorkspaceItems(WORKSET_WORKSPACE_ID, [inspection])

    expect(documentation.find(({ key }) => key === "RUN-94")).toMatchObject({
      statusGroup: "done",
      tone: "positive"
    })
    expect(documentation.find(({ key }) => key === "RUN-95")).toMatchObject({
      statusGroup: "failed",
      tone: "critical"
    })
  })

  it("treats closed provider issues as completed", () => {
    const source = releaseWorksetFixture.entityProjections[0]
    if (source === undefined) throw new Error("Expected a source projection")
    const closedIssue = Schema.decodeUnknownSync(DeliveryEntityProjection)({
      ...source.projection,
      entityId: "01890f6f-6d6a-7cc0-98d3-000000000096",
      entityType: "issue",
      displayKey: "OPS-496",
      title: "Retired delivery task",
      details: { _tag: "issue", estimatePoints: null, key: "OPS-496", priority: null, status: "Closed" }
    })
    const closed = presentWorkspaceItems(WORKSET_WORKSPACE_ID, [{
      ...releaseWorksetFixture,
      entityProjections: [{ recordedAt: source.recordedAt, projection: closedIssue }]
    }])

    expect(closed[0]).toMatchObject({ status: "Closed", statusGroup: "done", tone: "positive" })
    expect(items.find(({ key }) => key === "OPS-428")).toMatchObject({ statusGroup: "active", tone: "progress" })
  })
})

const titleCaseForTest = (value: string): string => `${value.charAt(0).toLocaleUpperCase("en-US")}${value.slice(1)}`
