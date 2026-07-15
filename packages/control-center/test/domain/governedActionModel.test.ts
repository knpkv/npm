import { assert, describe, it } from "@effect/vitest"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import {
  GovernedActionAttemptV1,
  governedActionAuthorityMismatches,
  GovernedActionAuthorizationV1,
  GovernedActionEnvelopeMaterialV1,
  GovernedActionEnvelopeV1,
  GovernedActionEvidenceReference
} from "../../src/domain/governedAction/index.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"

const observedAt = "2026-07-15T10:00:00.000Z"
const actionId = "01890f00-0000-7000-8000-000000000301"
const workspaceId = "01890f00-0000-7000-8000-000000000302"
const pluginConnectionId = "01890f00-0000-7000-8000-000000000303"
const payloadDigest = "a".repeat(64)
const actionEnvelopeDigest = `sha256:${"b".repeat(64)}`
const evidenceSetDigest = `sha256:${"c".repeat(64)}`
const policyDigest = `sha256:${"d".repeat(64)}`
const pluginConnectionAuthorityDigest = `sha256:${"e".repeat(64)}`
const policyEvaluationDigest = `sha256:${"f".repeat(64)}`
const idempotencyKey = "governed-action:PAY-42:done:7"

const evidenceRaw = (evidenceId: string) => ({
  workspaceId,
  evidenceId,
  evidenceClaimIds: [],
  observedAt: "2026-07-15T09:55:00.000Z",
  validUntil: "2026-07-15T11:00:00.000Z",
  currentUntil: "2026-07-15T10:30:00.000Z",
  evaluatedAt: observedAt,
  source: "current",
  validity: "valid"
})

const envelopeRaw = {
  schemaVersion: 1,
  actionId,
  idempotencyKey,
  workspaceId,
  pluginConnectionId,
  pluginConnectionRevision: 7,
  pluginConnectionAuthorityDigest,
  pluginId: "dev.knpkv.jira",
  pluginContractVersion: { major: 1, minor: 0, patch: 0 },
  pluginAdapterVersion: { major: 1, minor: 2, patch: 3 },
  providerId: "jira",
  capability: { capabilityId: "action.execute", version: 1 },
  targetEntityId: "01890f00-0000-7000-8000-000000000304",
  proposal: {
    proposalKey: "transition:PAY-42:done",
    capabilityVersion: 1,
    request: {
      actionKind: "transition",
      target: { entityType: "issue", vendorImmutableId: "PAY-42" },
      expectedRevision: "7",
      payload: { status: "Done" },
      evidenceIds: ["provider-evidence-1"]
    },
    payloadDigest,
    summary: "Move PAY-42 to Done",
    impact: { level: "medium", summary: "Changes the issue workflow state" },
    proposedAt: observedAt
  },
  evidence: [evidenceRaw("01890f00-0000-7000-8000-000000000305")],
  evidenceSetDigest,
  policy: {
    policyId: "jira.transition",
    policyVersion: 1,
    policyDigest,
    requiredPermission: "issue-owner"
  },
  origin: {
    _tag: "agent",
    actor: { _tag: "agent", agentId: "01890f00-0000-7000-8000-000000000306" },
    jobId: "01890f00-0000-7000-8000-000000000307",
    initiatingSessionId: "01890f00-0000-7000-8000-000000000308"
  },
  proposalExpiresAt: "2026-07-15T10:10:00.000Z",
  causationId: null,
  correlationId: "action:model-1"
}

const authorizationRaw = {
  schemaVersion: 1,
  authorizationId: "01890f00-0000-7000-8000-000000000309",
  actionId,
  workspaceId,
  pluginConnectionId,
  pluginConnectionRevision: 7,
  pluginConnectionAuthorityDigest,
  actionEnvelopeDigest,
  idempotencyKey,
  payloadDigest,
  evidenceSetDigest,
  policyDigest,
  expectedRevision: "7",
  capabilityVersion: 1,
  actor: { _tag: "human", personId: "01890f00-0000-7000-8000-000000000310" },
  sessionId: "01890f00-0000-7000-8000-000000000311",
  sessionPermission: "workspace-owner",
  sessionExpiresAt: "2026-07-15T10:30:00.000Z",
  requiredPermission: "issue-owner",
  authorizedAt: observedAt,
  expiresAt: "2026-07-15T10:05:00.000Z"
}

describe("governed action immutable model", () => {
  it("allows agent proposals but makes human authorization structural", () => {
    assert.isTrue(Result.isSuccess(Schema.decodeUnknownResult(GovernedActionEnvelopeMaterialV1)(envelopeRaw)))
    assert.isTrue(Result.isSuccess(Schema.decodeUnknownResult(GovernedActionAuthorizationV1)(authorizationRaw)))
    assert.isTrue(
      Result.isFailure(
        Schema.decodeUnknownResult(GovernedActionAuthorizationV1)({
          ...authorizationRaw,
          actor: { _tag: "agent", agentId: "01890f00-0000-7000-8000-000000000306" }
        })
      )
    )
  })

  it("rejects capability-version drift and non-expiring proposal authority", () => {
    const { idempotencyKey: omittedIdempotencyKey, ...withoutIdempotencyKey } = envelopeRaw
    assert.strictEqual(omittedIdempotencyKey, idempotencyKey)
    assert.isTrue(
      Result.isFailure(Schema.decodeUnknownResult(GovernedActionEnvelopeMaterialV1)(withoutIdempotencyKey))
    )
    assert.isTrue(
      Result.isFailure(
        Schema.decodeUnknownResult(GovernedActionEnvelopeMaterialV1)({
          ...envelopeRaw,
          capability: { capabilityId: "action.execute", version: 2 }
        })
      )
    )
    assert.isTrue(
      Result.isFailure(
        Schema.decodeUnknownResult(GovernedActionEnvelopeMaterialV1)({
          ...envelopeRaw,
          proposalExpiresAt: observedAt
        })
      )
    )
  })

  it("requires canonical evidence and claim ordering", () => {
    const firstEvidenceId = "01890f00-0000-7000-8000-000000000312"
    const secondEvidenceId = "01890f00-0000-7000-8000-000000000313"
    const firstClaimId = "01890f00-0000-7000-8000-000000000314"
    const secondClaimId = "01890f00-0000-7000-8000-000000000315"

    assert.isTrue(
      Result.isFailure(
        Schema.decodeUnknownResult(GovernedActionEnvelopeMaterialV1)({
          ...envelopeRaw,
          evidence: [evidenceRaw(secondEvidenceId), evidenceRaw(firstEvidenceId)]
        })
      )
    )
    assert.isTrue(
      Result.isFailure(
        Schema.decodeUnknownResult(GovernedActionEvidenceReference)({
          ...evidenceRaw(firstEvidenceId),
          evidenceClaimIds: [secondClaimId, firstClaimId]
        })
      )
    )
  })

  it("rejects evidence from another workspace", () => {
    assert.isTrue(
      Result.isFailure(
        Schema.decodeUnknownResult(GovernedActionEnvelopeMaterialV1)({
          ...envelopeRaw,
          evidence: [{
            ...evidenceRaw("01890f00-0000-7000-8000-000000000312"),
            workspaceId: "01890f00-0000-7000-8000-000000000399"
          }]
        })
      )
    )
  })

  it("binds dispatch intent to the exact ready revision and chronology", () => {
    const attempt = {
      schemaVersion: 1,
      attemptId: "01890f00-0000-7000-8000-000000000316",
      authorizationId: authorizationRaw.authorizationId,
      actionId,
      workspaceId,
      pluginConnectionId,
      idempotencyKey,
      attemptNumber: 1,
      actionEnvelopeDigest,
      expectedRevision: "7",
      policyEvaluationDigest,
      preflight: { _tag: "ready", checkedRevision: "7", checkedAt: observedAt },
      startedAt: "2026-07-15T10:00:01.000Z"
    }

    assert.isTrue(Result.isSuccess(Schema.decodeUnknownResult(GovernedActionAttemptV1)(attempt)))
    assert.isTrue(
      Result.isFailure(
        Schema.decodeUnknownResult(GovernedActionAttemptV1)({
          ...attempt,
          preflight: { ...attempt.preflight, checkedRevision: "8" }
        })
      )
    )
    assert.isTrue(
      Result.isFailure(
        Schema.decodeUnknownResult(GovernedActionAttemptV1)({
          ...attempt,
          startedAt: "2026-07-15T09:59:59.000Z"
        })
      )
    )
    assert.isTrue(
      Result.isFailure(
        Schema.decodeUnknownResult(GovernedActionAttemptV1)({
          ...attempt,
          attemptNumber: 2
        })
      )
    )
  })

  it("rejects zero-duration human authorization", () => {
    assert.isTrue(
      Result.isFailure(
        Schema.decodeUnknownResult(GovernedActionAuthorizationV1)({
          ...authorizationRaw,
          expiresAt: observedAt
        })
      )
    )
  })

  it("derives evidence validity from the exact evaluation boundary", () => {
    const expiredAtEvaluation = {
      ...evidenceRaw("01890f00-0000-7000-8000-000000000317"),
      validUntil: "2026-07-15T09:59:00.000Z"
    }

    assert.isTrue(
      Result.isFailure(
        Schema.decodeUnknownResult(GovernedActionEvidenceReference)({
          ...expiredAtEvaluation,
          validity: "valid"
        })
      )
    )
    assert.isTrue(
      Result.isSuccess(
        Schema.decodeUnknownResult(GovernedActionEvidenceReference)({
          ...expiredAtEvaluation,
          validity: "expired"
        })
      )
    )
  })

  it("reports every cross-aggregate and expired dispatch authority mismatch", () => {
    const envelope = Schema.decodeUnknownSync(GovernedActionEnvelopeV1)({
      ...envelopeRaw,
      envelopeDigest: actionEnvelopeDigest
    })
    const authorization = Schema.decodeUnknownSync(GovernedActionAuthorizationV1)(authorizationRaw)
    const attempt = Schema.decodeUnknownSync(GovernedActionAttemptV1)({
      schemaVersion: 1,
      attemptId: "01890f00-0000-7000-8000-000000000318",
      authorizationId: authorizationRaw.authorizationId,
      actionId,
      workspaceId,
      pluginConnectionId,
      idempotencyKey,
      attemptNumber: 1,
      actionEnvelopeDigest,
      expectedRevision: "7",
      policyEvaluationDigest,
      preflight: { _tag: "ready", checkedRevision: "7", checkedAt: "2026-07-15T10:01:00.000Z" },
      startedAt: "2026-07-15T10:01:01.000Z"
    })
    const evaluatedAt = Schema.decodeUnknownSync(UtcTimestamp)("2026-07-15T10:01:01.000Z")

    assert.deepStrictEqual(
      governedActionAuthorityMismatches({ attempt, authorization, envelope, evaluatedAt }),
      []
    )

    const crossWorkspaceAuthorization = Schema.decodeUnknownSync(GovernedActionAuthorizationV1)({
      ...authorizationRaw,
      workspaceId: "01890f00-0000-7000-8000-000000000319"
    })
    const staleAttempt = Schema.decodeUnknownSync(GovernedActionAttemptV1)({
      ...Schema.encodeSync(GovernedActionAttemptV1)(attempt),
      authorizationId: "01890f00-0000-7000-8000-000000000320",
      startedAt: "2026-07-15T10:06:00.000Z"
    })
    const expiredAt = Schema.decodeUnknownSync(UtcTimestamp)("2026-07-15T10:06:00.000Z")
    const mismatches = governedActionAuthorityMismatches({
      attempt: staleAttempt,
      authorization: crossWorkspaceAuthorization,
      envelope,
      evaluatedAt: expiredAt
    })

    assert.include(mismatches, "authorization-workspace-mismatch")
    assert.include(mismatches, "authorization-expired")
    assert.include(mismatches, "attempt-authorization-mismatch")
    assert.include(mismatches, "attempt-outside-authorization-window")
  })

  it("fails closed for insufficient permission and evidence stale at dispatch", () => {
    const envelope = Schema.decodeUnknownSync(GovernedActionEnvelopeV1)({
      ...envelopeRaw,
      evidence: [{ ...evidenceRaw("01890f00-0000-7000-8000-000000000305"), currentUntil: "2026-07-15T10:01:00.000Z" }],
      envelopeDigest: actionEnvelopeDigest
    })
    const authorization = Schema.decodeUnknownSync(GovernedActionAuthorizationV1)({
      ...authorizationRaw,
      sessionPermission: "watcher"
    })
    const attempt = Schema.decodeUnknownSync(GovernedActionAttemptV1)({
      schemaVersion: 1,
      attemptId: "01890f00-0000-7000-8000-000000000321",
      authorizationId: authorizationRaw.authorizationId,
      actionId,
      workspaceId,
      pluginConnectionId,
      idempotencyKey,
      attemptNumber: 1,
      actionEnvelopeDigest,
      expectedRevision: "7",
      policyEvaluationDigest,
      preflight: { _tag: "ready", checkedRevision: "7", checkedAt: "2026-07-15T10:01:00.000Z" },
      startedAt: "2026-07-15T10:01:01.000Z"
    })
    const evaluatedAt = Schema.decodeUnknownSync(UtcTimestamp)("2026-07-15T10:01:01.000Z")
    const mismatches = governedActionAuthorityMismatches({ attempt, authorization, envelope, evaluatedAt })

    assert.include(mismatches, "authorization-permission-mismatch")
    assert.include(mismatches, "evidence-not-current")
  })
})
