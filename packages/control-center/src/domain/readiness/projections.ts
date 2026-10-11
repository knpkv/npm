/** Shared decoded readiness response contracts, without server evaluation schemas or policy. @module */
import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"

import { EvidenceId, PluginConnectionId, WorkspaceSettingsMutationId } from "../identifiers.js"
import { UtcTimestamp } from "../utcTimestamp.js"

/** Stable identity of one V1 readiness fact, independent of display copy. */
export const ReadinessFactId = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(200)
).annotate({ identifier: "ReadinessFactId" }).pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9._:/-]*$/u)),
  Schema.brand("ReadinessFactId")
)

/** Decoded readiness-fact identity. */
export type ReadinessFactId = typeof ReadinessFactId.Type

/** Hash of the complete canonical candidate input assembled by the application layer. */
export const ReadinessCandidateDigest = Schema.String.check(
  Schema.isPattern(/^sha256:[0-9a-f]{64}$/u)
).pipe(Schema.brand("ReadinessCandidateDigest"))

/** Decoded candidate digest. */
export type ReadinessCandidateDigest = typeof ReadinessCandidateDigest.Type

/** Canonical six-state readiness verdict. */
export const ReadinessVerdict = Schema.Literals([
  "blocked",
  "ready",
  "deploying",
  "building",
  "shipped",
  "held"
])

/** Decoded readiness verdict. */
export type ReadinessVerdict = typeof ReadinessVerdict.Type

const CountProgress = Schema.TaggedStruct("count", {
  completed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  total: Schema.Int.check(Schema.isGreaterThan(0))
}).check(
  Schema.makeFilter(({ completed, total }) => completed <= total, {
    expected: "readiness progress completed count not to exceed its total"
  })
)

const PercentProgress = Schema.TaggedStruct("percent", {
  value: Schema.Number.check(
    Schema.makeFilter((value) => value >= 0 && value <= 100, {
      expected: "readiness progress percentage between zero and one hundred"
    })
  )
})

/** Typed progress for builds and deployments without copied display text. */
export const ReadinessProgress = Schema.Union([CountProgress, PercentProgress]).pipe(
  Schema.toTaggedUnion("_tag")
)

/** Decoded readiness progress. */
export type ReadinessProgress = typeof ReadinessProgress.Type

/** Exact immutable governed target-setting decision that removes a manual-gate prerequisite. */
export const ReadinessGateWaiver = Schema.Struct({
  settingsRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  settingsAuditId: WorkspaceSettingsMutationId,
  settingsDigest: ReadinessCandidateDigest,
  topologyDigest: ReadinessCandidateDigest,
  auditedAt: UtcTimestamp
})

/** Decoded target-setting waiver; it asserts no provider approval or verification. */
export type ReadinessGateWaiver = typeof ReadinessGateWaiver.Type

/** Describe the audited policy exemption without asserting a provider approval. */
export const describeReadinessGateWaiver = (waiver: ReadinessGateWaiver): string =>
  `waived by target settings (${DateTime.formatIso(waiver.auditedAt)})`

/** Stable machine-readable reason emitted by the V1 rule policy. */
export const ReadinessFindingCode = Schema.Literals([
  "gate-waived",
  "input-incomplete",
  "relationship-missing",
  "relationship-unverified",
  "relationship-rejected",
  "relationship-superseded",
  "approval-missing",
  "approval-pending",
  "approval-rejected",
  "approval-expired",
  "check-missing",
  "check-pending",
  "check-failed",
  "check-cancelled",
  "execution-missing",
  "execution-pending",
  "execution-failed",
  "execution-stopped",
  "documentation-missing",
  "documentation-draft",
  "documentation-stale",
  "documentation-superseded",
  "deployment-missing",
  "deployment-failed",
  "deployment-rolled-back",
  "source-stale",
  "source-missing",
  "source-unavailable",
  "plugin-degraded",
  "evidence-expired"
])

/** Decoded readiness finding code. */
export type ReadinessFindingCode = typeof ReadinessFindingCode.Type

/** Stable subject of a readiness finding. */
export const ReadinessFindingSubject = Schema.TaggedUnion({
  fact: { factId: ReadinessFactId },
  source: { pluginConnectionId: PluginConnectionId },
  candidate: {}
})

/** One blocker, warning, or evidence gap without presentation prose. */
export const ReadinessFinding = Schema.Struct({
  code: ReadinessFindingCode,
  subject: ReadinessFindingSubject,
  evidenceIds: Schema.Array(EvidenceId).check(Schema.isMaxLength(128)),
  waiver: Schema.optionalKey(ReadinessGateWaiver)
}).check(
  Schema.makeFilter(({ evidenceIds }) => new Set(evidenceIds).size === evidenceIds.length, {
    expected: "readiness finding evidence identifiers to be unique"
  }),
  Schema.makeFilter(({ code, waiver }) => (code === "gate-waived") === (waiver !== undefined), {
    expected: "a gate-waived finding to retain its immutable target-setting decision"
  })
)

/** Decoded readiness finding. */
export type ReadinessFinding = typeof ReadinessFinding.Type

const ReadinessStageBase = {
  factIds: Schema.Array(ReadinessFactId).check(Schema.isMaxLength(512)),
  evidenceIds: Schema.Array(EvidenceId).check(Schema.isMaxLength(512)),
  progress: Schema.NullOr(ReadinessProgress)
}

/** Server-derived Build stage. */
export const BuildReadinessStage = Schema.Struct({
  ...ReadinessStageBase,
  state: Schema.Literals(["not-started", "queued", "running", "succeeded", "failed", "held"])
})

/** Server-derived Verify stage. */
export const VerifyReadinessStage = Schema.Struct({
  ...ReadinessStageBase,
  state: Schema.Literals(["not-started", "pending", "passed", "failed", "held"])
})

/** Server-derived Production stage. */
export const ProductionReadinessStage = Schema.Struct({
  ...ReadinessStageBase,
  state: Schema.Literals([
    "not-started",
    "waiting",
    "deploying",
    "succeeded",
    "failed",
    "rolled-back",
    "held"
  ])
})

/** Exactly three authoritative delivery stages. */
export const ReadinessStages = Schema.Struct({
  build: BuildReadinessStage,
  verify: VerifyReadinessStage,
  production: ProductionReadinessStage
})

/** Decoded readiness stages. */
export type ReadinessStages = typeof ReadinessStages.Type

/** Safe recorded diagnostic; normalized target identifiers remain within authenticated workspace responses. */
export const ReadinessFailureDetails = Schema.Struct({
  operation: Schema.Literals(["snapshot", "evidence", "derive", "publish"]),
  diagnosticCode: Schema.Literals([
    "readiness-snapshot-invalid",
    "readiness-evidence-invalid",
    "readiness-derivation-invalid",
    "readiness-publication-failed"
  ]),
  invalidationRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  retryAt: UtcTimestamp
})
export type ReadinessFailureDetails = typeof ReadinessFailureDetails.Type
