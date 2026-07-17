import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"

import { filterWorkspaceItems, formatItemFreshness } from "../../src/client/items/ItemsPage.js"
import { presentWorkspaceItems } from "../../src/client/items/presentWorkspaceItems.js"
import { selectReleaseWorksetObject } from "../../src/client/releases/presentReleaseWorkset.js"
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
      details: { _tag: "time-entry", durationMinutes: 45, billable: true, approvalState: "approved" }
    })
    const inspection = {
      ...releaseWorksetFixture,
      entityProjections: [
        ...releaseWorksetFixture.entityProjections,
        { recordedAt: source.recordedAt, projection: deployment },
        { recordedAt: source.recordedAt, projection: timeEntry }
      ]
    }

    expect(selectReleaseWorksetObject(inspection, "01890f6f-6d6a-7cc0-98d3-000000000091")).toMatchObject({
      kind: "deployment",
      label: "production/capture-1842",
      title: "Capture production deployment"
    })
    expect(selectReleaseWorksetObject(inspection, "01890f6f-6d6a-7cc0-98d3-000000000092")).toMatchObject({
      kind: "time-entry",
      label: "CLOCK-902",
      title: "Release verification"
    })
    expect(selectReleaseWorksetObject(inspection, "not-an-entity")).toBeNull()
  })
})
