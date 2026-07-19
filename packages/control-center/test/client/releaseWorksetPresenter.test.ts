import type { RlyStage } from "@knpkv/rly/patterns"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"

import type { ReleaseDeliveryGraphInspection } from "../../src/api/deliveryGraph.js"
import { presentReleaseWorkset } from "../../src/client/releases/presentReleaseWorkset.js"
import { EntityId, GraphNodeId, RelationshipId } from "../../src/domain/identifiers.js"
import { releaseWorksetFixture, WORKSET_WORKSPACE_ID } from "../fixtures/releaseWorkset.js"

const stages: ReadonlyArray<RlyStage> = [
  { id: "build", name: "Build", state: "Passed", tone: "positive" },
  { id: "verify", name: "Verify", state: "Running", tone: "progress" },
  { id: "production", name: "Production", state: "Waiting", tone: "neutral" }
]

describe("release workset presenter", () => {
  it("keeps all six Jira items in one dimension and groups five under exactly two PRs", () => {
    const workset = presentReleaseWorkset(releaseWorksetFixture, WORKSET_WORKSPACE_ID, stages)

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

    const workset = presentReleaseWorkset(inspection, WORKSET_WORKSPACE_ID, stages)

    expect(workset.pullRequestGroups[0]?.linkedJiraKeys).toEqual(["OPS-428", "OPS-429", "OPS-430"])
  })

  it("keeps the unlinked item, pipeline stages, runbook, and navigable object identities explicit", () => {
    const workset = presentReleaseWorkset(releaseWorksetFixture, WORKSET_WORKSPACE_ID, stages)

    expect(workset.gaps).toEqual([expect.objectContaining({
      label: "OPS-433 has no CodeCommit pull request",
      reason: "Implementation evidence has not been linked.",
      service: "codecommit"
    })])
    expect(workset.pipelines).toEqual([expect.objectContaining({
      reference: "payments-main/1842",
      state: "Running",
      stages
    })])
    expect(workset.runbooks).toEqual([expect.objectContaining({
      reference: "PAY/RUNBOOK-12",
      state: "current"
    })])
    for (const item of [...workset.jiraItems, ...workset.pullRequestGroups, ...workset.pipelines]) {
      expect(item.href).toMatch(/^\/w\/[^/]+\/items\/[^/?#]+$/u)
    }
    expect(workset.runbooks[0]?.href).toMatch(/^\/w\/[^/]+\/items\/[^/?#]+$/u)
  })

  it("maps the OPS-428 review lifecycle and provider states without copying portfolio labels", () => {
    const workset = presentReleaseWorkset(releaseWorksetFixture, WORKSET_WORKSPACE_ID, stages)

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

    const workset = presentReleaseWorkset(inspection, WORKSET_WORKSPACE_ID, stages)

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

    const workset = presentReleaseWorkset(inspection, WORKSET_WORKSPACE_ID, stages)

    expect(workset.runbooks.map(({ reference }) => reference)).toEqual(["PAY/RUNBOOK-12"])
  })
})
