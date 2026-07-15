import * as DateTime from "effect/DateTime"

import type { EvidenceId, PluginConnectionId } from "../identifiers.js"
import type { UtcTimestamp } from "../utcTimestamp.js"
import type {
  EnvironmentReadinessAssessment,
  EnvironmentReadinessEvaluationInput,
  ReadinessEvidenceReference,
  ReadinessFactDefinition,
  ReadinessFactEvaluation,
  ReadinessFactObservation,
  ReadinessFactResult,
  ReadinessFinding,
  ReadinessFindingCode,
  ReadinessProgress,
  ReadinessSourceSummary,
  ReadinessStages,
  ReadinessVerdict
} from "./model.js"

const compareText = (left: string, right: string): number => left.localeCompare(right)
const sortedUnique = <Value extends string>(values: ReadonlyArray<Value>): Array<Value> =>
  Array.from(new Set(values)).sort(compareText)

const evidenceIds = (observation: ReadinessFactObservation | null): Array<EvidenceId> =>
  observation === null ? [] : sortedUnique(observation.evidence.map(({ evidenceId }) => evidenceId))

const evidenceIsCurrent = (evidence: ReadinessEvidenceReference): boolean =>
  evidence.freshness === "current" &&
  evidence.validity === "valid" &&
  (evidence.source._tag === "local" ||
    evidence.source.health === "healthy" || evidence.source.health === "degraded")

const observationIsCurrent = (observation: ReadinessFactObservation): boolean =>
  observation.evidence.length > 0 && observation.evidence.every(evidenceIsCurrent)

const positiveState = (observation: ReadinessFactObservation): boolean => {
  switch (observation.state._tag) {
    case "relationship":
      return observation.state.status === "verified" || observation.state.status === "governed"
    case "approval":
      return observation.state.status === "approved"
    case "check":
      return observation.state.status === "passed"
    case "execution":
      return observation.state.status === "succeeded"
    case "documentation":
      return observation.state.status === "current"
    case "deployment":
      return observation.state.status === "succeeded"
  }
}

const failureCode = (observation: ReadinessFactObservation): ReadinessFindingCode | null => {
  switch (observation.state._tag) {
    case "relationship":
      return observation.state.status === "rejected" ? "relationship-rejected" : null
    case "approval":
      return observation.state.status === "rejected" ? "approval-rejected" : null
    case "check":
      return observation.state.status === "failed"
        ? "check-failed"
        : observation.state.status === "cancelled"
        ? "check-cancelled"
        : null
    case "execution":
      return observation.state.status === "failed"
        ? "execution-failed"
        : observation.state.status === "stopped"
        ? "execution-stopped"
        : null
    case "documentation":
      return null
    case "deployment":
      return observation.state.status === "failed"
        ? "deployment-failed"
        : observation.state.status === "rolled-back"
        ? "deployment-rolled-back"
        : null
  }
}

const nonPositiveCode = (observation: ReadinessFactObservation): ReadinessFindingCode | null => {
  switch (observation.state._tag) {
    case "relationship":
      switch (observation.state.status) {
        case "missing":
          return "relationship-missing"
        case "inferred":
        case "proposed":
          return "relationship-unverified"
        case "superseded":
          return "relationship-superseded"
        default:
          return null
      }
    case "approval":
      switch (observation.state.status) {
        case "missing":
          return "approval-missing"
        case "pending":
          return "approval-pending"
        case "expired":
          return "approval-expired"
        default:
          return null
      }
    case "check":
      return observation.state.status === "missing"
        ? "check-missing"
        : observation.state.status === "queued" || observation.state.status === "running"
        ? "check-pending"
        : null
    case "execution":
      return observation.state.status === "missing"
        ? "execution-missing"
        : observation.state.status === "queued" || observation.state.status === "running"
        ? "execution-pending"
        : null
    case "documentation":
      switch (observation.state.status) {
        case "missing":
          return "documentation-missing"
        case "draft":
          return "documentation-draft"
        case "stale":
          return "documentation-stale"
        case "superseded":
          return "documentation-superseded"
        default:
          return null
      }
    case "deployment":
      return null
  }
}

const missingCode = (definition: ReadinessFactDefinition): ReadinessFindingCode => {
  switch (definition.kind) {
    case "relationship":
      return "relationship-missing"
    case "approval":
      return "approval-missing"
    case "check":
      return "check-missing"
    case "execution":
      return "execution-missing"
    case "documentation":
      return "documentation-missing"
    case "deployment":
      return "deployment-missing"
  }
}

const factFinding = (
  code: ReadinessFindingCode,
  definition: ReadinessFactDefinition,
  observation: ReadinessFactObservation | null
): ReadinessFinding => ({
  code,
  subject: { _tag: "fact", factId: definition.factId },
  evidenceIds: evidenceIds(observation)
})

interface FactOutcome {
  readonly evaluation: ReadinessFactEvaluation
  readonly blockers: ReadonlyArray<ReadinessFinding>
  readonly warnings: ReadonlyArray<ReadinessFinding>
  readonly gaps: ReadonlyArray<ReadinessFinding>
}

const evaluateFact = (
  definition: ReadinessFactDefinition,
  observation: ReadinessFactObservation | null
): FactOutcome => {
  if (observation === null) {
    const result: ReadinessFactResult = definition.requirement === "required" ? "gap" : "advisory"
    return {
      evaluation: { definition, observation, result, evidenceIds: [] },
      blockers: [],
      warnings: [],
      gaps: definition.requirement === "required" ? [factFinding(missingCode(definition), definition, null)] : []
    }
  }

  const failure = failureCode(observation)
  if (failure !== null) {
    const finding = factFinding(failure, definition, observation)
    const blocks = definition.requirement === "required" || definition.kind === "deployment"
    return {
      evaluation: {
        definition,
        observation,
        result: blocks ? "failed" : "advisory",
        evidenceIds: evidenceIds(observation)
      },
      blockers: blocks ? [finding] : [],
      warnings: blocks ? [] : [finding],
      gaps: []
    }
  }

  if (positiveState(observation) && observationIsCurrent(observation)) {
    return {
      evaluation: {
        definition,
        observation,
        result: "verified",
        evidenceIds: evidenceIds(observation)
      },
      blockers: [],
      warnings: [],
      gaps: []
    }
  }

  const code = nonPositiveCode(observation)
  const finding = code === null ? null : factFinding(code, definition, observation)
  const isActive = code === "approval-pending" || code === "check-pending" || code === "execution-pending"
  const result: ReadinessFactResult = isActive
    ? "pending"
    : definition.requirement === "required"
    ? "gap"
    : "advisory"
  return {
    evaluation: { definition, observation, result, evidenceIds: evidenceIds(observation) },
    blockers: [],
    warnings: finding !== null && (isActive || definition.requirement === "advisory") ? [finding] : [],
    gaps: finding !== null && !isActive && definition.requirement === "required" ? [finding] : []
  }
}

const evidenceFinding = (
  evidence: ReadinessEvidenceReference,
  definition: ReadinessFactDefinition
): ReadinessFinding | null => {
  const code: ReadinessFindingCode | null = evidence.validity === "expired"
    ? "evidence-expired"
    : evidence.freshness === "stale"
    ? "source-stale"
    : evidence.freshness === "missing"
    ? "source-missing"
    : evidence.freshness === "unavailable" ||
        (evidence.source._tag === "plugin" && ["unavailable", "disabled"].includes(evidence.source.health))
    ? "source-unavailable"
    : evidence.source._tag === "plugin" && evidence.source.health === "degraded"
    ? "plugin-degraded"
    : null
  if (code === null) return null
  return {
    code,
    subject: evidence.source._tag === "plugin"
      ? { _tag: "source", pluginConnectionId: evidence.source.pluginConnectionId }
      : { _tag: "fact", factId: definition.factId },
    evidenceIds: [evidence.evidenceId]
  }
}

const findingKey = (finding: ReadinessFinding): string => {
  const subject = finding.subject._tag === "fact"
    ? finding.subject.factId
    : finding.subject._tag === "source"
    ? finding.subject.pluginConnectionId
    : "candidate"
  return `${finding.code}:${finding.subject._tag}:${subject}:${finding.evidenceIds.join(",")}`
}

const normalizedFindings = (findings: ReadonlyArray<ReadinessFinding>): Array<ReadinessFinding> => {
  const byKey = new Map(findings.map((finding) => [findingKey(finding), finding]))
  return Array.from(byKey.values()).sort((left, right) => compareText(findingKey(left), findingKey(right)))
}

const freshnessRank = { current: 0, stale: 1, missing: 2, unavailable: 3 }
const healthRank = { healthy: 0, degraded: 1, unavailable: 2, disabled: 3 }

type SourceFreshness = ReadinessSourceSummary["freshness"]
type SourceHealth = ReadinessSourceSummary["health"]

const sourceSummaries = (
  observations: ReadonlyArray<ReadinessFactObservation>
): Array<ReadinessSourceSummary> => {
  const grouped = new Map<PluginConnectionId, Array<ReadinessEvidenceReference>>()
  for (const evidence of observations.flatMap(({ evidence }) => evidence)) {
    if (evidence.source._tag !== "plugin") continue
    const current = grouped.get(evidence.source.pluginConnectionId) ?? []
    current.push(evidence)
    grouped.set(evidence.source.pluginConnectionId, current)
  }
  return Array.from(grouped.entries())
    .map(([pluginConnectionId, evidence]): ReadinessSourceSummary => ({
      pluginConnectionId,
      freshness: evidence.reduce<SourceFreshness>(
        (worst, item) => freshnessRank[item.freshness] > freshnessRank[worst] ? item.freshness : worst,
        "current"
      ),
      health: evidence.reduce<SourceHealth>((worst, item) => {
        const health = item.source._tag === "plugin" ? item.source.health : "healthy"
        return healthRank[health] > healthRank[worst] ? health : worst
      }, "healthy"),
      evidenceIds: sortedUnique(evidence.map(({ evidenceId }) => evidenceId))
    }))
    .sort((left, right) => compareText(left.pluginConnectionId, right.pluginConnectionId))
}

const observationProgress = (observation: ReadinessFactObservation | undefined): ReadinessProgress | null => {
  if (observation?.state._tag === "execution" || observation?.state._tag === "deployment") {
    return observation.state.progress
  }
  return null
}

const stageEvidence = (facts: ReadonlyArray<ReadinessFactEvaluation>): Array<EvidenceId> =>
  sortedUnique(facts.flatMap(({ evidenceIds }) => evidenceIds))

const deriveStages = (facts: ReadonlyArray<ReadinessFactEvaluation>): ReadinessStages => {
  const build = facts.filter(({ definition }) => definition.kind === "execution")
  const verify = facts.filter(({ definition }) =>
    ["relationship", "approval", "check", "documentation"].includes(definition.kind)
  )
  const production = facts.filter(({ definition }) => definition.kind === "deployment")
  const activeBuild = build.find(({ observation }) =>
    observation?.state._tag === "execution" && ["queued", "running"].includes(observation.state.status) &&
    observationIsCurrent(observation)
  )
  const activeVerify = verify.find(({ observation }) =>
    observation !== null &&
    ((observation.state._tag === "check" && ["queued", "running"].includes(observation.state.status)) ||
      (observation.state._tag === "approval" && observation.state.status === "pending")) &&
    observationIsCurrent(observation)
  )
  const deployment = production.find(({ observation }) => observation?.state._tag === "deployment")?.observation
  const requiredBuild = build.filter(({ definition }) => definition.requirement === "required")
  const requiredVerify = verify.filter(({ definition }) => definition.requirement === "required")

  const buildState: ReadinessStages["build"]["state"] = build.some(({ result }) => result === "failed")
    ? "failed"
    : activeBuild?.observation?.state._tag === "execution" && activeBuild.observation.state.status === "running"
    ? "running"
    : activeBuild !== undefined
    ? "queued"
    : requiredBuild.every(({ result }) => result === "verified")
    ? "succeeded"
    : build.some(({ observation }) => observation !== null)
    ? "held"
    : "not-started"

  const verifyState: ReadinessStages["verify"]["state"] = verify.some(({ result }) => result === "failed")
    ? "failed"
    : activeVerify !== undefined
    ? "pending"
    : requiredVerify.every(({ result }) => result === "verified")
    ? "passed"
    : verify.some(({ observation }) => observation !== null)
    ? "held"
    : "not-started"

  let productionState: ReadinessStages["production"]["state"] = "not-started"
  if (deployment?.state._tag === "deployment") {
    const current = observationIsCurrent(deployment)
    switch (deployment.state.status) {
      case "failed":
        productionState = "failed"
        break
      case "rolled-back":
        productionState = "rolled-back"
        break
      case "deploying":
        productionState = current ? "deploying" : "held"
        break
      case "pending":
        productionState = current ? "waiting" : "held"
        break
      case "succeeded":
        productionState = current ? "succeeded" : "held"
        break
      case "not-started":
        productionState = "not-started"
        break
    }
  }

  return {
    build: {
      state: buildState,
      factIds: sortedUnique(build.map(({ definition }) => definition.factId)),
      evidenceIds: stageEvidence(build),
      progress: observationProgress(activeBuild?.observation ?? undefined)
    },
    verify: {
      state: verifyState,
      factIds: sortedUnique(verify.map(({ definition }) => definition.factId)),
      evidenceIds: stageEvidence(verify),
      progress: null
    },
    production: {
      state: productionState,
      factIds: sortedUnique(production.map(({ definition }) => definition.factId)),
      evidenceIds: stageEvidence(production),
      progress: observationProgress(deployment ?? undefined)
    }
  }
}

const nextEvaluationAt = (
  observations: ReadonlyArray<ReadinessFactObservation>
): UtcTimestamp | null => {
  const boundaries = observations.flatMap(({ evidence }) =>
    evidence.flatMap(({ reevaluateAt }) => reevaluateAt === null ? [] : [reevaluateAt])
  )
  return boundaries.reduce<UtcTimestamp | null>(
    (earliest, boundary) => earliest === null || DateTime.Order(boundary, earliest) < 0 ? boundary : earliest,
    null
  )
}

const deriveVerdict = (
  facts: ReadonlyArray<ReadinessFactEvaluation>,
  blockers: ReadonlyArray<ReadinessFinding>,
  gaps: ReadonlyArray<ReadinessFinding>,
  stages: ReadinessStages
): ReadinessVerdict => {
  if (blockers.length > 0) return "blocked"
  if (stages.production.state === "deploying") return "deploying"
  if (["queued", "running"].includes(stages.build.state) || stages.verify.state === "pending") return "building"
  if (
    gaps.length > 0 ||
    stages.build.state === "held" ||
    stages.verify.state === "held" ||
    stages.production.state === "held" ||
    facts.some(({ definition, result }) => definition.requirement === "required" && result !== "verified")
  ) return "held"
  if (stages.production.state === "succeeded") return "shipped"
  return "ready"
}

/** Pure V1 derivation of one immutable environment readiness assessment. */
export const assessEnvironmentReadiness = (
  input: EnvironmentReadinessEvaluationInput
): EnvironmentReadinessAssessment => {
  const observationsById = new Map(input.observations.map((observation) => [observation.factId, observation]))
  const outcomes = input.definitions
    .slice()
    .sort((left, right) => compareText(left.factId, right.factId))
    .map((definition) => evaluateFact(definition, observationsById.get(definition.factId) ?? null))
  const evidenceIssues = input.definitions.flatMap((definition) => {
    const observation = observationsById.get(definition.factId)
    if (observation === undefined) return []
    return observation.evidence.flatMap((evidence) => {
      const finding = evidenceFinding(evidence, definition)
      return finding === null ? [] : [{ definition, finding }]
    })
  })
  const incomplete: ReadonlyArray<ReadinessFinding> = input.complete
    ? []
    : [{ code: "input-incomplete", subject: { _tag: "candidate" }, evidenceIds: [] }]
  const blockers = normalizedFindings(outcomes.flatMap(({ blockers }) => blockers))
  const warnings = normalizedFindings([
    ...outcomes.flatMap(({ warnings }) => warnings),
    ...evidenceIssues
      .filter(({ definition, finding }) => finding.code === "plugin-degraded" || definition.requirement === "advisory")
      .map(({ finding }) => finding)
  ])
  const gaps = normalizedFindings([
    ...outcomes.flatMap(({ gaps }) => gaps),
    ...incomplete,
    ...evidenceIssues
      .filter(({ definition, finding }) => definition.requirement === "required" && finding.code !== "plugin-degraded")
      .map(({ finding }) => finding)
  ])
  const facts = outcomes.map(({ evaluation }) => evaluation)
  const stages = deriveStages(facts)

  return {
    _tag: "environment",
    assessmentId: input.assessmentId,
    previousAssessmentId: input.previousAssessmentId,
    candidate: input.candidate,
    rule: input.rule,
    derivationVersion: input.derivationVersion,
    evaluatedAt: input.evaluatedAt,
    nextEvaluationAt: nextEvaluationAt(input.observations),
    verdict: deriveVerdict(facts, blockers, gaps, stages),
    stages,
    facts,
    requiredFactIds: sortedUnique(
      input.definitions
        .filter(({ requirement }) => requirement === "required")
        .map(({ factId }) => factId)
    ),
    verifiedFactIds: sortedUnique(
      facts
        .filter(({ result }) => result === "verified")
        .map(({ definition }) => definition.factId)
    ),
    blockers,
    warnings,
    gaps,
    sourceFreshness: sourceSummaries(input.observations),
    evidenceIds: sortedUnique(
      input.observations.flatMap(({ evidence }) => evidence.map(({ evidenceId }) => evidenceId))
    )
  }
}
