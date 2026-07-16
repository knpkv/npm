import * as Schema from "effect/Schema"

import {
  EnvironmentId,
  EvidenceId,
  PluginConnectionId,
  ReadinessAssessmentId,
  ReleaseId,
  WorkspaceId
} from "../../../../domain/identifiers.js"
import {
  ReadinessArtifactRevision,
  ReadinessCandidateDigest,
  ReadinessDerivationVersion,
  ReadinessRuleId,
  ReadinessRuleVersion,
  ReadinessVerdict
} from "../../../../domain/readiness/index.js"
import { ContentBlobDigest } from "../models.js"

/** Driver row retained without trust until repository-controlled quarantine decoding. */
export const RawReadinessRow = Schema.Record(Schema.String, Schema.Unknown)

export const ReadinessRuleRow = Schema.Struct({
  workspaceId: WorkspaceId,
  ruleId: ReadinessRuleId,
  ruleVersion: ReadinessRuleVersion,
  ruleDigest: ReadinessCandidateDigest,
  materialJson: Schema.String,
  createdAt: Schema.String
})

export const ReadinessAssessmentRow = Schema.Struct({
  workspaceId: WorkspaceId,
  assessmentId: ReadinessAssessmentId,
  scopeKind: Schema.Literals(["environment", "release"]),
  releaseId: ReleaseId,
  environmentId: Schema.NullOr(EnvironmentId),
  releaseRevision: Schema.Int,
  artifactRevision: ReadinessArtifactRevision,
  candidateDigest: ReadinessCandidateDigest,
  ruleId: ReadinessRuleId,
  ruleVersion: ReadinessRuleVersion,
  ruleDigest: ReadinessCandidateDigest,
  derivationVersion: ReadinessDerivationVersion,
  previousAssessmentId: Schema.NullOr(ReadinessAssessmentId),
  verdict: ReadinessVerdict,
  evaluatedAt: Schema.String,
  nextEvaluationAt: Schema.NullOr(Schema.String),
  assessmentJson: Schema.String,
  assessmentDigest: ContentBlobDigest
})

const ReadinessHeadRowBase = {
  workspaceId: WorkspaceId,
  releaseId: ReleaseId,
  headRevision: Schema.Int,
  assessmentId: ReadinessAssessmentId,
  candidateDigest: ReadinessCandidateDigest,
  ruleId: ReadinessRuleId,
  ruleVersion: ReadinessRuleVersion,
  ruleDigest: ReadinessCandidateDigest,
  derivationVersion: ReadinessDerivationVersion,
  createdAt: Schema.String,
  updatedAt: Schema.String
}

export const ReadinessEnvironmentHeadRow = Schema.Struct({
  ...ReadinessHeadRowBase,
  environmentId: EnvironmentId
})

export const ReadinessReleaseHeadRow = Schema.Struct(ReadinessHeadRowBase)

export const ReadinessHistoryRow = Schema.Struct({
  headRevision: Schema.Int,
  committedAt: Schema.String,
  ...ReadinessAssessmentRow.fields
})

export const ReadinessCurrentRow = Schema.Struct({
  ...ReadinessHistoryRow.fields,
  joinComplete: Schema.Literals([0, 1]),
  headWorkspaceId: WorkspaceId,
  headReleaseId: ReleaseId,
  headEnvironmentId: Schema.NullOr(EnvironmentId),
  headAssessmentId: ReadinessAssessmentId,
  headUpdatedAt: Schema.String,
  currentHeadRevision: Schema.Int,
  pendingCount: Schema.Int,
  headCandidateDigest: ReadinessCandidateDigest,
  headRuleId: ReadinessRuleId,
  headRuleVersion: ReadinessRuleVersion,
  headRuleDigest: ReadinessCandidateDigest,
  headDerivationVersion: ReadinessDerivationVersion
})

export const ReadinessEvidenceDependencyRow = Schema.Struct({ evidenceId: EvidenceId })

export const ReadinessSourceDependencyRow = Schema.Struct({
  pluginConnectionId: PluginConnectionId
})

export const ReadinessReleaseChildRow = Schema.Struct({
  environmentId: EnvironmentId,
  environmentAssessmentId: ReadinessAssessmentId,
  environmentCandidateDigest: ReadinessCandidateDigest
})

export const ReadinessMaterializedEvidenceRow = Schema.Struct({
  assessmentId: ReadinessAssessmentId,
  evidenceId: EvidenceId
})

export const ReadinessMaterializedSourceRow = Schema.Struct({
  assessmentId: ReadinessAssessmentId,
  pluginConnectionId: PluginConnectionId
})

export const ReadinessMaterializedReleaseChildRow = Schema.Struct({
  assessmentId: ReadinessAssessmentId,
  ...ReadinessReleaseChildRow.fields
})

const QueueRowBase = {
  workspaceId: WorkspaceId,
  releaseId: ReleaseId,
  invalidationRevision: Schema.Int,
  queuedAt: Schema.String,
  availableAt: Schema.String,
  attempts: Schema.Int,
  claimOwner: Schema.NullOr(Schema.String),
  claimToken: Schema.NullOr(Schema.String),
  claimExpiresAt: Schema.NullOr(Schema.String)
}

export const ReadinessEnvironmentQueueRow = Schema.Struct({
  ...QueueRowBase,
  environmentId: EnvironmentId,
  reason: Schema.Literals([
    "evidence-changed",
    "plugin-health-changed",
    "rule-changed",
    "candidate-changed",
    "scheduled"
  ]),
  sourceEvidenceId: Schema.NullOr(EvidenceId),
  sourcePluginConnectionId: Schema.NullOr(PluginConnectionId)
})

export const ReadinessReleaseQueueRow = Schema.Struct({
  ...QueueRowBase,
  reason: Schema.Literals(["environment-assessment-changed", "rule-changed", "candidate-changed"]),
  sourceEnvironmentId: Schema.NullOr(EnvironmentId)
})
