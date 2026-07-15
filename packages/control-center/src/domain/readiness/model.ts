import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"

import {
  EnvironmentId,
  EvidenceId,
  PluginConnectionId,
  ReadinessAssessmentId,
  ReleaseId,
  WorkspaceId
} from "../identifiers.js"
import { UtcTimestamp } from "../utcTimestamp.js"

const boundedIdentifier = (maximumLength: number, identifier: string) =>
  Schema.String.check(
    Schema.isTrimmed(),
    Schema.isMinLength(1),
    Schema.isMaxLength(maximumLength)
  ).annotate({ identifier })

const unique = <Value>(values: ReadonlyArray<Value>): boolean => new Set(values).size === values.length

/** Stable identity of one V1 readiness fact, independent of display copy. */
export const ReadinessFactId = boundedIdentifier(200, "ReadinessFactId").pipe(
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

/** Positive version of the rule policy used for one assessment. */
export const ReadinessRuleVersion = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("ReadinessRuleVersion")
)

/** Decoded readiness-rule version. */
export type ReadinessRuleVersion = typeof ReadinessRuleVersion.Type

/** Positive version of the evaluator implementation used for one assessment. */
export const ReadinessDerivationVersion = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("ReadinessDerivationVersion")
)

/** Decoded readiness-derivation version. */
export type ReadinessDerivationVersion = typeof ReadinessDerivationVersion.Type

/** V1 readiness policy version. */
export const READINESS_RULE_VERSION_V1 = ReadinessRuleVersion.make(1)

/** V1 evaluator implementation version. */
export const READINESS_DERIVATION_VERSION_V1 = ReadinessDerivationVersion.make(1)

/** Explicit release or target-environment scope of an assessment. */
export const ReadinessScope = Schema.TaggedUnion({
  release: { releaseId: ReleaseId },
  environment: { releaseId: ReleaseId, environmentId: EnvironmentId }
})

/** Decoded readiness scope. */
export type ReadinessScope = typeof ReadinessScope.Type

const CandidateIdentityBase = {
  workspaceId: WorkspaceId,
  releaseRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  artifactRevision: boundedIdentifier(512, "ReadinessArtifactRevision"),
  digest: ReadinessCandidateDigest
}

/** Immutable target-environment candidate whose complete material is digest-bound. */
export const EnvironmentReadinessCandidateIdentity = Schema.Struct({
  ...CandidateIdentityBase,
  scope: Schema.TaggedStruct("environment", {
    releaseId: ReleaseId,
    environmentId: EnvironmentId
  })
})

/** Immutable release-scope candidate whose child assessments are digest-bound. */
export const ReleaseReadinessCandidateIdentity = Schema.Struct({
  ...CandidateIdentityBase,
  scope: Schema.TaggedStruct("release", { releaseId: ReleaseId })
})

/** Immutable deployable candidate whose complete material is bound by a digest. */
export const ReadinessCandidateIdentity = Schema.Union([
  EnvironmentReadinessCandidateIdentity,
  ReleaseReadinessCandidateIdentity
])

/** Decoded deployable candidate identity. */
export type ReadinessCandidateIdentity = typeof ReadinessCandidateIdentity.Type

/** Stable rule-set identity and content digest retained with every assessment. */
export const ReadinessRuleReference = Schema.Struct({
  ruleId: boundedIdentifier(200, "ReadinessRuleId"),
  version: ReadinessRuleVersion,
  digest: ReadinessCandidateDigest
})

/** Decoded readiness rule reference. */
export type ReadinessRuleReference = typeof ReadinessRuleReference.Type

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

/** Closed provider-neutral fact categories understood by the V1 evaluator. */
export const ReadinessFactKind = Schema.Literals([
  "relationship",
  "approval",
  "check",
  "execution",
  "documentation",
  "deployment"
])

/** Decoded readiness-fact category. */
export type ReadinessFactKind = typeof ReadinessFactKind.Type

/** Whether a fact gates readiness or only contributes context. */
export const ReadinessFactRequirement = Schema.Literals(["required", "advisory"])

/** Decoded fact requirement. */
export type ReadinessFactRequirement = typeof ReadinessFactRequirement.Type

/** Policy definition that makes missing observations explicit rather than successful by absence. */
export const ReadinessFactDefinition = Schema.Struct({
  factId: ReadinessFactId,
  kind: ReadinessFactKind,
  requirement: ReadinessFactRequirement
})

/** Decoded readiness-fact definition. */
export type ReadinessFactDefinition = typeof ReadinessFactDefinition.Type

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

/** Closed normalized observation states; vendor strings never enter rule evaluation. */
export const ReadinessFactState = Schema.TaggedUnion({
  relationship: {
    status: Schema.Literals([
      "missing",
      "inferred",
      "proposed",
      "verified",
      "governed",
      "rejected",
      "superseded"
    ])
  },
  approval: {
    status: Schema.Literals(["missing", "pending", "approved", "rejected", "expired"])
  },
  check: {
    status: Schema.Literals(["missing", "queued", "running", "passed", "failed", "cancelled"])
  },
  execution: {
    status: Schema.Literals(["missing", "queued", "running", "succeeded", "failed", "stopped"]),
    progress: Schema.NullOr(ReadinessProgress)
  },
  documentation: {
    status: Schema.Literals(["missing", "draft", "current", "stale", "superseded"])
  },
  deployment: {
    status: Schema.Literals(["not-started", "pending", "deploying", "succeeded", "failed", "rolled-back"]),
    progress: Schema.NullOr(ReadinessProgress)
  }
})

/** Decoded normalized readiness observation state. */
export type ReadinessFactState = typeof ReadinessFactState.Type

/** Exact origin of evidence used for dependency tracking and plugin-health invalidation. */
export const ReadinessEvidenceSource = Schema.TaggedUnion({
  plugin: {
    pluginConnectionId: PluginConnectionId,
    health: Schema.Literals(["healthy", "degraded", "unavailable", "disabled"])
  },
  local: { origin: Schema.Literals(["human", "agent", "system"]) }
})

/** Decoded readiness-evidence source. */
export type ReadinessEvidenceSource = typeof ReadinessEvidenceSource.Type

/** Exact evidence dependency and its freshness at the injected evaluation boundary. */
export const ReadinessEvidenceReference = Schema.Struct({
  evidenceId: EvidenceId,
  source: ReadinessEvidenceSource,
  freshness: Schema.Literals(["current", "stale", "missing", "unavailable"]),
  validity: Schema.Literals(["valid", "expired"]),
  reevaluateAt: Schema.NullOr(UtcTimestamp)
})

/** Decoded readiness-evidence dependency. */
export type ReadinessEvidenceReference = typeof ReadinessEvidenceReference.Type

const stateRequiresEvidence = (state: ReadinessFactState): boolean =>
  state.status !== "missing" && state.status !== "not-started"

/** One normalized observation for a policy-defined fact. */
export const ReadinessFactObservation = Schema.Struct({
  factId: ReadinessFactId,
  state: ReadinessFactState,
  evidence: Schema.Array(ReadinessEvidenceReference).check(Schema.isMaxLength(128))
}).check(
  Schema.makeFilter(({ evidence }) => unique(evidence.map(({ evidenceId }) => evidenceId)), {
    expected: "readiness observation evidence identifiers to be unique"
  }),
  Schema.makeFilter(({ evidence, state }) => !stateRequiresEvidence(state) || evidence.length > 0, {
    expected: "a non-empty readiness observation state to reference evidence"
  })
)

/** Decoded readiness-fact observation. */
export type ReadinessFactObservation = typeof ReadinessFactObservation.Type

/** Stable machine-readable reason emitted by the V1 rule policy. */
export const ReadinessFindingCode = Schema.Literals([
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
  evidenceIds: Schema.Array(EvidenceId).check(Schema.isMaxLength(128))
}).check(
  Schema.makeFilter(({ evidenceIds }) => unique(evidenceIds), {
    expected: "readiness finding evidence identifiers to be unique"
  })
)

/** Decoded readiness finding. */
export type ReadinessFinding = typeof ReadinessFinding.Type

/** Outcome retained for every evaluated fact. */
export const ReadinessFactResult = Schema.Literals(["verified", "pending", "failed", "gap", "advisory"])

/** Decoded readiness-fact outcome. */
export type ReadinessFactResult = typeof ReadinessFactResult.Type

/** Auditable fact evaluation retained in an environment assessment. */
export const ReadinessFactEvaluation = Schema.Struct({
  definition: ReadinessFactDefinition,
  observation: Schema.NullOr(ReadinessFactObservation),
  result: ReadinessFactResult,
  evidenceIds: Schema.Array(EvidenceId).check(Schema.isMaxLength(128))
})

/** Decoded readiness-fact evaluation. */
export type ReadinessFactEvaluation = typeof ReadinessFactEvaluation.Type

/** Worst current source state for one contributing plugin connection. */
export const ReadinessSourceSummary = Schema.Struct({
  pluginConnectionId: PluginConnectionId,
  freshness: Schema.Literals(["current", "stale", "missing", "unavailable"]),
  health: Schema.Literals(["healthy", "degraded", "unavailable", "disabled"]),
  evidenceIds: Schema.Array(EvidenceId).check(Schema.isMaxLength(512))
})

/** Decoded source summary. */
export type ReadinessSourceSummary = typeof ReadinessSourceSummary.Type

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

/** Complete, decoded input for one environment evaluation. */
export const EnvironmentReadinessEvaluationInput = Schema.Struct({
  assessmentId: ReadinessAssessmentId,
  previousAssessmentId: Schema.NullOr(ReadinessAssessmentId),
  candidate: EnvironmentReadinessCandidateIdentity,
  rule: ReadinessRuleReference,
  derivationVersion: ReadinessDerivationVersion,
  evaluatedAt: UtcTimestamp,
  complete: Schema.Boolean,
  definitions: Schema.Array(ReadinessFactDefinition).check(Schema.isMaxLength(512)),
  observations: Schema.Array(ReadinessFactObservation).check(Schema.isMaxLength(512))
}).check(
  Schema.makeFilter(({ definitions }) => unique(definitions.map(({ factId }) => factId)), {
    expected: "readiness fact definitions to have unique identities"
  }),
  Schema.makeFilter(({ observations }) => unique(observations.map(({ factId }) => factId)), {
    expected: "readiness fact observations to have unique identities"
  }),
  Schema.makeFilter(({ definitions, observations }) => {
    const definitionsById = new Map(definitions.map((definition) => [definition.factId, definition]))
    return observations.every((observation) => definitionsById.get(observation.factId)?.kind === observation.state._tag)
  }, { expected: "readiness observations to match one policy fact of the same kind" }),
  Schema.makeFilter(
    ({ definitions }) =>
      definitions.some(({ kind, requirement }) => kind === "execution" && requirement === "required"),
    {
      expected: "environment readiness policy to require at least one build execution"
    }
  ),
  Schema.makeFilter(
    ({ definitions }) =>
      definitions.some(({ kind, requirement }) =>
        requirement === "required" && ["relationship", "approval", "check", "documentation"].includes(kind)
      ),
    { expected: "environment readiness policy to require at least one verification fact" }
  ),
  Schema.makeFilter(({ definitions }) => {
    const deployments = definitions.filter(({ kind }) => kind === "deployment")
    return deployments.length === 1 && deployments[0]?.requirement === "advisory"
  }, { expected: "environment readiness policy to define exactly one advisory deployment fact" })
)

/** Decoded environment-readiness input. */
export type EnvironmentReadinessEvaluationInput = typeof EnvironmentReadinessEvaluationInput.Type

const AssessmentBase = {
  assessmentId: ReadinessAssessmentId,
  previousAssessmentId: Schema.NullOr(ReadinessAssessmentId),
  candidate: ReadinessCandidateIdentity,
  rule: ReadinessRuleReference,
  derivationVersion: ReadinessDerivationVersion,
  evaluatedAt: UtcTimestamp,
  nextEvaluationAt: Schema.NullOr(UtcTimestamp),
  verdict: ReadinessVerdict,
  stages: ReadinessStages,
  blockers: Schema.Array(ReadinessFinding).check(Schema.isMaxLength(512)),
  warnings: Schema.Array(ReadinessFinding).check(Schema.isMaxLength(512)),
  gaps: Schema.Array(ReadinessFinding).check(Schema.isMaxLength(512)),
  sourceFreshness: Schema.Array(ReadinessSourceSummary).check(Schema.isMaxLength(512)),
  evidenceIds: Schema.Array(EvidenceId).check(Schema.isMaxLength(2_048))
}

/** Immutable environment assessment retaining exact facts and evidence. */
export const EnvironmentReadinessAssessment = Schema.Struct({
  ...AssessmentBase,
  _tag: Schema.Literal("environment"),
  candidate: EnvironmentReadinessCandidateIdentity,
  facts: Schema.Array(ReadinessFactEvaluation).check(Schema.isMaxLength(512)),
  requiredFactIds: Schema.Array(ReadinessFactId).check(Schema.isMaxLength(512)),
  verifiedFactIds: Schema.Array(ReadinessFactId).check(Schema.isMaxLength(512))
})

/** Decoded immutable environment assessment. */
export type EnvironmentReadinessAssessment = typeof EnvironmentReadinessAssessment.Type

/** Compact immutable child retained by a release-scope roll-up. */
export const EnvironmentReadinessSummary = Schema.Struct({
  assessmentId: ReadinessAssessmentId,
  environmentId: EnvironmentId,
  candidateDigest: ReadinessCandidateDigest,
  verdict: ReadinessVerdict,
  stages: ReadinessStages
})

/** Immutable release assessment rolled up from current target environments. */
export const ReleaseReadinessAssessment = Schema.Struct({
  ...AssessmentBase,
  _tag: Schema.Literal("release"),
  candidate: ReleaseReadinessCandidateIdentity,
  environments: Schema.NonEmptyArray(EnvironmentReadinessSummary).check(Schema.isMaxLength(512))
})

/** Decoded immutable release readiness assessment. */
export type ReleaseReadinessAssessment = typeof ReleaseReadinessAssessment.Type

/** Any immutable server-authoritative readiness assessment. */
export const ReadinessAssessment = Schema.Union([
  EnvironmentReadinessAssessment,
  ReleaseReadinessAssessment
]).pipe(Schema.toTaggedUnion("_tag"))

/** Decoded readiness assessment. */
export type ReadinessAssessment = typeof ReadinessAssessment.Type

/** Complete, decoded input for one release-scope roll-up. */
export const ReleaseReadinessRollupInput = Schema.Struct({
  assessmentId: ReadinessAssessmentId,
  previousAssessmentId: Schema.NullOr(ReadinessAssessmentId),
  candidate: ReleaseReadinessCandidateIdentity,
  evaluatedAt: UtcTimestamp,
  environments: Schema.NonEmptyArray(EnvironmentReadinessAssessment).check(Schema.isMaxLength(512))
}).check(
  Schema.makeFilter(({ environments }) => unique(environments.map(({ candidate }) => candidate.scope.environmentId)), {
    expected: "release readiness roll-up environment identities to be unique"
  }),
  Schema.makeFilter(
    ({ candidate, environments }) =>
      environments.every((assessment) =>
        assessment.candidate.workspaceId === candidate.workspaceId &&
        assessment.candidate.scope.releaseId === candidate.scope.releaseId &&
        assessment.candidate.releaseRevision === candidate.releaseRevision &&
        assessment.candidate.artifactRevision === candidate.artifactRevision
      ),
    {
      expected: "release readiness roll-up children to name the same workspace, release, and candidate revision"
    }
  ),
  Schema.makeFilter(
    ({ environments }) =>
      environments.every((assessment) =>
        assessment.rule.version === environments[0]?.rule.version &&
        assessment.rule.digest === environments[0]?.rule.digest &&
        assessment.derivationVersion === environments[0]?.derivationVersion
      ),
    { expected: "release readiness roll-up children to use one rule and derivation version" }
  ),
  Schema.makeFilter(
    ({ environments, evaluatedAt }) =>
      environments.every((assessment) => DateTime.Order(assessment.evaluatedAt, evaluatedAt) <= 0),
    { expected: "release readiness roll-up not to predate its child assessments" }
  )
)

/** Decoded release-readiness roll-up input. */
export type ReleaseReadinessRollupInput = typeof ReleaseReadinessRollupInput.Type
