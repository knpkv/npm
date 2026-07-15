import * as DateTime from "effect/DateTime"

import type { PluginConnectionId } from "../identifiers.js"
import type { UtcTimestamp } from "../utcTimestamp.js"
import type {
  EnvironmentReadinessAssessment,
  ReadinessFinding,
  ReadinessProgress,
  ReadinessSourceSummary,
  ReadinessStages,
  ReadinessVerdict,
  ReleaseReadinessAssessment,
  ReleaseReadinessRollupInput
} from "./model.js"

const compareText = (left: string, right: string): number => left.localeCompare(right)
const sortedUnique = <Value extends string>(values: ReadonlyArray<Value>): Array<Value> =>
  Array.from(new Set(values)).sort(compareText)

const findingKey = (finding: ReadinessFinding): string => {
  const subject = finding.subject._tag === "fact"
    ? finding.subject.factId
    : finding.subject._tag === "source"
    ? finding.subject.pluginConnectionId
    : "candidate"
  return `${finding.code}:${finding.subject._tag}:${subject}:${finding.evidenceIds.join(",")}`
}

const mergedFindings = (
  assessments: ReadonlyArray<EnvironmentReadinessAssessment>,
  select: (assessment: EnvironmentReadinessAssessment) => ReadonlyArray<ReadinessFinding>
): Array<ReadinessFinding> => {
  const byKey = new Map(assessments.flatMap(select).map((finding) => [findingKey(finding), finding]))
  return Array.from(byKey.values()).sort((left, right) => compareText(findingKey(left), findingKey(right)))
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
      evidenceIds: sortedUnique(summaries.flatMap(({ evidenceIds }) => evidenceIds))
    }))
    .sort((left, right) => compareText(left.pluginConnectionId, right.pluginConnectionId))
}

const firstProgress = (
  assessments: ReadonlyArray<EnvironmentReadinessAssessment>,
  stage: "build" | "production"
): ReadinessProgress | null =>
  assessments
    .slice()
    .sort((left, right) => {
      return compareText(
        left.candidate.scope.environmentId,
        right.candidate.scope.environmentId
      )
    })
    .find((assessment) => assessment.stages[stage].progress !== null)?.stages[stage].progress ?? null

const rollupStages = (assessments: ReadonlyArray<EnvironmentReadinessAssessment>): ReadinessStages => {
  const buildStates = assessments.map(({ stages }) => stages.build.state)
  const verifyStates = assessments.map(({ stages }) => stages.verify.state)
  const productionStates = assessments.map(({ stages }) => stages.production.state)
  const buildState: ReadinessStages["build"]["state"] = buildStates.includes("failed")
    ? "failed"
    : buildStates.includes("running")
    ? "running"
    : buildStates.includes("queued")
    ? "queued"
    : buildStates.every((state) => state === "succeeded")
    ? "succeeded"
    : buildStates.every((state) => state === "not-started")
    ? "not-started"
    : "held"
  const verifyState: ReadinessStages["verify"]["state"] = verifyStates.includes("failed")
    ? "failed"
    : verifyStates.includes("pending")
    ? "pending"
    : verifyStates.every((state) => state === "passed")
    ? "passed"
    : verifyStates.every((state) => state === "not-started")
    ? "not-started"
    : "held"
  let productionState: ReadinessStages["production"]["state"] = "not-started"
  if (productionStates.includes("failed")) productionState = "failed"
  else if (productionStates.includes("rolled-back")) productionState = "rolled-back"
  else if (productionStates.includes("deploying")) productionState = "deploying"
  else if (productionStates.includes("held")) productionState = "held"
  else if (productionStates.every((state) => state === "succeeded")) productionState = "succeeded"
  else if (productionStates.some((state) => state === "waiting" || state === "succeeded")) {
    productionState = "waiting"
  }

  return {
    build: {
      state: buildState,
      factIds: sortedUnique(assessments.flatMap(({ stages }) => stages.build.factIds)),
      evidenceIds: sortedUnique(assessments.flatMap(({ stages }) => stages.build.evidenceIds)),
      progress: firstProgress(assessments, "build")
    },
    verify: {
      state: verifyState,
      factIds: sortedUnique(assessments.flatMap(({ stages }) => stages.verify.factIds)),
      evidenceIds: sortedUnique(assessments.flatMap(({ stages }) => stages.verify.evidenceIds)),
      progress: null
    },
    production: {
      state: productionState,
      factIds: sortedUnique(assessments.flatMap(({ stages }) => stages.production.factIds)),
      evidenceIds: sortedUnique(assessments.flatMap(({ stages }) => stages.production.evidenceIds)),
      progress: firstProgress(assessments, "production")
    }
  }
}

const rollupVerdict = (verdicts: ReadonlyArray<ReadinessVerdict>): ReadinessVerdict => {
  if (verdicts.includes("blocked")) return "blocked"
  if (verdicts.includes("deploying")) return "deploying"
  if (verdicts.includes("building")) return "building"
  if (verdicts.includes("held")) return "held"
  if (verdicts.every((verdict) => verdict === "shipped")) return "shipped"
  return "ready"
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
      return compareText(
        left.candidate.scope.environmentId,
        right.candidate.scope.environmentId
      )
    })
  const first = environments.reduce((earliest, assessment) =>
    compareText(
        assessment.candidate.scope.environmentId,
        earliest.candidate.scope.environmentId
      ) < 0
      ? assessment
      : earliest, input.environments[0])
  const blockers = mergedFindings(environments, ({ blockers }) => blockers)
  const warnings = mergedFindings(environments, ({ warnings }) => warnings)
  const gaps = mergedFindings(environments, ({ gaps }) => gaps)

  return {
    _tag: "release",
    assessmentId: input.assessmentId,
    previousAssessmentId: input.previousAssessmentId,
    candidate: input.candidate,
    rule: first.rule,
    derivationVersion: first.derivationVersion,
    evaluatedAt: input.evaluatedAt,
    nextEvaluationAt: earliestEvaluation(environments),
    verdict: rollupVerdict(environments.map(({ verdict }) => verdict)),
    stages: rollupStages(environments),
    environments: [
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
    ],
    blockers,
    warnings,
    gaps,
    sourceFreshness: mergedSources(environments),
    evidenceIds: sortedUnique(environments.flatMap(({ evidenceIds }) => evidenceIds))
  }
}
