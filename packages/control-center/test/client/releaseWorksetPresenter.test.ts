import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"

import type { ReleaseDeliveryGraphInspection } from "../../src/api/deliveryGraph.js"
import { presentReleaseWorkset, selectReleaseWorksetObject } from "../../src/client/releases/presentReleaseWorkset.js"
import { EntityId, GraphNodeId, RelationshipId } from "../../src/domain/identifiers.js"
import { releaseWorksetFixture, WORKSET_WORKSPACE_ID } from "../fixtures/releaseWorkset.js"

describe("release workset presenter", () => {
  it("keeps all six Jira items in one dimension and groups five under exactly two PRs", () => {
    const workset = presentReleaseWorkset(releaseWorksetFixture, WORKSET_WORKSPACE_ID)

    expect(workset.jiraItems.map(({ key }) => key)).toEqual([
      "OPS-428",
      "OPS-429",
      "OPS-430",
      "OPS-431",
      "OPS-432",
      "OPS-433"
    ])
    expect(workset.pullRequestGroups).toHaveLength(2)
    expect(workset.pullRequestGroups.map(({ linkedJiraKeys }) => linkedJiraKeys)).toEqual([
      ["OPS-428", "OPS-429", "OPS-430"],
      ["OPS-431", "OPS-432"]
    ])
    expect(new Set(workset.pullRequestGroups.flatMap(({ linkedJiraKeys }) => linkedJiraKeys))).toHaveLength(5)
  })

  it("matches Jira work across every graph node resolved to the same pull request", () => {
    const pullRequestNode = releaseWorksetFixture.nodes.find(({ endpointKind }) => endpointKind === "pull-request")
    const movedRelationship = releaseWorksetFixture.relationships.find(
      (relationship) => relationship.kind === "implements" && relationship.sourceNodeId === pullRequestNode?.nodeId
    )
    if (pullRequestNode === undefined || movedRelationship === undefined) {
      throw new Error("Expected a pull-request node with implemented Jira work")
    }
    const duplicateNodeId = Schema.decodeSync(GraphNodeId)("01890f6f-6d6a-7cc0-98d4-000000000099")
    const inspection: ReleaseDeliveryGraphInspection = {
      ...releaseWorksetFixture,
      nodes: [...releaseWorksetFixture.nodes, { ...pullRequestNode, nodeId: duplicateNodeId }],
      relationships: releaseWorksetFixture.relationships.map((relationship) =>
        relationship.relationshipId === movedRelationship.relationshipId
          ? { ...relationship, sourceNodeId: duplicateNodeId }
          : relationship
      )
    }

    const workset = presentReleaseWorkset(inspection, WORKSET_WORKSPACE_ID)

    expect(workset.pullRequestGroups[0]?.linkedJiraKeys).toEqual(["OPS-428", "OPS-429", "OPS-430"])
  })

  it("keeps the unlinked item, pipeline stages, runbook, and navigable object identities explicit", () => {
    const workset = presentReleaseWorkset(releaseWorksetFixture, WORKSET_WORKSPACE_ID)

    expect(workset.gaps).toEqual([expect.objectContaining({
      label: "OPS-433 has no CodeCommit pull request",
      reason: "Implementation evidence has not been linked.",
      service: "codecommit"
    })])
    expect(workset.pipelines).toEqual([expect.objectContaining({
      reference: "payments-main/1842",
      state: "Running",
      stages: [
        { id: "Source", name: "Source", reason: "1 action", state: "Succeeded", tone: "positive" },
        { id: "Approval", name: "Approval", reason: "1 action", state: "Running", tone: "progress" }
      ]
    })])
    expect(workset.runbooks).toEqual([expect.objectContaining({
      completedTasks: 0,
      reference: "PAY/RUNBOOK-12",
      state: "current",
      totalTasks: 0
    })])
    for (const item of [...workset.jiraItems, ...workset.pullRequestGroups, ...workset.pipelines]) {
      expect(item.href).toMatch(/^\/w\/[^/]+\/items\/[^/?#]+$/u)
    }
    expect(workset.runbooks[0]?.href).toMatch(/^\/w\/[^/]+\/items\/[^/?#]+$/u)
  })

  it("counts Confluence tasks and exposes every unchecked task as a release gap", () => {
    const page = releaseWorksetFixture.entityProjections.find(
      ({ projection }) => projection.details._tag === "page"
    )
    if (page?.projection.details._tag !== "page") throw new Error("Expected a Confluence page fixture")
    const inspection: ReleaseDeliveryGraphInspection = {
      ...releaseWorksetFixture,
      entityProjections: releaseWorksetFixture.entityProjections.map((entry) =>
        entry.projection.entityId === page.projection.entityId
          ? {
            ...entry,
            projection: {
              ...page.projection,
              details: {
                ...page.projection.details,
                contentState: "loaded",
                content: {
                  representation: "safe-markdown",
                  markdown: "- [x] Test report\n- [ ] Release notes\n- [ ] Verbal risk assessment"
                }
              }
            }
          }
          : entry
      )
    }

    const workset = presentReleaseWorkset(inspection, WORKSET_WORKSPACE_ID)

    expect(workset.runbooks[0]).toEqual(expect.objectContaining({ completedTasks: 1, totalTasks: 3 }))
    expect(workset.gaps.filter(({ service }) => service === "confluence")).toEqual([
      expect.objectContaining({ label: "Release notes" }),
      expect.objectContaining({ label: "Verbal risk assessment" })
    ])
  })

  it("exposes a release gap when an affected pipeline is not waiting at approval", () => {
    const inspection: ReleaseDeliveryGraphInspection = {
      ...releaseWorksetFixture,
      entityProjections: releaseWorksetFixture.entityProjections.map((entry) =>
        entry.projection.details._tag === "pipeline-execution"
          ? {
            ...entry,
            projection: {
              ...entry.projection,
              details: {
                ...entry.projection.details,
                stages: [{ name: "Approval", status: "succeeded", actionCount: 1, actionsTruncated: false }]
              }
            }
          }
          : entry
      )
    }

    expect(presentReleaseWorkset(inspection, WORKSET_WORKSPACE_ID).gaps).toContainEqual(expect.objectContaining({
      label: "payments-main is not waiting for Stage approval",
      service: "codepipeline"
    }))
  })

  it("maps the OPS-428 review lifecycle and provider states without copying portfolio labels", () => {
    const workset = presentReleaseWorkset(releaseWorksetFixture, WORKSET_WORKSPACE_ID)

    expect(workset.jiraItems[0]).toEqual(expect.objectContaining({
      key: "OPS-428",
      state: "In review",
      tone: "progress"
    }))
    expect(workset.pullRequestGroups.map(({ state, tone }) => ({ state, tone }))).toEqual([
      { state: "Review requested", tone: "progress" },
      { state: "Approved", tone: "positive" }
    ])
    expect(workset.truncated).toBe(false)
  })

  it("presents a closed pull request as completed in groups and selected-object detail", () => {
    const pullRequest = releaseWorksetFixture.entityProjections.find(
      ({ projection }) => projection.details._tag === "pull-request"
    )
    if (pullRequest?.projection.details._tag !== "pull-request") {
      throw new Error("Expected a pull-request projection")
    }
    const inspection: ReleaseDeliveryGraphInspection = {
      ...releaseWorksetFixture,
      entityProjections: releaseWorksetFixture.entityProjections.map((entry) =>
        entry.projection.entityId === pullRequest.projection.entityId
          ? {
            ...entry,
            projection: {
              ...entry.projection,
              details: {
                ...pullRequest.projection.details,
                lifecycle: "closed",
                reviewState: "not-requested"
              }
            }
          }
          : entry
      )
    }

    const workset = presentReleaseWorkset(inspection, WORKSET_WORKSPACE_ID)
    const selected = selectReleaseWorksetObject(inspection, pullRequest.projection.entityId)

    expect(workset.pullRequestGroups[0]).toEqual(expect.objectContaining({ state: "Closed", tone: "positive" }))
    expect(selected).toEqual(expect.objectContaining({ status: "Closed", tone: "positive" }))
  })

  it("keeps a missing resolved PR-to-Jira edge out of linked work while retaining its gap", () => {
    const firstVerified = releaseWorksetFixture.relationships.find(({ lifecycle }) => lifecycle._tag === "verified")
    const missing = releaseWorksetFixture.relationships.find(({ lifecycle }) => lifecycle._tag === "missing")
    if (firstVerified === undefined || missing === undefined) {
      throw new Error("Expected verified and missing fixture edges")
    }
    const inspection: ReleaseDeliveryGraphInspection = {
      ...releaseWorksetFixture,
      relationships: releaseWorksetFixture.relationships.map((relationship) =>
        relationship.relationshipId === missing.relationshipId
          ? { ...relationship, sourceNodeId: firstVerified.sourceNodeId }
          : relationship
      )
    }

    const workset = presentReleaseWorkset(inspection, WORKSET_WORKSPACE_ID)

    expect(workset.pullRequestGroups[0]?.linkedJiraKeys).toEqual(["OPS-428", "OPS-429", "OPS-430"])
    expect(workset.gaps).toEqual([expect.objectContaining({ label: "OPS-433 has no CodeCommit pull request" })])
  })

  it("shows only pages documented directly by the release as runbooks", () => {
    const pageProjection = releaseWorksetFixture.entityProjections.find(
      ({ projection }) => projection.details._tag === "page"
    )
    const pageNode = releaseWorksetFixture.nodes.find(({ endpointKind }) => endpointKind === "page")
    const issueNode = releaseWorksetFixture.nodes.find(({ endpointKind }) => endpointKind === "issue")
    const documentedBy = releaseWorksetFixture.relationships.find(({ kind }) => kind === "documented-by")
    if (
      pageProjection === undefined || pageNode === undefined || issueNode === undefined || documentedBy === undefined
    ) {
      throw new Error("Expected page, issue, and documentation fixtures")
    }
    const issuePageEntityId = Schema.decodeSync(EntityId)("01890f6f-6d6a-7cc0-98d3-000000000001")
    const issuePageNodeId = Schema.decodeSync(GraphNodeId)("01890f6f-6d6a-7cc0-98d4-000000000001")
    const issueDocumentationId = Schema.decodeSync(RelationshipId)("01890f6f-6d6a-7cc0-98d5-000000000099")
    const inspection: ReleaseDeliveryGraphInspection = {
      ...releaseWorksetFixture,
      entityProjections: [
        ...releaseWorksetFixture.entityProjections,
        {
          ...pageProjection,
          projection: {
            ...pageProjection.projection,
            entityId: issuePageEntityId,
            displayKey: "PAY/SPEC-8",
            title: "Payment issue specification"
          }
        }
      ],
      nodes: [
        ...releaseWorksetFixture.nodes,
        {
          ...pageNode,
          nodeId: issuePageNodeId,
          resolution: {
            _tag: "resolved",
            target: { _tag: "entity", entityId: issuePageEntityId, entityKind: "page" }
          }
        }
      ],
      relationships: [
        ...releaseWorksetFixture.relationships,
        {
          ...documentedBy,
          relationshipId: issueDocumentationId,
          sourceNodeId: issueNode.nodeId,
          sourceNodeKind: "issue",
          targetNodeId: issuePageNodeId
        }
      ]
    }

    const workset = presentReleaseWorkset(inspection, WORKSET_WORKSPACE_ID)

    expect(workset.runbooks.map(({ reference }) => reference)).toEqual(["PAY/RUNBOOK-12"])
  })
})
