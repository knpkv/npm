import type { EvidenceId } from "../identifiers.js"
import type {
  EnvironmentReadinessAssessment,
  EnvironmentReadinessEvaluationInput,
  ReadinessFactDefinition,
  ReadinessFactEvaluation,
  ReadinessFactObservation
} from "./model.js"
import {
  compareReadinessText,
  deriveEnvironmentReadinessVerdict,
  deriveReadinessFindings,
  deriveReadinessNextEvaluationAt,
  deriveReadinessSourceSummaries,
  deriveReadinessStages,
  readinessFactResult,
  sortedReadinessUnique
} from "./policy.js"

const evidenceIds = (observation: ReadinessFactObservation | null): Array<EvidenceId> =>
  observation === null
    ? []
    : sortedReadinessUnique(observation.evidence.map(({ evidenceId }) => evidenceId))

const evaluateFact = (
  definition: ReadinessFactDefinition,
  observation: ReadinessFactObservation | null
): ReadinessFactEvaluation => ({
  definition,
  observation,
  result: readinessFactResult(definition, observation),
  evidenceIds: evidenceIds(observation)
})

/** Pure V1 derivation of one immutable environment readiness assessment. */
export const assessEnvironmentReadiness = (
  input: EnvironmentReadinessEvaluationInput
): EnvironmentReadinessAssessment => {
  const observations = input.observations.map((observation): ReadinessFactObservation => ({
    ...observation,
    evidence: observation.evidence.slice().sort((left, right) =>
      compareReadinessText(left.evidenceId, right.evidenceId)
    )
  }))
  const observationsById = new Map(observations.map((observation) => [observation.factId, observation]))
  const facts = input.definitions
    .slice()
    .sort((left, right) => compareReadinessText(left.factId, right.factId))
    .map((definition) => evaluateFact(definition, observationsById.get(definition.factId) ?? null))
  const { blockers, gaps, warnings } = deriveReadinessFindings(facts, input.complete)
  const stages = deriveReadinessStages(facts)

  return {
    _tag: "environment",
    assessmentId: input.assessmentId,
    previousAssessmentId: input.previousAssessmentId,
    candidate: input.candidate,
    rule: input.rule,
    derivationVersion: input.derivationVersion,
    evaluatedAt: input.evaluatedAt,
    nextEvaluationAt: deriveReadinessNextEvaluationAt(facts),
    inputComplete: input.complete,
    verdict: deriveEnvironmentReadinessVerdict({ blockers, facts, gaps, stages }),
    stages,
    facts,
    requiredFactIds: sortedReadinessUnique(
      input.definitions
        .filter(({ requirement }) => requirement === "required")
        .map(({ factId }) => factId)
    ),
    verifiedFactIds: sortedReadinessUnique(
      facts
        .filter(({ result }) => result === "verified")
        .map(({ definition }) => definition.factId)
    ),
    blockers,
    warnings,
    gaps,
    sourceFreshness: deriveReadinessSourceSummaries(facts),
    evidenceIds: sortedReadinessUnique(
      observations.flatMap(({ evidence }) => evidence.map(({ evidenceId }) => evidenceId))
    )
  }
}
