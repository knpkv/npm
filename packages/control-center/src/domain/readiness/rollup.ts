import type {
  EnvironmentReadinessAssessment,
  ReleaseReadinessAssessment,
  ReleaseReadinessRollupInput
} from "./model.js"
import {
  compareReadinessText,
  deriveReleaseReadinessFindings,
  deriveReleaseReadinessNextEvaluationAt,
  deriveReleaseReadinessSourceSummaries,
  deriveReleaseReadinessStages,
  deriveReleaseReadinessVerdict,
  sortedReadinessUnique
} from "./policy.js"

/** Exact compact projection retained when an environment is rolled into a release. */
export const summarizeEnvironmentReadiness = (
  assessment: EnvironmentReadinessAssessment
): ReleaseReadinessAssessment["environments"][number] => ({
  assessmentId: assessment.assessmentId,
  environmentId: assessment.candidate.scope.environmentId,
  candidateDigest: assessment.candidate.digest,
  inputComplete: assessment.inputComplete,
  facts: assessment.facts,
  nextEvaluationAt: assessment.nextEvaluationAt,
  verdict: assessment.verdict,
  stages: assessment.stages,
  blockers: assessment.blockers,
  warnings: assessment.warnings,
  gaps: assessment.gaps,
  sourceFreshness: assessment.sourceFreshness,
  evidenceIds: assessment.evidenceIds
})

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
  const environmentSummaries: ReleaseReadinessAssessment["environments"] = [
    summarizeEnvironmentReadiness(first),
    ...environments.filter((assessment) => assessment !== first).map(summarizeEnvironmentReadiness)
  ]
  const findings = deriveReleaseReadinessFindings(environmentSummaries)

  return {
    _tag: "release",
    assessmentId: input.assessmentId,
    previousAssessmentId: input.previousAssessmentId,
    candidate: input.candidate,
    rule: first.rule,
    derivationVersion: first.derivationVersion,
    evaluatedAt: input.evaluatedAt,
    nextEvaluationAt: deriveReleaseReadinessNextEvaluationAt(environmentSummaries),
    verdict: deriveReleaseReadinessVerdict(environmentSummaries),
    stages: deriveReleaseReadinessStages(environmentSummaries),
    environments: environmentSummaries,
    blockers: findings.blockers,
    warnings: findings.warnings,
    gaps: findings.gaps,
    sourceFreshness: deriveReleaseReadinessSourceSummaries(environmentSummaries),
    evidenceIds: sortedReadinessUnique(environments.flatMap(({ evidenceIds }) => evidenceIds))
  }
}
