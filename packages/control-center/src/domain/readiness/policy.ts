import * as DateTime from "effect/DateTime"

import type { EvidenceId, PluginConnectionId } from "../identifiers.js"
import type { UtcTimestamp } from "../utcTimestamp.js"
import type {
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

/** Locale-independent ordering used by canonical readiness records and digests. */
export const compareReadinessText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

/** Sorted unique string-like values for deterministic assessment material. */
export const sortedReadinessUnique = <Value extends string>(
  values: ReadonlyArray<Value>
): Array<Value> => Array.from(new Set(values)).sort(compareReadinessText)

/** Whether one exact evidence dependency is current enough for a verdict. */
export const readinessEvidenceIsCurrent = (evidence: ReadinessEvidenceReference): boolean =>
  evidence.freshness === "current" &&
  evidence.validity === "valid" &&
  (evidence.source._tag === "local" ||
    evidence.source.health === "healthy" ||
    evidence.source.health === "degraded")

/** Whether every evidence dependency of an observed fact is current and valid. */
export const readinessObservationIsCurrent = (
  observation: ReadinessFactObservation
): boolean => observation.evidence.length > 0 && observation.evidence.every(readinessEvidenceIsCurrent)

/** Whether a normalized observation is semantically positive. */
export const readinessObservationIsPositive = (
  observation: ReadinessFactObservation
): boolean => {
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

/** Machine-readable explicit-failure reason, independent of freshness. */
export const readinessFailureCode = (
  observation: ReadinessFactObservation
): ReadinessFindingCode | null => {
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

/** Machine-readable non-positive reason for one normalized observation. */
export const readinessNonPositiveCode = (
  observation: ReadinessFactObservation
): ReadinessFindingCode | null => {
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

/** Whether this observation represents active build or check work. */
export const readinessObservationIsDeliveryActivity = (
  definition: ReadinessFactDefinition,
  observation: ReadinessFactObservation | null
): boolean =>
  definition.requirement === "required" &&
  observation !== null &&
  ((observation.state._tag === "execution" &&
    (observation.state.status === "queued" || observation.state.status === "running")) ||
    (observation.state._tag === "check" &&
      (observation.state.status === "queued" || observation.state.status === "running"))) &&
  readinessObservationIsCurrent(observation)

/** Canonical semantic result retained for one fact evaluation. */
export const readinessFactResult = (
  definition: ReadinessFactDefinition,
  observation: ReadinessFactObservation | null
): ReadinessFactResult => {
  if (observation === null) return definition.requirement === "required" ? "gap" : "advisory"
  if (readinessFailureCode(observation) !== null) {
    return definition.requirement === "required" || definition.kind === "deployment"
      ? "failed"
      : "advisory"
  }
  if (readinessObservationIsPositive(observation) && readinessObservationIsCurrent(observation)) {
    return "verified"
  }
  const code = readinessNonPositiveCode(observation)
  if (code === "approval-pending" || code === "check-pending" || code === "execution-pending") {
    return "pending"
  }
  return definition.requirement === "required" ? "gap" : "advisory"
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

const observationEvidenceIds = (
  observation: ReadinessFactObservation | null
): Array<EvidenceId> =>
  observation === null
    ? []
    : sortedReadinessUnique(observation.evidence.map(({ evidenceId }) => evidenceId))

const factFinding = (
  code: ReadinessFindingCode,
  definition: ReadinessFactDefinition,
  observation: ReadinessFactObservation | null
): ReadinessFinding => ({
  code,
  subject: { _tag: "fact", factId: definition.factId },
  evidenceIds: observationEvidenceIds(observation)
})

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
        (evidence.source._tag === "plugin" &&
          (evidence.source.health === "unavailable" || evidence.source.health === "disabled"))
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

/** Stable sort/deduplication key for readiness findings. */
export const readinessFindingKey = (finding: ReadinessFinding): string => {
  const subject = finding.subject._tag === "fact"
    ? finding.subject.factId
    : finding.subject._tag === "source"
    ? finding.subject.pluginConnectionId
    : "candidate"
  return `${finding.code}:${finding.subject._tag}:${subject}:${finding.evidenceIds.join(",")}`
}

const normalizedFindings = (
  findings: ReadonlyArray<ReadinessFinding>
): Array<ReadinessFinding> => {
  const byKey = new Map(findings.map((finding) => [readinessFindingKey(finding), finding]))
  return Array.from(byKey.values()).sort((left, right) =>
    compareReadinessText(readinessFindingKey(left), readinessFindingKey(right))
  )
}

/** Exact blocker, warning, and gap sets implied by retained fact evaluations. */
export const deriveReadinessFindings = (
  facts: ReadonlyArray<ReadinessFactEvaluation>,
  complete: boolean
): {
  readonly blockers: Array<ReadinessFinding>
  readonly warnings: Array<ReadinessFinding>
  readonly gaps: Array<ReadinessFinding>
} => {
  const blockers: Array<ReadinessFinding> = []
  const warnings: Array<ReadinessFinding> = []
  const gaps: Array<ReadinessFinding> = complete
    ? []
    : [{ code: "input-incomplete", subject: { _tag: "candidate" }, evidenceIds: [] }]

  for (const { definition, observation } of facts) {
    if (observation === null) {
      if (definition.requirement === "required") {
        gaps.push(factFinding(missingCode(definition), definition, observation))
      }
      continue
    }

    const failure = readinessFailureCode(observation)
    if (failure !== null) {
      const finding = factFinding(failure, definition, observation)
      if (definition.requirement === "required" || definition.kind === "deployment") {
        blockers.push(finding)
      } else {
        warnings.push(finding)
      }
    } else if (!readinessObservationIsPositive(observation) || !readinessObservationIsCurrent(observation)) {
      const code = readinessNonPositiveCode(observation)
      if (code !== null) {
        const finding = factFinding(code, definition, observation)
        const active = code === "approval-pending" || code === "check-pending" || code === "execution-pending"
        if (active || definition.requirement === "advisory") warnings.push(finding)
        if (!active && definition.requirement === "required") gaps.push(finding)
      }
    }

    for (const evidence of observation.evidence) {
      const finding = evidenceFinding(evidence, definition)
      if (finding === null) continue
      warnings.push(finding)
      if (
        definition.requirement === "required" &&
        finding.code !== "plugin-degraded" &&
        failure === null
      ) gaps.push(finding)
    }
  }

  return {
    blockers: normalizedFindings(blockers),
    warnings: normalizedFindings(warnings),
    gaps: normalizedFindings(gaps)
  }
}

const freshnessRank = { current: 0, stale: 1, missing: 2, unavailable: 3 }
const healthRank = { healthy: 0, degraded: 1, unavailable: 2, disabled: 3 }

/** Exact worst-state summaries for plugin evidence retained by facts. */
export const deriveReadinessSourceSummaries = (
  facts: ReadonlyArray<ReadinessFactEvaluation>
): Array<ReadinessSourceSummary> => {
  const grouped = new Map<PluginConnectionId, Array<ReadinessEvidenceReference>>()
  for (const evidence of facts.flatMap(({ observation }) => observation?.evidence ?? [])) {
    if (evidence.source._tag !== "plugin") continue
    const current = grouped.get(evidence.source.pluginConnectionId) ?? []
    current.push(evidence)
    grouped.set(evidence.source.pluginConnectionId, current)
  }
  return Array.from(grouped.entries())
    .map(([pluginConnectionId, evidence]): ReadinessSourceSummary => ({
      pluginConnectionId,
      freshness: evidence.reduce<ReadinessSourceSummary["freshness"]>(
        (worst, item) =>
          freshnessRank[item.freshness] > freshnessRank[worst]
            ? item.freshness
            : worst,
        "current"
      ),
      health: evidence.reduce<ReadinessSourceSummary["health"]>((worst, item) => {
        const health = item.source._tag === "plugin" ? item.source.health : "healthy"
        return healthRank[health] > healthRank[worst] ? health : worst
      }, "healthy"),
      evidenceIds: sortedReadinessUnique(evidence.map(({ evidenceId }) => evidenceId))
    }))
    .sort((left, right) => compareReadinessText(left.pluginConnectionId, right.pluginConnectionId))
}

/** Earliest evidence freshness boundary retained by one environment assessment. */
export const deriveReadinessNextEvaluationAt = (
  facts: ReadonlyArray<ReadinessFactEvaluation>
): UtcTimestamp | null =>
  facts
    .flatMap(({ observation }) => observation?.evidence ?? [])
    .flatMap(({ reevaluateAt }) => reevaluateAt === null ? [] : [reevaluateAt])
    .reduce<UtcTimestamp | null>(
      (earliest, boundary) => earliest === null || DateTime.Order(boundary, earliest) < 0 ? boundary : earliest,
      null
    )

const observationProgress = (
  observation: ReadinessFactObservation | undefined
): ReadinessProgress | null => {
  if (observation?.state._tag === "execution" || observation?.state._tag === "deployment") {
    return observation.state.progress
  }
  return null
}

const stageEvidence = (facts: ReadonlyArray<ReadinessFactEvaluation>) =>
  sortedReadinessUnique(facts.flatMap(({ evidenceIds }) => evidenceIds))

/** Derive the exact three delivery stages from canonical fact evaluations. */
export const deriveReadinessStages = (
  facts: ReadonlyArray<ReadinessFactEvaluation>
): ReadinessStages => {
  const build = facts.filter(({ definition }) => definition.kind === "execution")
  const verify = facts.filter(({ definition }) =>
    ["relationship", "approval", "check", "documentation"].includes(definition.kind)
  )
  const production = facts.filter(({ definition }) => definition.kind === "deployment")
  const deployment = production.find(({ observation }) => observation?.state._tag === "deployment")?.observation
  const requiredBuild = build.filter(({ definition }) => definition.requirement === "required")
  const requiredVerify = verify.filter(({ definition }) => definition.requirement === "required")
  const activeBuild = requiredBuild.filter(({ observation }) =>
    observation !== null &&
    observation.state._tag === "execution" &&
    (observation.state.status === "queued" || observation.state.status === "running") &&
    readinessObservationIsCurrent(observation)
  )
  const runningBuild = activeBuild.find(({ observation }) =>
    observation?.state._tag === "execution" && observation.state.status === "running"
  )
  const queuedBuild = activeBuild.find(({ observation }) =>
    observation?.state._tag === "execution" && observation.state.status === "queued"
  )
  const activeVerify = requiredVerify.find(({ observation }) =>
    observation !== null &&
    ((observation.state._tag === "check" &&
      (observation.state.status === "queued" || observation.state.status === "running")) ||
      (observation.state._tag === "approval" && observation.state.status === "pending")) &&
    readinessObservationIsCurrent(observation)
  )

  const buildState: ReadinessStages["build"]["state"] = build.some(({ result }) => result === "failed")
    ? "failed"
    : runningBuild !== undefined
    ? "running"
    : queuedBuild !== undefined
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
    const current = readinessObservationIsCurrent(deployment)
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
        productionState = current ? "not-started" : "held"
        break
    }
  }

  return {
    build: {
      state: buildState,
      factIds: sortedReadinessUnique(build.map(({ definition }) => definition.factId)),
      evidenceIds: stageEvidence(build),
      progress: observationProgress(
        runningBuild?.observation ?? queuedBuild?.observation ?? undefined
      )
    },
    verify: {
      state: verifyState,
      factIds: sortedReadinessUnique(verify.map(({ definition }) => definition.factId)),
      evidenceIds: stageEvidence(verify),
      progress: null
    },
    production: {
      state: productionState,
      factIds: sortedReadinessUnique(production.map(({ definition }) => definition.factId)),
      evidenceIds: stageEvidence(production),
      progress: observationProgress(deployment ?? undefined)
    }
  }
}

/** Derive the canonical verdict from facts, findings, and exact stage state. */
export const deriveEnvironmentReadinessVerdict = (input: {
  readonly blockers: ReadonlyArray<ReadinessFinding>
  readonly facts: ReadonlyArray<ReadinessFactEvaluation>
  readonly gaps: ReadonlyArray<ReadinessFinding>
  readonly stages: ReadinessStages
}): ReadinessVerdict => {
  if (input.blockers.length > 0) return "blocked"
  if (input.stages.production.state === "deploying") return "deploying"
  if (
    input.facts.some(({ definition, observation }) => readinessObservationIsDeliveryActivity(definition, observation))
  ) return "building"
  if (
    input.gaps.length > 0 ||
    input.stages.build.state === "held" ||
    input.stages.verify.state === "held" ||
    input.stages.production.state === "held" ||
    input.facts.some(({ definition, result }) => definition.requirement === "required" && result !== "verified")
  ) return "held"
  return input.stages.production.state === "succeeded" ? "shipped" : "ready"
}

type ReleaseEnvironmentReadiness = {
  readonly environmentId: string
  readonly stages: ReadinessStages
  readonly verdict: ReadinessVerdict
}

const firstReleaseProgress = (
  environments: ReadonlyArray<ReleaseEnvironmentReadiness>,
  stage: "build" | "production"
): ReadinessProgress | null =>
  environments
    .slice()
    .sort((left, right) => compareReadinessText(left.environmentId, right.environmentId))
    .find((environment) => environment.stages[stage].progress !== null)?.stages[stage].progress ?? null

/** Exact three-stage roll-up implied by retained environment summaries. */
export const deriveReleaseReadinessStages = (
  environments: ReadonlyArray<ReleaseEnvironmentReadiness>
): ReadinessStages => {
  const buildStates = environments.map(({ stages }) => stages.build.state)
  const verifyStates = environments.map(({ stages }) => stages.verify.state)
  const productionStates = environments.map(({ stages }) => stages.production.state)
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
      factIds: sortedReadinessUnique(environments.flatMap(({ stages }) => stages.build.factIds)),
      evidenceIds: sortedReadinessUnique(environments.flatMap(({ stages }) => stages.build.evidenceIds)),
      progress: firstReleaseProgress(environments, "build")
    },
    verify: {
      state: verifyState,
      factIds: sortedReadinessUnique(environments.flatMap(({ stages }) => stages.verify.factIds)),
      evidenceIds: sortedReadinessUnique(environments.flatMap(({ stages }) => stages.verify.evidenceIds)),
      progress: null
    },
    production: {
      state: productionState,
      factIds: sortedReadinessUnique(environments.flatMap(({ stages }) => stages.production.factIds)),
      evidenceIds: sortedReadinessUnique(environments.flatMap(({ stages }) => stages.production.evidenceIds)),
      progress: firstReleaseProgress(environments, "production")
    }
  }
}

/** Canonical cross-environment precedence for release readiness. */
export const deriveReleaseReadinessVerdict = (
  environments: ReadonlyArray<ReleaseEnvironmentReadiness>
): ReadinessVerdict => {
  const verdicts = environments.map(({ verdict }) => verdict)
  if (verdicts.includes("blocked")) return "blocked"
  if (verdicts.includes("deploying")) return "deploying"
  if (verdicts.includes("building")) return "building"
  if (verdicts.includes("held")) return "held"
  return verdicts.every((verdict) => verdict === "shipped") ? "shipped" : "ready"
}

const sameStringArray = (
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>
): boolean => left.length === right.length && left.every((value, index) => value === right[index])

const progressIsEqual = (
  left: ReadinessProgress | null,
  right: ReadinessProgress | null
): boolean =>
  left === null || right === null
    ? left === right
    : left._tag === "count" && right._tag === "count"
    ? left.completed === right.completed && left.total === right.total
    : left._tag === "percent" && right._tag === "percent" && left.value === right.value

/** Structural equality for canonical stage records without serialization shortcuts. */
export const readinessStagesAreEqual = (
  left: ReadinessStages,
  right: ReadinessStages
): boolean =>
  left.build.state === right.build.state &&
  sameStringArray(left.build.factIds, right.build.factIds) &&
  sameStringArray(left.build.evidenceIds, right.build.evidenceIds) &&
  progressIsEqual(left.build.progress, right.build.progress) &&
  left.verify.state === right.verify.state &&
  sameStringArray(left.verify.factIds, right.verify.factIds) &&
  sameStringArray(left.verify.evidenceIds, right.verify.evidenceIds) &&
  progressIsEqual(left.verify.progress, right.verify.progress) &&
  left.production.state === right.production.state &&
  sameStringArray(left.production.factIds, right.production.factIds) &&
  sameStringArray(left.production.evidenceIds, right.production.evidenceIds) &&
  progressIsEqual(left.production.progress, right.production.progress)
