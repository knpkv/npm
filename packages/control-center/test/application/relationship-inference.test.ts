import { assert, describe, it } from "@effect/vitest"
import * as Schema from "effect/Schema"

import { DeliveryEntityProjection, DeliveryRelationship } from "../../src/domain/deliveryGraph.js"
import { GraphNodeId, ReleaseId, WorkspaceId } from "../../src/domain/identifiers.js"
import {
  deriveRelationshipInference,
  type RelationshipInferenceEntity
} from "../../src/server/application/relationshipInference.js"

const workspaceId = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000211")
const releaseId = ReleaseId.make("01890f6f-6d6a-7cc0-98d2-000000000212")
const otherReleaseId = ReleaseId.make("01890f6f-6d6a-7cc0-98d2-000000000213")
const nodeId = (suffix: string) => GraphNodeId.make(`01890f6f-6d6a-7cc0-98d2-${suffix.padStart(12, "0")}`)

const entity = (
  index: number,
  projection: Readonly<Record<string, unknown>>,
  releaseIds: ReadonlyArray<ReleaseId> = []
): RelationshipInferenceEntity => ({
  nodeId: nodeId(String(100 + index)),
  projection: Schema.decodeUnknownSync(DeliveryEntityProjection)({
    ...projection,
    entityId: `01890f6f-6d6a-7cc0-98d2-${String(200 + index).padStart(12, "0")}`,
    workspaceId
  }),
  releaseIds
})

const common = {
  projectionRevision: 1,
  sourceEntityRevision: 1,
  supersedesProjectionRevision: null,
  projectionSchemaVersion: 1,
  entityState: "present"
}

describe("relationship inference", () => {
  it("builds one release journey while keeping missing and inferred links distinct", () => {
    const issue = entity(
      1,
      {
        ...common,
        entityType: "issue",
        displayKey: "PAY-42",
        title: "PAY-42 · Guard refunds",
        details: { _tag: "issue", key: "PAY-42", status: "Ready", priority: "High", estimatePoints: 3 }
      },
      [releaseId]
    )
    const issueWithoutPr = entity(
      2,
      {
        ...common,
        entityType: "issue",
        displayKey: "PAY-43",
        title: "PAY-43 · Bound retries",
        details: { _tag: "issue", key: "PAY-43", status: "Ready", priority: null, estimatePoints: 2 }
      },
      [releaseId]
    )
    const pullRequest = entity(3, {
      ...common,
      entityType: "pull-request",
      displayKey: "17",
      title: "PAY-42 guard refund writes",
      details: {
        _tag: "pull-request",
        repository: "payments-api",
        sourceBranch: "feat/PAY-42-refund-guard",
        targetBranch: "main",
        headRevision: "abc123",
        reviewState: "requested"
      }
    })
    const pipeline = entity(4, {
      ...common,
      entityType: "pipeline-execution",
      displayKey: "payments/9001",
      title: "Payments deploy",
      details: {
        _tag: "pipeline-execution",
        pipelineName: "payments",
        executionId: "9001",
        status: "running",
        triggerRevision: "abc123"
      }
    })
    const runbook = entity(5, {
      ...common,
      entityType: "page",
      displayKey: "PAY/991",
      title: "Payments 2026.29 runbook",
      details: {
        _tag: "page",
        spaceKey: "PAY",
        revision: "8",
        status: "current",
        linkedIssueKeys: ["PAY-42"],
        linkedReleaseVersions: ["2026.29"]
      }
    })
    const timeEntry = entity(6, {
      ...common,
      entityType: "time-entry",
      displayKey: "time-1",
      title: "PAY-42 review and rollout",
      details: { _tag: "time-entry", durationMinutes: 45, billable: true, approvalState: "approved" }
    })

    const result = deriveRelationshipInference({
      entities: [issue, issueWithoutPr, pullRequest, pipeline, runbook, timeEntry],
      releases: [{ nodeId: nodeId("9"), releaseId, version: "2026.29" }],
      relationships: []
    })

    assert.sameMembers(
      result.candidates.map(({ kind, lifecycle }) => `${kind}:${lifecycle}`),
      [
        "implements:inferred",
        "implements:missing",
        "delivered-by:inferred",
        "documented-by:inferred",
        "documented-by:inferred",
        "tracks-time-for:inferred"
      ]
    )
    assert.isTrue(
      result.candidates.every(
        (candidate) =>
          candidate.lifecycle !== "inferred" || (candidate.confidence !== null && candidate.evidenceEntityId !== null)
      )
    )
    const gap = result.candidates.find(({ lifecycle }) => lifecycle === "missing")
    assert.strictEqual(gap?.source._tag, "missing")
    if (gap?.source._tag === "missing") assert.strictEqual(gap.source.missingKey, "PAY-43:pull-request")
    assert.isTrue(result.obsoleteGapIdentityKeys.some((key) => key.includes(issue.nodeId)))
  })

  it("requires token boundaries and exact immutable revisions", () => {
    const issue = entity(
      11,
      {
        ...common,
        entityType: "issue",
        displayKey: "PAY-42",
        title: "PAY-42 · Guard refunds",
        details: { _tag: "issue", key: "PAY-42", status: "Ready", priority: null, estimatePoints: null }
      },
      [releaseId]
    )
    const pullRequest = entity(
      12,
      {
        ...common,
        entityType: "pull-request",
        displayKey: "18",
        title: "Do not match XPAY-420",
        details: {
          _tag: "pull-request",
          repository: "payments-api",
          sourceBranch: "feat/XPAY-420",
          targetBranch: "main",
          headRevision: "ABC123",
          reviewState: "requested"
        }
      },
      [releaseId]
    )
    const pipeline = entity(13, {
      ...common,
      entityType: "pipeline-execution",
      displayKey: "payments/9002",
      title: "Payments deploy",
      details: {
        _tag: "pipeline-execution",
        pipelineName: "payments",
        executionId: "9002",
        status: "running",
        triggerRevision: "abc123"
      }
    })

    const result = deriveRelationshipInference({
      entities: [issue, pullRequest, pipeline],
      releases: [],
      relationships: []
    })
    assert.isFalse(result.candidates.some(({ lifecycle }) => lifecycle === "inferred"))
    assert.sameMembers(
      result.candidates.map(({ kind }) => kind),
      ["implements", "delivered-by"]
    )
    assert.isTrue(result.candidates.every(({ lifecycle }) => lifecycle === "missing"))
  })

  it("keeps governed and verified repairs authoritative over missing gaps", () => {
    const issue = entity(
      14,
      {
        ...common,
        entityType: "issue",
        displayKey: "PAY-42",
        title: "PAY-42 · Guard refunds",
        details: { _tag: "issue", key: "PAY-42", status: "Ready", priority: null, estimatePoints: null }
      },
      [releaseId]
    )
    const pullRequest = entity(15, {
      ...common,
      entityType: "pull-request",
      displayKey: "18",
      title: "Guard refund writes",
      details: {
        _tag: "pull-request",
        repository: "payments-api",
        sourceBranch: "feat/refund-guard",
        targetBranch: "main",
        headRevision: "abc123",
        reviewState: "requested"
      }
    })
    const pipeline = entity(16, {
      ...common,
      entityType: "pipeline-execution",
      displayKey: "payments/9002",
      title: "Payments deploy",
      details: {
        _tag: "pipeline-execution",
        pipelineName: "payments",
        executionId: "9002",
        status: "running",
        triggerRevision: "different-revision"
      }
    })
    const relationship = (
      index: number,
      kind: "implements" | "verified-by",
      source: RelationshipInferenceEntity,
      target: RelationshipInferenceEntity,
      lifecycle: "governed" | "verified"
    ) =>
      Schema.decodeUnknownSync(DeliveryRelationship)({
        workspaceId,
        relationshipId: `01890f6f-6d6a-7cc0-98d2-${String(500 + index).padStart(12, "0")}`,
        relationshipSchemaVersion: 1,
        revision: 1,
        supersedesRevision: null,
        kind,
        sourceNodeId: source.nodeId,
        sourceNodeKind: source.projection.entityType,
        targetNodeId: target.nodeId,
        targetNodeKind: target.projection.entityType,
        scope: { _tag: "release", releaseId },
        lifecycle: { _tag: lifecycle, effectiveAt: "2026-07-19T09:03:00.000Z" },
        confidence: { _tag: "inferred", score: 1, rationale: "Approved repair." },
        provenance: {
          _tag: "rule",
          ruleId: "approved-repair-fixture",
          ruleVersion: 1,
          rationale: "Approved repair."
        },
        recordedBy: { _tag: "system", component: "relationship-inference-test" },
        evidenceClaimIds: [],
        recordedAt: "2026-07-19T09:03:00.000Z"
      })

    const result = deriveRelationshipInference({
      entities: [issue, pullRequest, pipeline],
      releases: [],
      relationships: [
        relationship(1, "implements", pullRequest, issue, "governed"),
        relationship(2, "verified-by", pullRequest, pipeline, "verified")
      ]
    })

    assert.isFalse(result.candidates.some(({ lifecycle }) => lifecycle === "missing"))
  })

  it("does not propagate a rejected implementation into pipeline delivery", () => {
    const issue = entity(
      17,
      {
        ...common,
        entityType: "issue",
        displayKey: "PAY-42",
        title: "PAY-42 · Guard refunds",
        details: { _tag: "issue", key: "PAY-42", status: "Ready", priority: null, estimatePoints: null }
      },
      [releaseId]
    )
    const pullRequest = entity(18, {
      ...common,
      entityType: "pull-request",
      displayKey: "18",
      title: "PAY-42 guard refund writes",
      details: {
        _tag: "pull-request",
        repository: "payments-api",
        sourceBranch: "feat/PAY-42-refund-guard",
        targetBranch: "main",
        headRevision: "abc123",
        reviewState: "requested"
      }
    })
    const pipeline = entity(19, {
      ...common,
      entityType: "pipeline-execution",
      displayKey: "payments/9003",
      title: "Payments deploy",
      details: {
        _tag: "pipeline-execution",
        pipelineName: "payments",
        executionId: "9003",
        status: "running",
        triggerRevision: "abc123"
      }
    })
    const input = { entities: [issue, pullRequest, pipeline], releases: [], relationships: [] }
    const accepted = deriveRelationshipInference(input)
    const implementation = accepted.candidates.find(
      ({ kind, lifecycle }) => kind === "implements" && lifecycle === "inferred"
    )
    if (implementation === undefined) throw new Error("expected inferred implementation fixture")
    assert.isTrue(
      accepted.candidates.some(({ kind, lifecycle }) => kind === "delivered-by" && lifecycle === "inferred")
    )

    const rejected = deriveRelationshipInference({
      ...input,
      rejectedCandidateIdentityKeys: new Set([implementation.identityKey])
    })

    assert.isTrue(rejected.candidates.some(({ kind, lifecycle }) => kind === "implements" && lifecycle === "missing"))
    assert.isFalse(
      rejected.candidates.some(({ kind, lifecycle }) => kind === "delivered-by" && lifecycle === "inferred")
    )
  })

  it("matches exact current release documentation without using version prefixes or superseded pages", () => {
    const issue = entity(
      20,
      {
        ...common,
        entityType: "issue",
        displayKey: "PAY-42",
        title: "PAY-42 · Guard refunds",
        details: { _tag: "issue", key: "PAY-42", status: "Ready", priority: null, estimatePoints: null }
      },
      [releaseId]
    )
    const exact = entity(21, {
      ...common,
      entityType: "page",
      displayKey: "PAY/21",
      title: "Payments 2026.29 runbook",
      details: { _tag: "page", spaceKey: "PAY", revision: "1", status: "current" }
    })
    const patchVersion = entity(22, {
      ...common,
      entityType: "page",
      displayKey: "PAY/22",
      title: "Payments 2026.29.1 runbook",
      details: { _tag: "page", spaceKey: "PAY", revision: "1", status: "current" }
    })
    const superseded = entity(23, {
      ...common,
      entityType: "page",
      displayKey: "PAY/23",
      title: "Payments archive",
      details: {
        _tag: "page",
        spaceKey: "PAY",
        revision: "2",
        status: "superseded",
        linkedIssueKeys: ["PAY-42"],
        linkedReleaseVersions: ["2026.29"]
      }
    })

    const result = deriveRelationshipInference({
      entities: [issue, exact, patchVersion, superseded],
      releases: [{ nodeId: nodeId("29"), releaseId, version: "2026.29" }],
      relationships: []
    })

    const documentation = result.candidates.filter(({ kind }) => kind === "documented-by")
    assert.lengthOf(documentation, 1)
    assert.strictEqual(documentation[0]?.target._tag, "resolved")
    if (documentation[0]?.target._tag === "resolved") {
      assert.strictEqual(documentation[0].target.nodeId, exact.nodeId)
    }
  })

  it("does not infer release documentation from an ambiguous version-only match", () => {
    const runbook = entity(24, {
      ...common,
      entityType: "page",
      displayKey: "PAY/24",
      title: "Payments 2026.29 runbook",
      details: { _tag: "page", spaceKey: "PAY", revision: "1", status: "current" }
    })

    const result = deriveRelationshipInference({
      entities: [runbook],
      releases: [
        { nodeId: nodeId("29"), releaseId, version: "2026.29" },
        { nodeId: nodeId("30"), releaseId: otherReleaseId, version: "2026.29" }
      ],
      relationships: []
    })

    assert.isFalse(result.candidates.some(({ kind }) => kind === "documented-by"))
  })

  it("marks oversized candidate sets truncated so materialization can fail closed", () => {
    const issueKeys = Array.from({ length: 100 }, (_, index) => `PAY-${index + 1}`)
    const issues = issueKeys.map((key, index) =>
      entity(
        100 + index,
        {
          ...common,
          entityType: "issue",
          displayKey: key,
          title: `${key} · Delivery work`,
          details: { _tag: "issue", key, status: "Ready", priority: null, estimatePoints: null }
        },
        [releaseId]
      )
    )
    const pages = Array.from({ length: 21 }, (_, index) =>
      entity(300 + index, {
        ...common,
        entityType: "page",
        displayKey: `PAY/${index + 1}`,
        title: `Runbook ${index + 1}`,
        details: {
          _tag: "page",
          spaceKey: "PAY",
          revision: "1",
          status: "current",
          linkedIssueKeys: issueKeys
        }
      }))

    const result = deriveRelationshipInference({ entities: [...issues, ...pages], releases: [], relationships: [] })

    assert.isTrue(result.truncated)
    assert.lengthOf(result.candidates, 2_000)
  })
})
