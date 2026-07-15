import { assert, describe, it } from "@effect/vitest"
import { Result, Schema } from "effect"

import {
  DeliveryEntityProjection,
  DeliveryNode,
  DeliveryRelationship,
  EvidenceClaim,
  evidenceFreshnessAt,
  EvidenceItem,
  evidenceRetentionEligibilityAt
} from "../../src/domain/deliveryGraph.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"

const workspaceId = "01890f6f-6d6a-7cc0-98d2-000000000101"
const releaseId = "01890f6f-6d6a-7cc0-98d2-000000000102"
const issueId = "01890f6f-6d6a-7cc0-98d2-000000000103"
const pullRequestId = "01890f6f-6d6a-7cc0-98d2-000000000104"
const pluginConnectionId = "01890f6f-6d6a-7cc0-98d2-000000000105"
const otherPluginConnectionId = "01890f6f-6d6a-7cc0-98d2-00000000010e"
const relationshipId = "01890f6f-6d6a-7cc0-98d2-000000000106"
const evidenceClaimId = "01890f6f-6d6a-7cc0-98d2-000000000107"
const secondEvidenceClaimId = "01890f6f-6d6a-7cc0-98d2-000000000108"
const evidenceId = "01890f6f-6d6a-7cc0-98d2-000000000109"
const issueNodeId = "01890f6f-6d6a-7cc0-98d2-00000000010a"
const pullRequestNodeId = "01890f6f-6d6a-7cc0-98d2-00000000010b"
const pipelineNodeId = "01890f6f-6d6a-7cc0-98d2-00000000010c"
const releaseNodeId = "01890f6f-6d6a-7cc0-98d2-00000000010d"

const sourceRevision = {
  providerId: "jira",
  pluginConnectionId,
  vendorImmutableId: "PAY-42",
  revision: "42",
  sourceUrl: "https://example.atlassian.net/browse/PAY-42",
  firstObservedAt: "2026-07-15T08:00:00.000Z",
  lastObservedAt: "2026-07-15T08:00:00.000Z",
  synchronizedAt: "2026-07-15T08:00:30.000Z",
  normalizationSchemaVersion: 1
}

const currentFreshness = {
  _tag: "current",
  pluginHealth: { _tag: "healthy", checkedAt: "2026-07-15T08:01:00.000Z" },
  provenance: { _tag: "provider", sourceRevision },
  sourceObservedAt: sourceRevision.lastObservedAt,
  staleAfterSeconds: 1_800,
  synchronizedAt: "2026-07-15T08:00:30.000Z"
}

const decodeProjection = Schema.decodeUnknownResult(DeliveryEntityProjection)
const decodeNode = Schema.decodeUnknownResult(DeliveryNode)
const decodeRelationship = Schema.decodeUnknownResult(DeliveryRelationship)
const decodeEvidence = Schema.decodeUnknownResult(EvidenceClaim)
const decodeEvidenceItem = Schema.decodeUnknownResult(EvidenceItem)

describe("delivery graph domain", () => {
  it("keeps native details in a closed union matching the canonical entity kind", () => {
    const issue = decodeProjection({
      workspaceId,
      entityId: issueId,
      projectionRevision: 1,
      sourceEntityRevision: 1,
      supersedesProjectionRevision: null,
      projectionSchemaVersion: 1,
      entityState: "present",
      entityType: "issue",
      displayKey: "PAY-42",
      title: "Rotate settlement credentials",
      details: {
        _tag: "issue",
        key: "PAY-42",
        status: "In review",
        priority: "High",
        estimatePoints: 3
      }
    })
    assert.isTrue(Result.isSuccess(issue))

    const mismatched = decodeProjection({
      workspaceId,
      entityId: issueId,
      projectionRevision: 1,
      sourceEntityRevision: 1,
      supersedesProjectionRevision: null,
      projectionSchemaVersion: 1,
      entityState: "present",
      entityType: "issue",
      displayKey: "PAY-42",
      title: "Rotate settlement credentials",
      details: {
        _tag: "pull-request",
        repository: "payments",
        sourceBranch: "pay-42",
        targetBranch: "main",
        headRevision: "abc123",
        reviewState: "requested"
      }
    })
    assert.isTrue(Result.isFailure(mismatched))
  })

  it("binds immutable node endpoint kinds to resolved and missing target semantics", () => {
    const resolvedPullRequest = decodeNode({
      workspaceId,
      nodeId: pullRequestNodeId,
      endpointKind: "pull-request",
      resolution: {
        _tag: "resolved",
        target: { _tag: "entity", entityId: pullRequestId, entityKind: "pull-request" }
      },
      createdAt: "2026-07-15T08:00:00.000Z"
    })
    assert.isTrue(Result.isSuccess(resolvedPullRequest))

    const lyingResolvedKind = decodeNode({
      workspaceId,
      nodeId: pullRequestNodeId,
      endpointKind: "issue",
      resolution: {
        _tag: "resolved",
        target: { _tag: "entity", entityId: pullRequestId, entityKind: "pull-request" }
      },
      createdAt: "2026-07-15T08:00:00.000Z"
    })
    assert.isTrue(Result.isFailure(lyingResolvedKind))

    const missingIssue = decodeNode({
      workspaceId,
      nodeId: issueNodeId,
      endpointKind: "issue",
      resolution: {
        _tag: "missing",
        expectedKind: "entity",
        expectedEntityKind: "issue",
        missingKey: "PAY-404"
      },
      createdAt: "2026-07-15T08:00:00.000Z"
    })
    assert.isTrue(Result.isSuccess(missingIssue))

    const lyingMissingKind = decodeNode({
      workspaceId,
      nodeId: issueNodeId,
      endpointKind: "pull-request",
      resolution: {
        _tag: "missing",
        expectedKind: "entity",
        expectedEntityKind: "issue",
        missingKey: "PAY-404"
      },
      createdAt: "2026-07-15T08:00:00.000Z"
    })
    assert.isTrue(Result.isFailure(lyingMissingKind))
  })

  it("preserves directional many-to-many relationships and unique evidence", () => {
    const relationship = decodeRelationship({
      workspaceId,
      relationshipId,
      relationshipSchemaVersion: 1,
      revision: 1,
      supersedesRevision: null,
      kind: "implements",
      sourceNodeId: pullRequestNodeId,
      sourceNodeKind: "pull-request",
      targetNodeId: issueNodeId,
      targetNodeKind: "issue",
      scope: { _tag: "release", releaseId },
      lifecycle: { _tag: "verified", effectiveAt: "2026-07-15T08:00:00.000Z" },
      confidence: { _tag: "confirmed" },
      provenance: {
        _tag: "plugin",
        pluginConnectionId,
        sourceEntityId: issueId,
        sourceEntityRevision: 1
      },
      recordedBy: { _tag: "system", component: "jira-normalizer/v1" },
      evidenceClaimIds: [evidenceClaimId],
      recordedAt: "2026-07-15T08:01:00.000Z"
    })
    assert.isTrue(Result.isSuccess(relationship))
    if (Result.isFailure(relationship)) return

    const encodedRelationship = Schema.encodeSync(DeliveryRelationship)(relationship.success)

    const duplicateEvidence = decodeRelationship({
      ...encodedRelationship,
      evidenceClaimIds: [evidenceClaimId, evidenceClaimId]
    })
    assert.isTrue(Result.isFailure(duplicateEvidence))

    const selfLink = decodeRelationship({
      ...encodedRelationship,
      targetNodeId: pullRequestNodeId
    })
    assert.isTrue(Result.isFailure(selfLink))

    const inverted = decodeRelationship({
      ...encodedRelationship,
      sourceNodeKind: "issue",
      targetNodeKind: "pull-request"
    })
    assert.isTrue(Result.isFailure(inverted))

    const deliveredByPipeline = decodeRelationship({
      ...encodedRelationship,
      kind: "delivered-by",
      targetNodeId: pipelineNodeId,
      targetNodeKind: "pipeline-execution"
    })
    assert.isTrue(Result.isSuccess(deliveredByPipeline))

    const deliveredByIssue = decodeRelationship({
      ...encodedRelationship,
      kind: "delivered-by"
    })
    assert.isTrue(Result.isFailure(deliveredByIssue))

    const genericDependency = decodeRelationship({
      ...encodedRelationship,
      kind: "depends-on",
      sourceNodeKind: "environment",
      targetNodeKind: "time-entry"
    })
    assert.isTrue(Result.isSuccess(genericDependency))

    const containedIssue = decodeRelationship({
      ...encodedRelationship,
      kind: "contains",
      sourceNodeId: releaseNodeId,
      sourceNodeKind: "release"
    })
    assert.isTrue(Result.isSuccess(containedIssue))

    const invertedContainment = decodeRelationship({
      ...encodedRelationship,
      kind: "contains",
      sourceNodeKind: "issue",
      targetNodeKind: "release"
    })
    assert.isTrue(Result.isFailure(invertedContainment))

    const unscopedContainment = decodeRelationship({
      ...encodedRelationship,
      kind: "contains",
      sourceNodeId: releaseNodeId,
      sourceNodeKind: "release",
      scope: null
    })
    assert.isTrue(Result.isFailure(unscopedContainment))

    const contextualDependency = decodeRelationship({
      ...encodedRelationship,
      kind: "depends-on",
      scope: null
    })
    assert.isTrue(Result.isSuccess(contextualDependency))

    const futureSemantics = decodeRelationship({
      ...encodedRelationship,
      relationshipSchemaVersion: 2
    })
    assert.isTrue(Result.isFailure(futureSemantics))
  })

  it("does not let inferred lifecycle state masquerade as confirmed confidence", () => {
    const relationship = {
      workspaceId,
      relationshipId,
      relationshipSchemaVersion: 1,
      revision: 1,
      supersedesRevision: null,
      kind: "implements",
      sourceNodeId: pullRequestNodeId,
      sourceNodeKind: "pull-request",
      targetNodeId: issueNodeId,
      targetNodeKind: "issue",
      scope: { _tag: "release", releaseId },
      lifecycle: { _tag: "inferred", effectiveAt: "2026-07-15T08:00:00.000Z" },
      confidence: { _tag: "confirmed" },
      provenance: {
        _tag: "rule",
        ruleId: "branch-ticket-key",
        ruleVersion: 1,
        rationale: "The branch contains a Jira key"
      },
      recordedBy: { _tag: "system", component: "relationship-normalizer/v1" },
      evidenceClaimIds: [evidenceClaimId],
      recordedAt: "2026-07-15T08:01:00.000Z"
    }

    assert.isTrue(Result.isFailure(decodeRelationship(relationship)))
    assert.isTrue(Result.isSuccess(decodeRelationship({
      ...relationship,
      confidence: {
        _tag: "inferred",
        score: 0.8,
        rationale: "The branch contains the exact Jira key"
      }
    })))
  })

  it("requires immutable evidence before relationship confidence is confirmed", () => {
    const confirmedRelationship = {
      workspaceId,
      relationshipId,
      relationshipSchemaVersion: 1,
      revision: 1,
      supersedesRevision: null,
      kind: "implements",
      sourceNodeId: pullRequestNodeId,
      sourceNodeKind: "pull-request",
      targetNodeId: issueNodeId,
      targetNodeKind: "issue",
      scope: { _tag: "release", releaseId },
      lifecycle: { _tag: "verified", effectiveAt: "2026-07-15T08:00:00.000Z" },
      confidence: { _tag: "confirmed" },
      provenance: {
        _tag: "plugin",
        pluginConnectionId,
        sourceEntityId: issueId,
        sourceEntityRevision: 1
      },
      recordedBy: { _tag: "system", component: "relationship-normalizer/v1" },
      evidenceClaimIds: [evidenceClaimId],
      recordedAt: "2026-07-15T08:01:00.000Z"
    }

    assert.isTrue(Result.isSuccess(decodeRelationship(confirmedRelationship)))
    assert.isTrue(Result.isFailure(decodeRelationship({
      ...confirmedRelationship,
      evidenceClaimIds: []
    })))
  })

  it("supersedes evidence without overwriting it and evaluates freshness at an injected instant", () => {
    const item = decodeEvidenceItem({
      workspaceId,
      evidenceId,
      schemaVersion: 1,
      attribution: {
        _tag: "plugin",
        pluginConnectionId,
        sourceEntityId: issueId,
        sourceEntityRevision: 1
      },
      verifier: { _tag: "system", component: "plugin-sync/v1" },
      observedAt: "2026-07-15T08:00:00.000Z",
      recordedAt: "2026-07-15T08:01:00.000Z",
      validUntil: "2026-07-15T09:00:00.000Z",
      freshness: currentFreshness,
      retention: {
        classification: "evidence",
        retainUntil: "2026-08-15T08:00:00.000Z",
        legalHold: false
      }
    })
    assert.isTrue(Result.isSuccess(item))
    if (Result.isFailure(item)) return

    const mismatchedFreshnessConnection = decodeEvidenceItem({
      ...Schema.encodeSync(EvidenceItem)(item.success),
      attribution: {
        _tag: "plugin",
        pluginConnectionId: otherPluginConnectionId,
        sourceEntityId: issueId,
        sourceEntityRevision: 1
      }
    })
    assert.isTrue(Result.isFailure(mismatchedFreshnessConnection))

    const first = decodeEvidence({
      workspaceId,
      evidenceClaimId,
      evidenceId,
      subjectNodeId: issueNodeId,
      predicate: "status-observed",
      value: { _tag: "state", value: "verify-running" },
      recordedAt: "2026-07-15T08:01:00.000Z",
      supersedesEvidenceClaimId: null
    })
    assert.isTrue(Result.isSuccess(first))
    if (Result.isFailure(first)) return

    const second = decodeEvidence({
      ...Schema.encodeSync(EvidenceClaim)(first.success),
      evidenceClaimId: secondEvidenceClaimId,
      value: { _tag: "state", value: "verify-succeeded" },
      recordedAt: "2026-07-15T08:31:00.000Z",
      supersedesEvidenceClaimId: evidenceClaimId
    })
    assert.isTrue(Result.isSuccess(second))
    assert.deepStrictEqual(
      evidenceFreshnessAt(
        item.success,
        Schema.decodeSync(UtcTimestamp)("2026-07-15T08:29:59.999Z")
      ),
      { source: "current", validity: "valid" }
    )
    assert.deepStrictEqual(
      evidenceFreshnessAt(
        item.success,
        Schema.decodeSync(UtcTimestamp)("2026-07-15T08:30:00.000Z")
      ),
      { source: "stale", validity: "valid" }
    )
    assert.deepStrictEqual(
      evidenceFreshnessAt(
        item.success,
        Schema.decodeSync(UtcTimestamp)("2026-07-15T09:00:00.000Z")
      ),
      { source: "stale", validity: "expired" }
    )
    assert.strictEqual(
      evidenceRetentionEligibilityAt(
        item.success,
        Schema.decodeSync(UtcTimestamp)("2026-08-15T08:00:00.000Z")
      ),
      "eligible"
    )
  })

  it("distinguishes missing evidence from an unavailable plugin connection", () => {
    const missing = decodeEvidenceItem({
      workspaceId,
      evidenceId,
      schemaVersion: 1,
      attribution: { _tag: "system", component: "jira-normalizer/v1" },
      verifier: { _tag: "system", component: "plugin-sync/v1" },
      observedAt: "2026-07-15T08:00:00.000Z",
      recordedAt: "2026-07-15T08:01:00.000Z",
      validUntil: null,
      freshness: {
        _tag: "missing",
        pluginHealth: { _tag: "healthy", checkedAt: "2026-07-15T08:01:00.000Z" },
        provenance: { _tag: "none", pluginConnectionId },
        sourceObservedAt: null,
        staleAfterSeconds: 1_800,
        synchronizedAt: "2026-07-15T08:00:30.000Z"
      },
      retention: { classification: "evidence", retainUntil: null, legalHold: false }
    })
    const unavailable = decodeEvidenceItem({
      workspaceId,
      evidenceId,
      schemaVersion: 1,
      attribution: { _tag: "system", component: "jira-normalizer/v1" },
      verifier: { _tag: "system", component: "plugin-sync/v1" },
      observedAt: "2026-07-15T08:00:00.000Z",
      recordedAt: "2026-07-15T08:01:00.000Z",
      validUntil: null,
      freshness: {
        _tag: "unavailable",
        pluginHealth: {
          _tag: "unavailable",
          checkedAt: "2026-07-15T08:01:00.000Z",
          failureClass: "outage",
          retryAt: "2026-07-15T08:06:00.000Z",
          safeMessage: "Jira is temporarily unavailable"
        },
        provenance: { _tag: "none", pluginConnectionId },
        sourceObservedAt: null,
        staleAfterSeconds: 1_800,
        synchronizedAt: null
      },
      retention: { classification: "evidence", retainUntil: null, legalHold: false }
    })

    assert.isTrue(Result.isSuccess(missing))
    assert.isTrue(Result.isSuccess(unavailable))
    if (Result.isFailure(missing) || Result.isFailure(unavailable)) return

    const at = Schema.decodeSync(UtcTimestamp)("2026-07-15T08:02:00.000Z")
    assert.deepStrictEqual(evidenceFreshnessAt(missing.success, at), {
      source: "missing",
      validity: "valid"
    })
    assert.deepStrictEqual(evidenceFreshnessAt(unavailable.success, at), {
      source: "unavailable",
      validity: "valid"
    })
  })

  it("rejects inverted observation, validity, and retention bounds", () => {
    const invalid = decodeEvidenceItem({
      workspaceId,
      evidenceId,
      schemaVersion: 1,
      attribution: { _tag: "system", component: "readiness/v1" },
      verifier: { _tag: "system", component: "readiness/v1" },
      observedAt: "2026-07-15T10:00:00.000Z",
      recordedAt: "2026-07-15T09:59:00.000Z",
      validUntil: "2026-07-15T09:00:00.000Z",
      freshness: currentFreshness,
      retention: {
        classification: "audit",
        retainUntil: "2026-07-14T10:00:00.000Z",
        legalHold: false
      }
    })
    assert.isTrue(Result.isFailure(invalid))
  })
})
