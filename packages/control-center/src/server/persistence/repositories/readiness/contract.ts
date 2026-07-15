import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"

import {
  EnvironmentId,
  EvidenceId,
  PluginConnectionId,
  ReleaseId,
  WorkspaceId
} from "../../../../domain/identifiers.js"
import {
  EnvironmentReadinessAssessment,
  ReadinessCandidateDigest,
  ReadinessRuleMaterial,
  ReleaseReadinessAssessment
} from "../../../../domain/readiness/index.js"
import { UtcTimestamp } from "../../../../domain/utcTimestamp.js"

const boundedText = (maximumLength: number, identifier: string) =>
  Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(maximumLength)).annotate({
    identifier
  })

/** Positive optimistic-concurrency revision of one readiness-assessment head. */
export const ReadinessHeadRevision = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("ReadinessHeadRevision")
)

/** Decoded readiness-assessment head revision. */
export type ReadinessHeadRevision = typeof ReadinessHeadRevision.Type

/** Positive monotonic revision of one coalesced readiness invalidation. */
export const ReadinessInvalidationRevision = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("ReadinessInvalidationRevision")
)

/** Decoded readiness-invalidation revision. */
export type ReadinessInvalidationRevision = typeof ReadinessInvalidationRevision.Type

/** Stable identity of one readiness-invalidation worker lease. */
export const ReadinessLeaseOwner = boundedText(200, "ReadinessLeaseOwner").pipe(Schema.brand("ReadinessLeaseOwner"))

/** Decoded readiness lease-owner identity. */
export type ReadinessLeaseOwner = typeof ReadinessLeaseOwner.Type

/** Storage-generated fencing token for one exact readiness lease generation. */
export const ReadinessLeaseToken = boundedText(200, "ReadinessLeaseToken").pipe(
  Schema.brand("ReadinessLeaseToken")
)

/** Decoded readiness lease fencing token. */
export type ReadinessLeaseToken = typeof ReadinessLeaseToken.Type

/** Closed machine-readable reason for reevaluating readiness. */
export const ReadinessInvalidationReason = Schema.Literals([
  "evidence-changed",
  "plugin-health-changed",
  "rule-changed",
  "candidate-changed",
  "scheduled",
  "environment-assessment-changed"
])

/** Decoded readiness-invalidation reason. */
export type ReadinessInvalidationReason = typeof ReadinessInvalidationReason.Type

/** Bounded number of immutable assessments returned by one history read. */
export const ReadinessHistoryLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })).pipe(
  Schema.brand("ReadinessHistoryLimit")
)

/** Decoded readiness-history page size. */
export type ReadinessHistoryLimit = typeof ReadinessHistoryLimit.Type

/** Bounded caller or integrity failure at the readiness repository boundary. */
export class ReadinessInputError extends Schema.TaggedErrorClass<ReadinessInputError>()("ReadinessInputError", {
  operation: Schema.Literals([
    "register-rule",
    "commit-environment",
    "commit-release",
    "read-current",
    "read-history",
    "enqueue-invalidation",
    "claim-invalidation",
    "enqueue-affected",
    "enqueue-due"
  ]),
  reason: Schema.Literals([
    "invalid-request",
    "candidate-digest-mismatch",
    "rule-digest-mismatch",
    "rule-definition-mismatch",
    "stale-invalidation"
  ])
}) {}

/** Immutable, digest-bound readiness rule stored within one workspace. */
export const ReadinessRuleRecord = Schema.Struct({
  workspaceId: WorkspaceId,
  material: ReadinessRuleMaterial,
  digest: ReadinessCandidateDigest,
  registeredAt: UtcTimestamp
})

/** Decoded persisted readiness-rule record. */
export type ReadinessRuleRecord = typeof ReadinessRuleRecord.Type

/** Request to idempotently register one immutable readiness-rule snapshot. */
export const RegisterReadinessRuleRequest = ReadinessRuleRecord

/** Decoded immutable readiness-rule registration request. */
export type RegisterReadinessRuleRequest = typeof RegisterReadinessRuleRequest.Type

/** Outcome of registering an immutable rule or finding its exact existing record. */
export const RegisterReadinessRuleResult = Schema.TaggedUnion({
  created: { record: ReadinessRuleRecord },
  existing: { record: ReadinessRuleRecord }
})

/** Decoded immutable readiness-rule registration outcome. */
export type RegisterReadinessRuleResult = typeof RegisterReadinessRuleResult.Type

/** Persisted immutable environment assessment at one subject-head revision. */
export const EnvironmentReadinessAssessmentRecord = Schema.Struct({
  headRevision: ReadinessHeadRevision,
  assessment: EnvironmentReadinessAssessment,
  committedAt: UtcTimestamp
})

/** Decoded persisted environment-readiness assessment. */
export type EnvironmentReadinessAssessmentRecord = typeof EnvironmentReadinessAssessmentRecord.Type

/** Persisted immutable release assessment at one subject-head revision. */
export const ReleaseReadinessAssessmentRecord = Schema.Struct({
  headRevision: ReadinessHeadRevision,
  assessment: ReleaseReadinessAssessment,
  committedAt: UtcTimestamp
})

/** Decoded persisted release-readiness assessment. */
export type ReleaseReadinessAssessmentRecord = typeof ReleaseReadinessAssessmentRecord.Type

/** Exact leased invalidation a worker must consume with its assessment commit. */
export const ReadinessCommitLease = Schema.Struct({
  invalidationRevision: ReadinessInvalidationRevision,
  leaseOwner: ReadinessLeaseOwner,
  leaseToken: ReadinessLeaseToken
})

/** Decoded exact leased invalidation used by a readiness commit. */
export type ReadinessCommitLease = typeof ReadinessCommitLease.Type

/** Compare-and-swap request for an immutable environment assessment. */
export const CommitEnvironmentReadinessAssessmentRequest = Schema.Struct({
  expectedHeadRevision: Schema.NullOr(ReadinessHeadRevision),
  invalidation: Schema.NullOr(ReadinessCommitLease),
  assessment: EnvironmentReadinessAssessment
}).check(
  Schema.makeFilter(
    ({ assessment, expectedHeadRevision }) =>
      (expectedHeadRevision === null) === (assessment.previousAssessmentId === null),
    { expected: "a create commit without a predecessor and an update commit with one" }
  )
)

/** Decoded environment-readiness commit request. */
export type CommitEnvironmentReadinessAssessmentRequest = typeof CommitEnvironmentReadinessAssessmentRequest.Type

/** Environment-readiness record committed at the new head revision. */
export const CommitEnvironmentReadinessAssessmentResult = EnvironmentReadinessAssessmentRecord

/** Decoded environment-readiness commit result. */
export type CommitEnvironmentReadinessAssessmentResult = typeof CommitEnvironmentReadinessAssessmentResult.Type

/** Compare-and-swap request for an immutable release assessment. */
export const CommitReleaseReadinessAssessmentRequest = Schema.Struct({
  expectedHeadRevision: Schema.NullOr(ReadinessHeadRevision),
  invalidation: Schema.NullOr(ReadinessCommitLease),
  assessment: ReleaseReadinessAssessment
}).check(
  Schema.makeFilter(
    ({ assessment, expectedHeadRevision }) =>
      (expectedHeadRevision === null) === (assessment.previousAssessmentId === null),
    { expected: "a create commit without a predecessor and an update commit with one" }
  )
)

/** Decoded release-readiness commit request. */
export type CommitReleaseReadinessAssessmentRequest = typeof CommitReleaseReadinessAssessmentRequest.Type

/** Release-readiness record committed at the new head revision. */
export const CommitReleaseReadinessAssessmentResult = ReleaseReadinessAssessmentRecord

/** Decoded release-readiness commit result. */
export type CommitReleaseReadinessAssessmentResult = typeof CommitReleaseReadinessAssessmentResult.Type

/** Exhaustive environment or release subject addressed by readiness persistence. */
export const ReadinessAssessmentTarget = Schema.TaggedUnion({
  environment: {
    workspaceId: WorkspaceId,
    releaseId: ReleaseId,
    environmentId: EnvironmentId
  },
  release: {
    workspaceId: WorkspaceId,
    releaseId: ReleaseId
  }
})

/** Decoded readiness-assessment target. */
export type ReadinessAssessmentTarget = typeof ReadinessAssessmentTarget.Type

/** Whether a current readiness verdict may be used for governed decisions. */
export const ReadinessAssessmentAuthority = Schema.Literals(["authoritative", "pending"])

/** Decoded authority state for a current readiness verdict. */
export type ReadinessAssessmentAuthority = typeof ReadinessAssessmentAuthority.Type

/** Current environment assessment plus its atomic invalidation authority state. */
export const CurrentEnvironmentReadinessAssessmentRecord = Schema.Struct({
  ...EnvironmentReadinessAssessmentRecord.fields,
  authority: ReadinessAssessmentAuthority
})

/** Decoded current environment readiness record. */
export type CurrentEnvironmentReadinessAssessmentRecord = typeof CurrentEnvironmentReadinessAssessmentRecord.Type

/** Current release assessment plus its atomic invalidation authority state. */
export const CurrentReleaseReadinessAssessmentRecord = Schema.Struct({
  ...ReleaseReadinessAssessmentRecord.fields,
  authority: ReadinessAssessmentAuthority
})

/** Decoded current release readiness record. */
export type CurrentReleaseReadinessAssessmentRecord = typeof CurrentReleaseReadinessAssessmentRecord.Type

/** Request for the current environment or release readiness head. */
export const ReadCurrentReadinessAssessmentRequest = ReadinessAssessmentTarget

/** Decoded current-readiness request. */
export type ReadCurrentReadinessAssessmentRequest = typeof ReadCurrentReadinessAssessmentRequest.Type

/** Scope-preserving result of reading a current readiness head. */
export const ReadCurrentReadinessAssessmentResult = Schema.TaggedUnion({
  environment: { record: Schema.NullOr(CurrentEnvironmentReadinessAssessmentRecord) },
  release: { record: Schema.NullOr(CurrentReleaseReadinessAssessmentRecord) }
})

/** Decoded current-readiness result. */
export type ReadCurrentReadinessAssessmentResult = typeof ReadCurrentReadinessAssessmentResult.Type

/** Exclusive-cursor request for newest-first immutable readiness history. */
export const ReadReadinessHistoryRequest = Schema.TaggedUnion({
  environment: {
    workspaceId: WorkspaceId,
    releaseId: ReleaseId,
    environmentId: EnvironmentId,
    beforeHeadRevision: Schema.NullOr(ReadinessHeadRevision),
    limit: ReadinessHistoryLimit
  },
  release: {
    workspaceId: WorkspaceId,
    releaseId: ReleaseId,
    beforeHeadRevision: Schema.NullOr(ReadinessHeadRevision),
    limit: ReadinessHistoryLimit
  }
})

/** Decoded readiness-history request. */
export type ReadReadinessHistoryRequest = typeof ReadReadinessHistoryRequest.Type

/** Scope-preserving page of newest-first immutable readiness history. */
export const ReadReadinessHistoryResult = Schema.TaggedUnion({
  environment: {
    records: Schema.Array(EnvironmentReadinessAssessmentRecord).check(Schema.isMaxLength(200)),
    nextBeforeHeadRevision: Schema.NullOr(ReadinessHeadRevision)
  },
  release: {
    records: Schema.Array(ReleaseReadinessAssessmentRecord).check(Schema.isMaxLength(200)),
    nextBeforeHeadRevision: Schema.NullOr(ReadinessHeadRevision)
  }
})

/** Decoded readiness-history page. */
export type ReadReadinessHistoryResult = typeof ReadReadinessHistoryResult.Type

/** Active worker ownership of one exact readiness-invalidation revision. */
export const ReadinessInvalidationLease = Schema.Struct({
  owner: ReadinessLeaseOwner,
  token: ReadinessLeaseToken,
  claimedAt: UtcTimestamp,
  expiresAt: UtcTimestamp
}).check(
  Schema.makeFilter(({ claimedAt, expiresAt }) => DateTime.Order(claimedAt, expiresAt) < 0, {
    expected: "a readiness invalidation lease to expire after it is claimed"
  })
)

/** Decoded readiness-invalidation lease. */
export type ReadinessInvalidationLease = typeof ReadinessInvalidationLease.Type

const ReadinessInvalidationRecordFields = {
  invalidationRevision: ReadinessInvalidationRevision,
  reason: ReadinessInvalidationReason,
  enqueuedAt: UtcTimestamp,
  lease: Schema.NullOr(ReadinessInvalidationLease)
}

/** Coalesced environment or release invalidation with its exact monotonic revision. */
export const ReadinessInvalidationRecord = Schema.TaggedUnion({
  environment: {
    workspaceId: WorkspaceId,
    releaseId: ReleaseId,
    environmentId: EnvironmentId,
    ...ReadinessInvalidationRecordFields
  },
  release: {
    workspaceId: WorkspaceId,
    releaseId: ReleaseId,
    ...ReadinessInvalidationRecordFields
  }
})

/** Decoded readiness-invalidation record. */
export type ReadinessInvalidationRecord = typeof ReadinessInvalidationRecord.Type

/** Request to enqueue or advance a coalesced environment or release invalidation. */
export const EnqueueReadinessInvalidationRequest = Schema.TaggedUnion({
  environment: {
    workspaceId: WorkspaceId,
    releaseId: ReleaseId,
    environmentId: EnvironmentId,
    reason: Schema.Literals([
      "evidence-changed",
      "plugin-health-changed",
      "rule-changed",
      "candidate-changed",
      "scheduled"
    ]),
    enqueuedAt: UtcTimestamp
  },
  release: {
    workspaceId: WorkspaceId,
    releaseId: ReleaseId,
    reason: Schema.Literals(["environment-assessment-changed", "rule-changed", "candidate-changed"]),
    enqueuedAt: UtcTimestamp
  }
})

/** Decoded readiness-invalidation enqueue request. */
export type EnqueueReadinessInvalidationRequest = typeof EnqueueReadinessInvalidationRequest.Type

/** Invalidation record created or revision-advanced by an enqueue. */
export const EnqueueReadinessInvalidationResult = ReadinessInvalidationRecord

/** Decoded readiness-invalidation enqueue result. */
export type EnqueueReadinessInvalidationResult = typeof EnqueueReadinessInvalidationResult.Type

/** Exact evidence or plugin-health change used to invalidate only dependent current heads. */
export const EnqueueAffectedReadinessRequest = Schema.TaggedUnion({
  evidence: {
    workspaceId: WorkspaceId,
    evidenceId: EvidenceId,
    enqueuedAt: UtcTimestamp
  },
  plugin: {
    workspaceId: WorkspaceId,
    pluginConnectionId: PluginConnectionId,
    enqueuedAt: UtcTimestamp
  }
})

/** Decoded dependency-scoped readiness invalidation request. */
export type EnqueueAffectedReadinessRequest = typeof EnqueueAffectedReadinessRequest.Type

/** Counts of current environment and release subjects invalidated by one dependency change. */
export const EnqueueAffectedReadinessResult = Schema.Struct({
  environments: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  releases: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})

/** Decoded dependency-scoped readiness invalidation result. */
export type EnqueueAffectedReadinessResult = typeof EnqueueAffectedReadinessResult.Type

const ClaimReadinessInvalidationFields = {
  expectedInvalidationRevision: ReadinessInvalidationRevision,
  leaseOwner: ReadinessLeaseOwner,
  leaseExpiresAt: UtcTimestamp
}

/** Compare-and-swap request to lease one exact readiness-invalidation revision. */
export const ClaimReadinessInvalidationRequest = Schema.TaggedUnion({
  environment: {
    workspaceId: WorkspaceId,
    releaseId: ReleaseId,
    environmentId: EnvironmentId,
    ...ClaimReadinessInvalidationFields
  },
  release: {
    workspaceId: WorkspaceId,
    releaseId: ReleaseId,
    ...ClaimReadinessInvalidationFields
  }
})

/** Decoded readiness-invalidation claim request. */
export type ClaimReadinessInvalidationRequest = typeof ClaimReadinessInvalidationRequest.Type

/** Exact leased invalidation, or null when the compare-and-swap claim lost. */
export const ClaimReadinessInvalidationResult = Schema.NullOr(ReadinessInvalidationRecord)

/** Decoded readiness-invalidation claim result. */
export type ClaimReadinessInvalidationResult = typeof ClaimReadinessInvalidationResult.Type

/** Bounded due-schedule sweep for one workspace. */
export const EnqueueDueReadinessEvaluationsRequest = Schema.Struct({
  workspaceId: WorkspaceId,
  dueAt: UtcTimestamp,
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))
})

/** Decoded due-schedule sweep request. */
export type EnqueueDueReadinessEvaluationsRequest = typeof EnqueueDueReadinessEvaluationsRequest.Type

/** Number of exact due schedules promoted to coalesced environment invalidations. */
export const EnqueueDueReadinessEvaluationsResult = Schema.Struct({
  enqueued: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 500 }))
})

/** Decoded due-schedule sweep result. */
export type EnqueueDueReadinessEvaluationsResult = typeof EnqueueDueReadinessEvaluationsResult.Type
