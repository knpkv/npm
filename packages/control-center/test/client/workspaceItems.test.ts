import { Result, Schema } from "effect"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router"
import { describe, expect, it } from "vitest"

import { WorkspaceEntityProjectionIndex } from "../../src/api/deliveryGraph.js"
import {
  filterWorkspaceItems,
  formatItemFreshness,
  itemsLocationWithSearch,
  selectWorkspaceItem,
  unlinkedItemLocation,
  workspaceItemMembershipDescription
} from "../../src/client/items/ItemsPage.js"
import { presentWorkspaceEntityIndex, presentWorkspaceItems } from "../../src/client/items/presentWorkspaceItems.js"
import {
  selectReleaseWorksetObject,
  selectReleaseWorksetTrace
} from "../../src/client/releases/presentReleaseWorkset.js"
import { SelectedReleaseWorksetObjectPanel } from "../../src/client/releases/ReleaseWorkset.js"
import { DeliveryEntityProjection } from "../../src/domain/deliveryGraph.js"
import { GraphNodeId, RelationshipId, ReleaseId } from "../../src/domain/identifiers.js"
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

  it("keeps an unlinked current projection visible in the workspace index", () => {
    const source = releaseWorksetFixture.entityProjections[0]
    if (source === undefined) throw new Error("Expected a source projection")
    const [unlinked] = presentWorkspaceEntityIndex(WORKSET_WORKSPACE_ID, {
      matchedCount: 1,
      totalCount: 1,
      truncated: false,
      items: [{ ...source, canonicalReleaseId: null, releaseIds: [], releaseMembershipsTruncated: false }]
    })

    expect(unlinked).toMatchObject({
      entityId: source.projection.entityId,
      releaseId: null,
      title: source.projection.title
    })
    expect(unlinked?.href).toBe(
      `/w/${WORKSET_WORKSPACE_ID}/items?object=${source.projection.entityId}#item-details`
    )
    expect(selectWorkspaceItem(unlinked === undefined ? [] : [unlinked], source.projection.entityId)).toBe(unlinked)
    expect(selectWorkspaceItem(unlinked === undefined ? [] : [unlinked], "deleted-entity")).toBeNull()
  })

  it("does not advertise canonical releases outside the routable portfolio prefix", () => {
    const source = releaseWorksetFixture.entityProjections[0]
    if (source === undefined) throw new Error("Expected a source projection")
    const canonicalReleaseId = releaseWorksetFixture.releaseId
    const index = {
      matchedCount: 1,
      totalCount: 1,
      truncated: false,
      items: [{
        ...source,
        canonicalReleaseId,
        releaseIds: [canonicalReleaseId],
        releaseMembershipsTruncated: false
      }]
    }

    expect(
      presentWorkspaceEntityIndex(WORKSET_WORKSPACE_ID, index, new Set([canonicalReleaseId]))[0]?.releaseId
    ).toBe(canonicalReleaseId)
    const portfolioPrefix = new Set(
      Array.from({ length: 200 }, (_, index) =>
        Schema.decodeUnknownSync(ReleaseId)(
          `01890f6f-6d6a-7cc0-98d4-${String(index + 1).padStart(12, "0")}`
        ))
    )
    const [outsidePrefix] = presentWorkspaceEntityIndex(WORKSET_WORKSPACE_ID, index, portfolioPrefix)
    expect(outsidePrefix).toMatchObject({ releaseId: null })
    expect(outsidePrefix?.href).toContain(`/w/${WORKSET_WORKSPACE_ID}/items?object=`)
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
    expect(
      unlinkedItemLocation(
        `/w/${WORKSET_WORKSPACE_ID}/items`,
        new URLSearchParams("q=OPS-428&service=jira"),
        "unlinked-entity"
      )
    ).toEqual({
      hash: "#item-details",
      pathname: `/w/${WORKSET_WORKSPACE_ID}/items`,
      search: "?q=OPS-428&service=jira&object=unlinked-entity"
    })
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

  it("centers a compact delivery trace on the exact selected object", () => {
    const issue = releaseWorksetFixture.entityProjections.find(({ projection }) => projection.displayKey === "OPS-428")
    const pullRequest = releaseWorksetFixture.entityProjections.find(
      ({ projection }) => projection.displayKey === "PR-184"
    )
    const blockedIssue = releaseWorksetFixture.entityProjections.find(
      ({ projection }) => projection.displayKey === "OPS-433"
    )
    if (issue === undefined || pullRequest === undefined || blockedIssue === undefined) {
      throw new Error("Expected trace fixture objects")
    }

    const selectedObject = selectReleaseWorksetObject(releaseWorksetFixture, issue.projection.entityId)
    const trace = selectReleaseWorksetTrace(releaseWorksetFixture, WORKSET_WORKSPACE_ID, issue.projection.entityId)
    expect(trace).toMatchObject({
      relationships: [{
        confidence: "Confidence unknown",
        direction: "incoming",
        evidenceCount: 0,
        kind: "implements",
        lifecycle: "Verified",
        other: {
          kind: "pull-request",
          label: "PR-184",
          service: "codecommit",
          title: "Checkout and capture"
        },
        tone: "positive"
      }],
      truncated: false
    })
    if (selectedObject === null || trace === null) throw new Error("Expected selected trace presentation")
    const markup = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ["/"] },
        createElement(SelectedReleaseWorksetObjectPanel, { selectedObject, trace })
      )
    )
    expect(markup).toContain("Delivery trace")
    expect(markup).toContain("From PR-184")
    expect(markup).toContain("Checkout and capture")
    expect(markup).toContain("Verified")
    expect(markup).toContain("Confidence unknown · 0 evidence claims")
    expect(trace.relationships[0]?.other.href).toBe(
      `/w/${WORKSET_WORKSPACE_ID}/releases/${releaseWorksetFixture.releaseId}?object=${pullRequest.projection.entityId}#release-work`
    )
    expect(
      selectReleaseWorksetTrace(releaseWorksetFixture, WORKSET_WORKSPACE_ID, pullRequest.projection.entityId)
        ?.relationships
    ).toHaveLength(4)
    expect(
      selectReleaseWorksetTrace(releaseWorksetFixture, WORKSET_WORKSPACE_ID, blockedIssue.projection.entityId)
        ?.relationships
    ).toMatchObject([{
      direction: "incoming",
      kind: "implements",
      lifecycle: "Missing",
      other: { href: null, kind: "pull-request", title: "Missing Pull Request" },
      tone: "critical"
    }])
    expect(
      selectReleaseWorksetTrace(
        { ...releaseWorksetFixture, truncated: true },
        WORKSET_WORKSPACE_ID,
        issue.projection.entityId
      )?.truncated
    ).toBe(true)

    const deletedConnection = selectReleaseWorksetTrace(
      {
        ...releaseWorksetFixture,
        entityProjections: releaseWorksetFixture.entityProjections.map((entry) =>
          entry.projection.entityId === pullRequest.projection.entityId
            ? ({ ...entry, projection: { ...entry.projection, entityState: "deleted" } } satisfies typeof entry)
            : entry
        )
      },
      WORKSET_WORKSPACE_ID,
      issue.projection.entityId
    )?.relationships[0]?.other
    expect(deletedConnection).toMatchObject({ href: null, title: "Checkout and capture · Deleted" })

    const runbook = releaseWorksetFixture.entityProjections.find(
      ({ projection }) => projection.displayKey === "PAY/RUNBOOK-12"
    )
    if (runbook === undefined) throw new Error("Expected a runbook trace fixture")
    expect(
      selectReleaseWorksetTrace(releaseWorksetFixture, WORKSET_WORKSPACE_ID, runbook.projection.entityId)
        ?.relationships[0]?.other.title
    ).toBe("Current release context")
    const issueNode = releaseWorksetFixture.nodes.find((node) =>
      node.resolution._tag === "resolved" &&
      node.resolution.target._tag === "entity" &&
      node.resolution.target.entityId === issue.projection.entityId
    )
    const relationshipTemplate = releaseWorksetFixture.relationships[0]
    if (issueNode === undefined || relationshipTemplate === undefined) throw new Error("Expected trace graph fixtures")
    const connectedReleaseId = Schema.decodeUnknownSync(ReleaseId)("01890f6f-6d6a-7cc0-98d2-000000000099")
    const connectedReleaseNodeId = Schema.decodeUnknownSync(GraphNodeId)(
      "01890f6f-6d6a-7cc0-98d4-000000000099"
    )
    const connectedReleaseTrace = selectReleaseWorksetTrace(
      {
        ...releaseWorksetFixture,
        nodes: [...releaseWorksetFixture.nodes, {
          ...issueNode,
          nodeId: connectedReleaseNodeId,
          endpointKind: "release",
          resolution: { _tag: "resolved", target: { _tag: "release", releaseId: connectedReleaseId } }
        }],
        relationships: [...releaseWorksetFixture.relationships, {
          ...relationshipTemplate,
          relationshipId: Schema.decodeUnknownSync(RelationshipId)(
            "01890f6f-6d6a-7cc0-98d5-000000000099"
          ),
          kind: "depends-on",
          sourceNodeId: issueNode.nodeId,
          sourceNodeKind: "issue",
          targetNodeId: connectedReleaseNodeId,
          targetNodeKind: "release"
        }]
      },
      WORKSET_WORKSPACE_ID,
      issue.projection.entityId
    )
    expect(connectedReleaseTrace?.relationships.find(({ other }) => other.kind === "release")?.other.title).toBe(
      "Connected release"
    )
    expect(selectReleaseWorksetTrace(releaseWorksetFixture, WORKSET_WORKSPACE_ID, "missing-object")).toBeNull()
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
    const issue = (status: string, suffix: string) =>
      Schema.decodeUnknownSync(DeliveryEntityProjection)({
        ...source.projection,
        entityId: `01890f6f-6d6a-7cc0-98d3-0000000000${suffix}`,
        entityType: "issue",
        displayKey: `OPS-4${suffix}`,
        title: `Provider issue ${suffix}`,
        details: { _tag: "issue", estimatePoints: null, key: `OPS-4${suffix}`, priority: null, status }
      })
    const closed = presentWorkspaceItems(WORKSET_WORKSPACE_ID, [{
      ...releaseWorksetFixture,
      entityProjections: [
        { recordedAt: source.recordedAt, projection: issue("Closed", "96") },
        { recordedAt: source.recordedAt, projection: issue("Ready for review", "97") },
        { recordedAt: source.recordedAt, projection: issue("Not done", "98") }
      ]
    }])

    expect(closed.find(({ status }) => status === "Closed")).toMatchObject({ statusGroup: "done", tone: "positive" })
    expect(closed.find(({ status }) => status === "Ready for review")).toMatchObject({
      statusGroup: "active",
      tone: "progress"
    })
    expect(closed.find(({ status }) => status === "Not done")).toMatchObject({
      statusGroup: "active",
      tone: "progress"
    })
    expect(items.find(({ key }) => key === "OPS-428")).toMatchObject({ statusGroup: "active", tone: "progress" })
  })

  it("preserves every release membership and requires an explicit choice when membership is ambiguous", () => {
    const source = releaseWorksetFixture.entityProjections[0]
    if (source === undefined) throw new Error("Expected a source projection")
    const otherReleaseId = Schema.decodeUnknownSync(ReleaseId)("01890f6f-6d6a-7cc0-98d2-000000000099")
    const unique = Schema.decodeUnknownSync(DeliveryEntityProjection)({
      ...source.projection,
      entityId: "01890f6f-6d6a-7cc0-98d3-000000000099",
      displayKey: "OPS-499",
      title: "Release-specific task",
      details: { _tag: "issue", estimatePoints: null, key: "OPS-499", priority: null, status: "Open" }
    })
    const otherInspection = {
      ...releaseWorksetFixture,
      releaseId: otherReleaseId,
      entityProjections: [
        ...releaseWorksetFixture.entityProjections,
        { recordedAt: source.recordedAt, projection: unique }
      ]
    }
    const forward = presentWorkspaceItems(WORKSET_WORKSPACE_ID, [releaseWorksetFixture, otherInspection])
    const reverse = presentWorkspaceItems(WORKSET_WORKSPACE_ID, [otherInspection, releaseWorksetFixture])
    const releaseIds = [releaseWorksetFixture.releaseId, otherReleaseId]
      .sort((left, right) => left.localeCompare(right))
    const forwardShared = forward.find(({ key }) => key === "OPS-428")
    const reverseShared = reverse.find(({ key }) => key === "OPS-428")

    expect(forwardShared?.href).toBe(reverseShared?.href)
    expect(forwardShared).toMatchObject({ releaseId: null, releaseIds, routableReleaseIds: releaseIds })
    expect(forwardShared?.href).toContain(`/w/${WORKSET_WORKSPACE_ID}/items?object=`)
    expect(forward.find(({ key }) => key === "OPS-499")?.releaseId).toBe(otherReleaseId)
  })

  it("keeps truncated and outside-portfolio memberships ambiguous", () => {
    const source = releaseWorksetFixture.entityProjections[0]
    if (source === undefined) throw new Error("Expected a source projection")
    const releaseIds = Array.from({ length: 500 }, (_, index) =>
      Schema.decodeUnknownSync(ReleaseId)(
        `01890f6f-6d6a-7cc0-98d2-${String(index + 100).padStart(12, "0")}`
      ))
    const truncatedEntry = {
      ...source,
      canonicalReleaseId: releaseIds[0] ?? null,
      releaseIds,
      releaseMembershipsTruncated: true
    }
    const truncatedIndex = {
      matchedCount: 1,
      totalCount: 1,
      truncated: false,
      items: [truncatedEntry]
    }
    const encodedTruncatedIndex = {
      ...truncatedIndex,
      items: [{ ...truncatedEntry, recordedAt: "2026-07-14T10:02:00.000Z" }]
    }
    expect(Result.isSuccess(Schema.decodeUnknownResult(WorkspaceEntityProjectionIndex)(encodedTruncatedIndex))).toBe(
      true
    )
    const [truncated] = presentWorkspaceEntityIndex(WORKSET_WORKSPACE_ID, truncatedIndex, new Set(releaseIds))
    expect(truncated?.releaseId).toBeNull()

    const malformed = {
      ...truncatedIndex,
      items: [{
        ...source,
        canonicalReleaseId: releaseWorksetFixture.releaseId,
        releaseIds: [releaseWorksetFixture.releaseId],
        releaseMembershipsTruncated: true,
        recordedAt: "2026-07-14T10:02:00.000Z"
      }]
    }
    expect(Result.isFailure(Schema.decodeUnknownResult(WorkspaceEntityProjectionIndex)(malformed))).toBe(true)

    const outsidePortfolio = presentWorkspaceEntityIndex(WORKSET_WORKSPACE_ID, {
      ...truncatedIndex,
      items: [{ ...truncatedEntry, releaseMembershipsTruncated: false, releaseIds: releaseIds.slice(0, 2) }]
    }, new Set())[0]
    if (outsidePortfolio === undefined) throw new Error("Expected an outside-portfolio item")
    expect(workspaceItemMembershipDescription(outsidePortfolio)).toContain("2 releases outside the current portfolio")
    expect(workspaceItemMembershipDescription(outsidePortfolio)).not.toContain("Choose")
  })
})

const titleCaseForTest = (value: string): string => `${value.charAt(0).toLocaleUpperCase("en-US")}${value.slice(1)}`
