import * as Schema from "effect/Schema"

import { ReleaseDeliveryGraphInspection } from "../../src/api/deliveryGraph.js"
import { ReleaseId, WorkspaceId } from "../../src/domain/identifiers.js"

export const WORKSET_WORKSPACE_ID = Schema.decodeUnknownSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000001")
export const WORKSET_RELEASE_ID = Schema.decodeUnknownSync(ReleaseId)("01890f6f-6d6a-7cc0-98d2-000000000011")

const recordedAt = "2026-07-14T10:02:00.000Z"
const uuid = (group: number, ordinal: number): string =>
  `01890f6f-6d6a-7cc0-98d${String(group)}-${String(ordinal).padStart(12, "0")}`

const issueEntityIds = Array.from({ length: 6 }, (_, index) => uuid(3, index + 1))
const issueNodeIds = Array.from({ length: 6 }, (_, index) => uuid(4, index + 1))
const pullRequestEntityIds = Array.from({ length: 2 }, (_, index) => uuid(3, index + 21))
const pullRequestNodeIds = Array.from({ length: 2 }, (_, index) => uuid(4, index + 21))
const pipelineEntityId = uuid(3, 31)
const pipelineNodeId = uuid(4, 31)
const runbookEntityId = uuid(3, 41)
const runbookNodeId = uuid(4, 41)
const releaseNodeId = uuid(4, 51)
const missingPullRequestNodeId = uuid(4, 61)

const projection = (value: object) => ({ projection: value, recordedAt })

const entityNode = (nodeId: string, entityId: string, entityKind: string) => ({
  workspaceId: WORKSET_WORKSPACE_ID,
  nodeId,
  endpointKind: entityKind,
  resolution: { _tag: "resolved", target: { _tag: "entity", entityId, entityKind } },
  createdAt: recordedAt
})

const relationship = (
  ordinal: number,
  kind: string,
  sourceNodeId: string,
  sourceNodeKind: string,
  targetNodeId: string,
  targetNodeKind: string,
  lifecycle: object
) => ({
  workspaceId: WORKSET_WORKSPACE_ID,
  relationshipId: uuid(5, ordinal),
  relationshipSchemaVersion: 1,
  revision: 1,
  supersedesRevision: null,
  kind,
  sourceNodeId,
  sourceNodeKind,
  targetNodeId,
  targetNodeKind,
  scope: { _tag: "release", releaseId: WORKSET_RELEASE_ID },
  lifecycle,
  confidence: { _tag: "unknown", rationale: "Reference fixture without provider evidence." },
  provenance: {
    _tag: "rule",
    ruleId: "release-workset-reference",
    ruleVersion: 1,
    rationale: "Stable browser reference relationship."
  },
  recordedBy: { _tag: "system", component: "release-workset-fixture" },
  evidenceClaimIds: [],
  recordedAt
})

/** Decoded D06 reference: six Jira items, two PR groups covering five, one gap, one pipeline and runbook. */
export const releaseWorksetFixture = Schema.decodeUnknownSync(ReleaseDeliveryGraphInspection)({
  releaseId: WORKSET_RELEASE_ID,
  environmentId: null,
  truncated: false,
  entityProjections: [
    ...issueEntityIds.map((entityId, index) =>
      projection({
        workspaceId: WORKSET_WORKSPACE_ID,
        entityId,
        projectionRevision: 1,
        sourceEntityRevision: 1,
        supersedesProjectionRevision: null,
        projectionSchemaVersion: 1,
        entityState: "present",
        entityType: "issue",
        displayKey: `OPS-${String(428 + index)}`,
        title: index === 0 ? "Review payment capture safeguards" : `Release requirement ${String(index + 1)}`,
        details: {
          _tag: "issue",
          key: `OPS-${String(428 + index)}`,
          status: index === 0 ? "In review" : index === 5 ? "Blocked" : "Ready",
          priority: index === 0 ? "High" : null,
          estimatePoints: index + 1
        }
      })
    ),
    ...pullRequestEntityIds.map((entityId, index) =>
      projection({
        workspaceId: WORKSET_WORKSPACE_ID,
        entityId,
        projectionRevision: 1,
        sourceEntityRevision: 1,
        supersedesProjectionRevision: null,
        projectionSchemaVersion: 1,
        entityState: "present",
        entityType: "pull-request",
        displayKey: `PR-${String(184 + index * 7)}`,
        title: index === 0 ? "Checkout and capture" : "Settlement verification",
        details: {
          _tag: "pull-request",
          repository: "payments-api",
          sourceBranch: index === 0 ? "feature/capture" : "feature/settlement",
          targetBranch: "main",
          headRevision: `release-head-${String(index + 1)}`,
          reviewState: index === 0 ? "requested" : "approved"
        }
      })
    ),
    projection({
      workspaceId: WORKSET_WORKSPACE_ID,
      entityId: pipelineEntityId,
      projectionRevision: 1,
      sourceEntityRevision: 1,
      supersedesProjectionRevision: null,
      projectionSchemaVersion: 1,
      entityState: "present",
      entityType: "pipeline-execution",
      displayKey: "payments-main/1842",
      title: "Payments production delivery",
      details: {
        _tag: "pipeline-execution",
        pipelineName: "payments-main",
        executionId: "1842",
        status: "running",
        triggerRevision: "release-head"
      }
    }),
    projection({
      workspaceId: WORKSET_WORKSPACE_ID,
      entityId: runbookEntityId,
      projectionRevision: 1,
      sourceEntityRevision: 1,
      supersedesProjectionRevision: null,
      projectionSchemaVersion: 1,
      entityState: "present",
      entityType: "page",
      displayKey: "PAY/RUNBOOK-12",
      title: "Payments release runbook",
      details: { _tag: "page", spaceKey: "PAY", revision: "12", status: "current" }
    })
  ],
  nodes: [
    ...issueEntityIds.map((entityId, index) => entityNode(issueNodeIds[index] ?? "", entityId, "issue")),
    ...pullRequestEntityIds.map((entityId, index) =>
      entityNode(pullRequestNodeIds[index] ?? "", entityId, "pull-request")
    ),
    entityNode(pipelineNodeId, pipelineEntityId, "pipeline-execution"),
    entityNode(runbookNodeId, runbookEntityId, "page"),
    {
      workspaceId: WORKSET_WORKSPACE_ID,
      nodeId: releaseNodeId,
      endpointKind: "release",
      resolution: { _tag: "resolved", target: { _tag: "release", releaseId: WORKSET_RELEASE_ID } },
      createdAt: recordedAt
    },
    {
      workspaceId: WORKSET_WORKSPACE_ID,
      nodeId: missingPullRequestNodeId,
      endpointKind: "pull-request",
      resolution: {
        _tag: "missing",
        expectedKind: "entity",
        expectedEntityKind: "pull-request",
        missingKey: "OPS-433:pull-request"
      },
      createdAt: recordedAt
    }
  ],
  relationships: [
    ...[
      [pullRequestNodeIds[0], issueNodeIds[0]],
      [pullRequestNodeIds[0], issueNodeIds[1]],
      [pullRequestNodeIds[0], issueNodeIds[2]],
      [pullRequestNodeIds[1], issueNodeIds[3]],
      [pullRequestNodeIds[1], issueNodeIds[4]]
    ].map(([pullRequestNodeId, issueNodeId], index) =>
      relationship(
        index + 1,
        "implements",
        pullRequestNodeId ?? "",
        "pull-request",
        issueNodeId ?? "",
        "issue",
        { _tag: "verified", effectiveAt: recordedAt }
      )
    ),
    relationship(
      6,
      "implements",
      missingPullRequestNodeId,
      "pull-request",
      issueNodeIds[5] ?? "",
      "issue",
      {
        _tag: "missing",
        effectiveAt: recordedAt,
        reason: "Implementation evidence has not been linked."
      }
    ),
    ...pullRequestNodeIds.map((pullRequestNodeId, index) =>
      relationship(
        index + 7,
        "delivered-by",
        pullRequestNodeId,
        "pull-request",
        pipelineNodeId,
        "pipeline-execution",
        { _tag: "inferred", effectiveAt: recordedAt }
      )
    ),
    relationship(
      9,
      "documented-by",
      releaseNodeId,
      "release",
      runbookNodeId,
      "page",
      { _tag: "verified", effectiveAt: recordedAt }
    )
  ],
  evidenceClaims: [],
  evidenceItems: []
})
