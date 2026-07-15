import * as DateTime from "effect/DateTime"

import type { PluginConnectionId } from "../identifiers.js"
import type { UtcTimestamp } from "../utcTimestamp.js"
import type {
  EnvironmentReadinessAssessment,
  ReadinessFinding,
  ReadinessSourceSummary,
  ReleaseReadinessAssessment,
  ReleaseReadinessRollupInput
} from "./model.js"
import {
  compareReadinessText,
  deriveReleaseReadinessStages,
  deriveReleaseReadinessVerdict,
  readinessFindingKey,
  sortedReadinessUnique
} from "./policy.js"

const mergedFindings = (
  assessments: ReadonlyArray<EnvironmentReadinessAssessment>,
  select: (assessment: EnvironmentReadinessAssessment) => ReadonlyArray<ReadinessFinding>
): Array<ReadinessFinding> => {
  const byKey = new Map(assessments.flatMap(select).map((finding) => [readinessFindingKey(finding), finding]))
  return Array.from(byKey.values()).sort((left, right) =>
    compareReadinessText(readinessFindingKey(left), readinessFindingKey(right))
  )
}

const freshnessRank = { current: 0, stale: 1, missing: 2, unavailable: 3 }
const healthRank = { healthy: 0, degraded: 1, unavailable: 2, disabled: 3 }

type SourceFreshness = ReadinessSourceSummary["freshness"]
type SourceHealth = ReadinessSourceSummary["health"]

const mergedSources = (
  assessments: ReadonlyArray<EnvironmentReadinessAssessment>
): Array<ReadinessSourceSummary> => {
  const grouped = new Map<PluginConnectionId, Array<ReadinessSourceSummary>>()
  for (const summary of assessments.flatMap(({ sourceFreshness }) => sourceFreshness)) {
    const current = grouped.get(summary.pluginConnectionId) ?? []
    current.push(summary)
    grouped.set(summary.pluginConnectionId, current)
  }
  return Array.from(grouped.entries())
    .map(([pluginConnectionId, summaries]): ReadinessSourceSummary => ({
      pluginConnectionId,
      freshness: summaries.reduce<SourceFreshness>(
        (worst, summary) => freshnessRank[summary.freshness] > freshnessRank[worst] ? summary.freshness : worst,
        "current"
      ),
      health: summaries.reduce<SourceHealth>(
        (worst, summary) => healthRank[summary.health] > healthRank[worst] ? summary.health : worst,
        "healthy"
      ),
      evidenceIds: sortedReadinessUnique(summaries.flatMap(({ evidenceIds }) => evidenceIds))
    }))
    .sort((left, right) => compareReadinessText(left.pluginConnectionId, right.pluginConnectionId))
}

const earliestEvaluation = (
  assessments: ReadonlyArray<EnvironmentReadinessAssessment>
): UtcTimestamp | null =>
  assessments.reduce<UtcTimestamp | null>((earliest, { nextEvaluationAt }) => {
    if (nextEvaluationAt === null) return earliest
    return earliest === null || DateTime.Order(nextEvaluationAt, earliest) < 0 ? nextEvaluationAt : earliest
  }, null)

/** Pure deterministic roll-up of current target-environment assessments. */
export const rollUpReleaseReadiness = (
  input: ReleaseReadinessRollupInput
): ReleaseReadinessAssessment => {
  const environments = input.environments
    .slice()
    .sort((left, right) => {
      return compareReadinessText(
        left.candidate.scope.environmentId,
        right.candidate.scope.environmentId
      )
    })
  const first = environments.reduce((earliest, assessment) =>
    compareReadinessText(
        assessment.candidate.scope.environmentId,
        earliest.candidate.scope.environmentId
      ) < 0
      ? assessment
      : earliest, input.environments[0])
  const blockers = mergedFindings(environments, ({ blockers }) => blockers)
  const warnings = mergedFindings(environments, ({ warnings }) => warnings)
  const gaps = mergedFindings(environments, ({ gaps }) => gaps)
  const environmentSummaries: ReleaseReadinessAssessment["environments"] = [
    {
      assessmentId: first.assessmentId,
      environmentId: first.candidate.scope.environmentId,
      candidateDigest: first.candidate.digest,
      verdict: first.verdict,
      stages: first.stages
    },
    ...environments.filter((assessment) => assessment !== first).map((assessment) => ({
      assessmentId: assessment.assessmentId,
      environmentId: assessment.candidate.scope.environmentId,
      candidateDigest: assessment.candidate.digest,
      verdict: assessment.verdict,
      stages: assessment.stages
    }))
  ]

  return {
    _tag: "release",
    assessmentId: input.assessmentId,
    previousAssessmentId: input.previousAssessmentId,
    candidate: input.candidate,
    rule: first.rule,
    derivationVersion: first.derivationVersion,
    evaluatedAt: input.evaluatedAt,
    nextEvaluationAt: earliestEvaluation(environments),
    verdict: deriveReleaseReadinessVerdict(environmentSummaries),
    stages: deriveReleaseReadinessStages(environmentSummaries),
    environments: environmentSummaries,
    blockers,
    warnings,
    gaps,
    sourceFreshness: mergedSources(environments),
    evidenceIds: sortedReadinessUnique(environments.flatMap(({ evidenceIds }) => evidenceIds))
  }
}
