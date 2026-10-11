/** Assemble V1 readiness facts from persisted, exact delivery evidence. @module */
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import type { ReleaseDeliveryGraphInspection } from "../../api/deliveryGraph.js"
import { confluenceTaskSummary } from "../../domain/confluenceTasks.js"
import {
  type DeliveryEntityProjection,
  type DeliveryRelationship,
  type EvidenceClaim,
  type EvidenceItem,
  LedgerRevision
} from "../../domain/deliveryGraph.js"
import { Freshness } from "../../domain/freshness.js"
import {
  EvidenceClaimId,
  EvidenceId,
  type GraphNodeId,
  type PluginConnectionId,
  ReleaseId,
  WorkspaceId
} from "../../domain/identifiers.js"
import {
  READINESS_RULE_VERSION_V1,
  type ReadinessEvidenceReference,
  ReadinessFactId,
  type ReadinessFactObservation,
  type ReadinessFactState,
  ReadinessGateWaiver,
  ReadinessRuleMaterial
} from "../../domain/readiness/index.js"
import { releasePipelineApprovalReadiness } from "../../domain/releasePipelineApproval.js"
import type { PipelineReleaseTarget, ReleaseTargetCatalog } from "../../domain/releaseTargets.js"
import type { UtcTimestamp } from "../../domain/utcTimestamp.js"
import type { PersistenceService } from "../persistence/Persistence.js"
import { DeliveryGraphWriteBatch } from "../persistence/repositories/deliveryGraphRepository.js"
import type { EntityRecord } from "../persistence/repositories/models.js"
import { PluginStreamKey } from "../persistence/repositories/pluginRuntimeModels.js"
import type {
  WorkspaceSettingsAuditRecord,
  WorkspaceSettingsRecord
} from "../persistence/repositories/workspaceSettingsRepository.js"
import { firstPartySyncStreamKey } from "../plugins/firstPartySynchronization.js"
import { readinessInventoryIsComplete } from "./internal/readinessInventoryComplete.js"
import { stableUuid } from "./internal/stableUuid.js"

/** Safe, tagged diagnostic persisted independently of successful synchronization. */
export class ReadinessEvaluationFailure
  extends Schema.TaggedError<ReadinessEvaluationFailure>()("ReadinessEvaluationFailure", {
    workspaceId: WorkspaceId,
    releaseId: ReleaseId,
    operation: Schema.Literals(["snapshot", "evidence", "derive", "publish"]),
    diagnosticCode: Schema.Literals([
      "readiness-snapshot-invalid",
      "readiness-evidence-invalid",
      "readiness-derivation-invalid",
      "readiness-publication-failed"
    ])
  })
{}

/** One rule shared by all target environments, including explicit audited gate waivers. */
export const deliveryReadinessRule = ReadinessRuleMaterial.make({
  ruleId: "persisted-delivery-v1",
  version: READINESS_RULE_VERSION_V1,
  definitions: [
    { factId: ReadinessFactId.make("jira.membership"), kind: "relationship", requirement: "required" },
    { factId: ReadinessFactId.make("code.implements"), kind: "relationship", requirement: "required" },
    { factId: ReadinessFactId.make("code.merged"), kind: "check", requirement: "required" },
    { factId: ReadinessFactId.make("code.review"), kind: "approval", requirement: "required" },
    { factId: ReadinessFactId.make("pipeline.relationship"), kind: "relationship", requirement: "required" },
    { factId: ReadinessFactId.make("pipeline.build"), kind: "execution", requirement: "required" },
    { factId: ReadinessFactId.make("pipeline.verify"), kind: "check", requirement: "required" },
    { factId: ReadinessFactId.make("pipeline.gate"), kind: "relationship", requirement: "required" },
    { factId: ReadinessFactId.make("runbook.relationship"), kind: "relationship", requirement: "required" },
    { factId: ReadinessFactId.make("runbook.tasks"), kind: "documentation", requirement: "required" },
    { factId: ReadinessFactId.make("production.delivery"), kind: "deployment", requirement: "advisory" }
  ]
})

type PipelineDetails = Extract<DeliveryEntityProjection["details"], { readonly _tag: "pipeline-execution" }>
type Action = NonNullable<PipelineDetails["actions"]>[number]
interface FactContribution {
  readonly projection: DeliveryEntityProjection
  readonly nodeId: GraphNodeId
  readonly record: EntityRecord
}

const current = (relationship: DeliveryRelationship) =>
  relationship.lifecycle._tag !== "superseded" && relationship.lifecycle._tag !== "rejected"

const relationshipState = (
  relationships: ReadonlyArray<DeliveryRelationship>,
  complete: boolean
): ReadinessFactState => {
  if (relationships.some(({ lifecycle }) => lifecycle._tag === "rejected")) {
    return { _tag: "relationship", status: "rejected" }
  }
  if (
    !complete || relationships.length === 0 ||
    relationships.some(({ lifecycle }) => lifecycle._tag === "missing" || lifecycle._tag === "superseded")
  ) return { _tag: "relationship", status: "missing" }
  if (relationships.some(({ lifecycle }) => lifecycle._tag === "proposed")) {
    return { _tag: "relationship", status: "proposed" }
  }
  if (relationships.some(({ lifecycle }) => lifecycle._tag === "inferred")) {
    return { _tag: "relationship", status: "inferred" }
  }
  return { _tag: "relationship", status: "verified" }
}

/** Failures outrank activity; only a complete observed action set can pass. */
const actionOutcome = (
  actions: ReadonlyArray<Action>,
  complete: boolean
): "missing" | "queued" | "running" | "succeeded" | "failed" | "stopped" => {
  if (actions.some(({ status }) => status === "failed")) return "failed"
  if (actions.some(({ status }) => status === "stopped")) return "stopped"
  if (actions.some(({ status }) => status === "running")) return "running"
  if (actions.some(({ status }) => status === "queued")) return "queued"
  return complete && actions.length > 0 && actions.every(({ status }) => status === "succeeded")
    ? "succeeded"
    : "missing"
}

/** Read already-hydrated delivery facts; never contact a provider while holding the snapshot transaction. */
export const assembleReadinessFacts = Effect.fn("ReadinessEvaluation.assembleFacts")(function*(input: {
  readonly persistence: PersistenceService
  readonly workspaceId: WorkspaceId
  readonly releaseId: ReleaseId
  readonly inspection: ReleaseDeliveryGraphInspection
  readonly settings: WorkspaceSettingsRecord
  readonly audits: ReadonlyArray<WorkspaceSettingsAuditRecord>
  readonly catalogue: ReleaseTargetCatalog
  readonly mappings: ReadonlyArray<PipelineReleaseTarget>
  readonly environmentKey: string
  readonly evaluatedAt: UtcTimestamp
  readonly previousObservations: ReadonlyArray<ReadinessFactObservation>
}) {
  const cryptoService = yield* Crypto.Crypto
  const { evaluatedAt, inspection, persistence, releaseId, workspaceId } = input
  const failure = (operation: ReadinessEvaluationFailure["operation"]) =>
    new ReadinessEvaluationFailure({
      workspaceId,
      releaseId,
      operation,
      diagnosticCode: operation === "snapshot"
        ? "readiness-snapshot-invalid"
        : operation === "evidence"
        ? "readiness-evidence-invalid"
        : operation === "derive"
        ? "readiness-derivation-invalid"
        : "readiness-publication-failed"
    })
  const identity = (value: string) =>
    stableUuid(cryptoService, `${workspaceId}\u0000readiness-v1\u0000${value}`, () => failure("evidence"))
  const byNode = new Map<GraphNodeId, FactContribution>()
  const projections = new Map(inspection.entityProjections.map(({ projection }) => [projection.entityId, projection]))
  for (const node of inspection.nodes) {
    if (node.resolution._tag !== "resolved" || node.resolution.target._tag !== "entity") continue
    const projection = projections.get(node.resolution.target.entityId)
    if (projection === undefined || projection.entityState !== "present") continue
    byNode.set(node.nodeId, {
      projection,
      nodeId: node.nodeId,
      record: yield* persistence.entities.get(workspaceId, projection.entityId)
    })
  }
  const sourceConnections = new Map<PluginConnectionId, EntityRecord["sourceRevision"]["providerId"]>()
  let boundedEvidence = false
  let evidenceCount = 0
  const observations: Array<ReadinessFactObservation> = []
  const items = new Map<EvidenceId, EvidenceItem>()
  const claims = new Map<EvidenceClaimId, EvidenceClaim>()
  const evidenceFor = Effect.fn("ReadinessEvaluation.evidenceFor")(
    function*(
      factId: string,
      state: ReadinessFactState,
      contributions: ReadonlyArray<FactContribution>,
      binding: string
    ) {
      const references = new Map<EvidenceId, ReadinessEvidenceReference>()
      for (const contribution of contributions) {
        const { nodeId, projection, record } = contribution
        const source = record.sourceRevision
        sourceConnections.set(source.pluginConnectionId, source.providerId)
        const evidenceId = EvidenceId.make(
          yield* identity(
            `${source.pluginConnectionId}\u0000${projection.entityId}\u0000${source.revision}\u0000${factId}\u0000${binding}\u0000${
              JSON.stringify(state)
            }`
          )
        )
        const runtime = yield* persistence.pluginRuntime.getRuntime(workspaceId, source.pluginConnectionId)
        const stream = PluginStreamKey.make(firstPartySyncStreamKey(source.providerId))
        const attempts = yield* persistence.pluginRuntime.getSyncAttemptState(
          workspaceId,
          source.pluginConnectionId,
          stream
        )
        const expiry = DateTime.add(source.lastObservedAt, {
          minutes: input.settings.settings.synchronization.staleAfterMinutes
        })
        const health = runtime.health._tag
        const freshness = health === "unavailable" || health === "disabled" ?
          "unavailable" :
          health === "degraded" || attempts.latestAttempt?.outcome === null || DateTime.Order(evaluatedAt, expiry) >= 0
          ? "stale"
          : "current"
        const previous = input.previousObservations.flatMap(({ evidence }) => evidence).find((reference) =>
          reference.evidenceId === evidenceId
        )
        const reevaluateAt = previous?.reevaluateAt !== undefined && previous.reevaluateAt !== null &&
            DateTime.Order(previous.reevaluateAt, evaluatedAt) > 0
          ? previous.reevaluateAt
          : DateTime.Order(expiry, evaluatedAt) > 0
          ? expiry
          : null
        references.set(evidenceId, {
          evidenceId,
          source: { _tag: "plugin", pluginConnectionId: source.pluginConnectionId, health },
          freshness,
          validity: "valid",
          reevaluateAt
        })
        const existing = yield* persistence.deliveryGraph.read(workspaceId, { _tag: "evidence", evidenceId, limit: 1 })
          .pipe(Effect.catchTag("RecordNotFoundError", () => Effect.succeed(null)))
        if (existing !== null || items.has(evidenceId)) continue
        const lastSuccessfulHealth = yield* persistence.pluginRuntime.getLastSuccessfulHealth(
          workspaceId,
          source.pluginConnectionId,
          stream
        )
        if (lastSuccessfulHealth === null) return yield* failure("evidence")
        const old = DateTime.Order(evaluatedAt, expiry) >= 0
        const freshnessEnvelope = yield* Schema.decodeUnknownEffect(Schema.toType(Freshness))({
          _tag: old ? "stale" : "current",
          evaluatedAt,
          pluginHealth: lastSuccessfulHealth,
          provenance: old
            ? { _tag: "cache", cachedAt: source.synchronizedAt, sourceRevision: source }
            : { _tag: "provider", sourceRevision: source },
          sourceObservedAt: source.lastObservedAt,
          synchronizedAt: source.synchronizedAt,
          staleAfterSeconds: input.settings.settings.synchronization.staleAfterMinutes * 60
        })
        items.set(evidenceId, {
          workspaceId,
          evidenceId,
          schemaVersion: 1,
          attribution: {
            _tag: "plugin",
            pluginConnectionId: source.pluginConnectionId,
            sourceEntityId: projection.entityId,
            sourceEntityRevision: LedgerRevision.make(record.revision)
          },
          verifier: { _tag: "system", component: "readiness-evaluation" },
          observedAt: source.lastObservedAt,
          recordedAt: evaluatedAt,
          validUntil: null,
          freshness: freshnessEnvelope,
          retention: {
            classification: "evidence",
            retainUntil: DateTime.add(evaluatedAt, { days: input.settings.settings.retention.evidenceDays }),
            legalHold: false
          }
        })
        const evidenceClaimId = EvidenceClaimId.make(yield* identity(`claim\u0000${evidenceId}\u0000${nodeId}`))
        claims.set(evidenceClaimId, {
          workspaceId,
          evidenceClaimId,
          evidenceId,
          subjectNodeId: nodeId,
          predicate: "status-observed",
          value: { _tag: "state", value: `${factId}: ${state.status}` },
          recordedAt: evaluatedAt,
          supersedesEvidenceClaimId: null
        })
      }
      return [...references.values()].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId))
    }
  )
  const observe = Effect.fn("ReadinessEvaluation.observe")(
    function*(factId: string, state: ReadinessFactState, contributions: ReadonlyArray<FactContribution>, binding = "") {
      const unique = [...new Map(contributions.map((entry) => [entry.projection.entityId, entry])).values()]
        .sort((left, right) => left.projection.entityId.localeCompare(right.projection.entityId))
      const maximum = Math.min(128, 500 - evidenceCount)
      boundedEvidence ||= unique.length > maximum
      const evidence = yield* evidenceFor(factId, state, unique.slice(0, maximum), binding)
      evidenceCount += evidence.length
      observations.push({ factId: ReadinessFactId.make(factId), state, evidence })
    }
  )
  const relationships = inspection.relationships.filter(current)
  const members = relationships.filter(({ kind, sourceNodeKind, targetNodeKind }) =>
    kind === "contains" && sourceNodeKind === "release" && targetNodeKind === "issue"
  )
  const issues = members.flatMap(({ targetNodeId }) => {
    const issue = byNode.get(targetNodeId)
    return issue === undefined ? [] : [issue]
  })
  const implementations = relationships.filter(({ kind, targetNodeId }) =>
    kind === "implements" && issues.some(({ nodeId }) => nodeId === targetNodeId)
  )
  const pullRequests = implementations.flatMap(({ sourceNodeId }) => {
    const pr = byNode.get(sourceNodeId)
    return pr?.projection.details._tag === "pull-request" ? [pr] : []
  })
  const membershipComplete = members.length === issues.length &&
    issues.every(({ projection }) =>
      projection.details._tag === "issue" && projection.details.fixVersions !== undefined &&
      !(projection.details.truncatedFields?.includes("fixVersions") ?? false)
    )
  yield* observe(
    "jira.membership",
    relationshipState(members, membershipComplete),
    issues,
    members.map(({ lifecycle, relationshipId, revision }) => `${relationshipId}:${revision}:${lifecycle._tag}`).sort()
      .join("|")
  )
  yield* observe(
    "code.implements",
    relationshipState(
      implementations,
      issues.length > 0 && issues.every(({ nodeId }) =>
        implementations.some(({ targetNodeId }) => targetNodeId === nodeId)
      ) && implementations.length === pullRequests.length
    ),
    [...issues, ...pullRequests],
    implementations.map(({ lifecycle, relationshipId, revision }) => `${relationshipId}:${revision}:${lifecycle._tag}`)
      .sort().join("|")
  )
  const merged = pullRequests.length > 0 &&
    pullRequests.every(({ projection }) =>
      projection.details._tag === "pull-request" && projection.details.lifecycle === "merged"
    )
  yield* observe("code.merged", { _tag: "check", status: merged ? "passed" : "missing" }, pullRequests)
  yield* observe("code.review", { _tag: "approval", status: merged ? "approved" : "missing" }, pullRequests)
  const delivery = relationships.filter(({ kind, sourceNodeId }) =>
    kind === "delivered-by" && pullRequests.some(({ nodeId }) => nodeId === sourceNodeId)
  )
  const pipelineCandidates = delivery.flatMap(({ targetNodeId }) => {
    const pipeline = byNode.get(targetNodeId)
    return pipeline?.projection.details._tag === "pipeline-execution" ? [pipeline] : []
  })
  const pipelines = [...new Map(pipelineCandidates.map((entry) => [entry.nodeId, entry])).values()]
  const selected = pipelines.flatMap((pipeline) =>
    input.mappings.flatMap((mapping) => {
      const details = pipeline.projection.details
      if (
        details._tag !== "pipeline-execution" ||
        mapping.pluginConnectionId !== pipeline.record.sourceRevision.pluginConnectionId ||
        mapping.pipelineName !== details.pipelineName
      ) return []
      const range = mapping.environments.find(({ key }) => key === input.environmentKey)
      const catalogue = input.catalogue.pipelines.find((entry) =>
        entry.pluginConnectionId === mapping.pluginConnectionId && entry.pipelineName === mapping.pipelineName
      )
      return range === undefined || catalogue === undefined ? [] : [{ pipeline, details, mapping, range, catalogue }]
    })
  )
  let complete = !inspection.truncated && input.catalogue.complete && selected.length > 0
  yield* observe(
    "pipeline.relationship",
    relationshipState(
      delivery,
      pullRequests.length > 0 &&
        pullRequests.every(({ nodeId }) =>
          delivery.some(({ sourceNodeId, targetNodeId }) =>
            sourceNodeId === nodeId && selected.some(({ pipeline }) => pipeline.nodeId === targetNodeId)
          )
        )
    ),
    [...pullRequests, ...selected.map(({ pipeline }) => pipeline)],
    delivery.map(({ lifecycle, relationshipId, revision }) => `${relationshipId}:${revision}:${lifecycle._tag}`).sort()
      .join("|")
  )
  const builds: Array<Action> = []
  const checks: Array<Action> = []
  const deployments: Array<Action> = []
  let buildComplete = true
  let verifyComplete = true
  let deployDeclared = false
  let deployComplete = true
  let gatePresent = true
  let requiresGate = false
  for (const { catalogue, details, mapping, pipeline, range } of selected) {
    const first = catalogue.stages.findIndex(({ name }) => name === range.firstStage)
    const last = catalogue.stages.findIndex(({ name }) => name === range.lastStage)
    const topologyCurrent = catalogue.state === "current" && mapping.topologyDigest === catalogue.topologyDigest &&
      first >= 0 && last >= first
    complete &&= topologyCurrent && details.actionsTruncated === false
    const prefix = catalogue.stages.slice(0, last + 1)
    const rangeStages = catalogue.stages.slice(first, last + 1)
    const declared = prefix.flatMap((stage) => stage.actions.map((action) => ({ stageName: stage.name, ...action })))
    const actions = details.actions ?? []
    const category = (value: string, names: ReadonlyArray<string>) =>
      declared.filter((action) => action.category === value && names.includes(action.stageName))
    const observeActions = (definitions: ReadonlyArray<typeof declared[number]>, target: Array<Action>): boolean => {
      let complete = definitions.length > 0
      for (const definition of definitions) {
        const observed = actions.filter(({ actionName, stageName }) =>
          stageName === definition.stageName && actionName === definition.name
        )
        for (const action of observed) target.push(action)
        complete &&= observed.length === 1
      }
      return complete
    }
    buildComplete = observeActions([
      ...category(
        "Source",
        prefix.map(({ name }) => name)
      ),
      ...category("Build", prefix.map(({ name }) => name))
    ], builds) && buildComplete
    verifyComplete = observeActions(category("Test", prefix.map(({ name }) => name)), checks) && verifyComplete
    const deployDefinitions = category("Deploy", rangeStages.map(({ name }) => name))
    deployDeclared ||= deployDefinitions.length > 0
    deployComplete = observeActions(deployDefinitions, deployments) && deployComplete
    if (range.requiresManualGate) {
      requiresGate = true
      const gates = rangeStages.flatMap((stage) =>
        stage.actions.filter((action) => action.category === "Approval" && action.provider === "Manual")
      )
      const approval = releasePipelineApprovalReadiness(
        inspection,
        new Map([
          [pipeline.projection.entityId, new Set(rangeStages.map(({ name }) => name))]
        ])
      )
      gatePresent &&= gates.length === 1 &&
        approval.gates.some(({ entityId, state }) => entityId === pipeline.projection.entityId && state !== "missing")
    }
  }
  const pipelineContributions = selected.map(({ pipeline }) => pipeline)
  const binding = selected.map(({ mapping, range }) =>
    `${mapping.pluginConnectionId}:${mapping.pipelineName}:${mapping.topologyDigest}:${range.firstStage}:${range.lastStage}:${range.requiresManualGate}`
  ).sort().join("|")
  yield* observe(
    "pipeline.build",
    { _tag: "execution", status: actionOutcome(builds, buildComplete), progress: null },
    pipelineContributions,
    binding
  )
  const check = actionOutcome(checks, verifyComplete)
  yield* observe(
    "pipeline.verify",
    { _tag: "check", status: check === "succeeded" ? "passed" : check === "stopped" ? "cancelled" : check },
    pipelineContributions,
    binding
  )
  if (!requiresGate && selected.length > 0) {
    const audit = [...input.audits].reverse().find(({ changedSections, governed }) =>
      governed && changedSections.includes("pipeline")
    )
    if (audit === undefined) yield* observe("pipeline.gate", { _tag: "relationship", status: "missing" }, [], binding)
    else {
      const waiver = yield* Schema.decodeUnknownEffect(Schema.toType(ReadinessGateWaiver))({
        settingsRevision: audit.toRevision,
        settingsAuditId: audit.mutationId,
        settingsDigest: `sha256:${audit.afterDigest}`,
        topologyDigest: selected[0]?.mapping.topologyDigest,
        auditedAt: audit.occurredAt
      })
      yield* observe(
        "pipeline.gate",
        { _tag: "relationship", status: "waived", waiver },
        pipelineContributions,
        `${binding}:${audit.requestDigest}`
      )
    }
  } else {yield* observe(
      "pipeline.gate",
      { _tag: "relationship", status: requiresGate && gatePresent ? "verified" : "missing" },
      pipelineContributions,
      binding
    )}
  const runbookLinks = relationships.filter(({ kind, sourceNodeKind }) =>
    kind === "documented-by" && sourceNodeKind === "release"
  )
  const runbooks = runbookLinks.flatMap(({ targetNodeId }) => {
    const page = byNode.get(targetNodeId)
    return page?.projection.details._tag === "page" ? [page] : []
  })
  yield* observe(
    "runbook.relationship",
    relationshipState(runbookLinks, runbookLinks.length === runbooks.length),
    runbooks,
    runbookLinks.map(({ lifecycle, relationshipId, revision }) => `${relationshipId}:${revision}:${lifecycle._tag}`)
      .sort().join("|")
  )
  const resolvedRunbooks = runbooks.length > 0 &&
    runbooks.every(({ projection }) =>
      projection.details._tag === "page" && projection.details.contentState === "loaded" &&
      projection.details.content !== null && projection.details.content !== undefined
    )
  const tasksComplete = resolvedRunbooks &&
    runbooks.every(({ projection }) =>
      projection.details._tag === "page" && projection.details.content !== null &&
      projection.details.content !== undefined &&
      confluenceTaskSummary(projection.details.content.markdown).outstanding === 0
    )
  yield* observe("runbook.tasks", {
    _tag: "documentation",
    status: !resolvedRunbooks ? "missing" : tasksComplete ? "current" : "draft"
  }, runbooks)
  const deployment = actionOutcome(deployments, deployComplete)
  const deploymentStatus = deployment === "failed" || deployment === "stopped"
    ? "failed"
    : deployment === "running"
    ? "deploying"
    : deployment === "succeeded"
    ? "succeeded"
    : "not-started"
  complete &&= deployDeclared && resolvedRunbooks && (deployments.length === 0 || deployComplete)
  yield* observe(
    "production.delivery",
    { _tag: "deployment", status: deploymentStatus, progress: null },
    pipelineContributions,
    binding
  )
  const inventories = yield* Effect.forEach(
    [...sourceConnections],
    ([pluginConnectionId, providerId]) =>
      Effect.gen(function*() {
        const stream = yield* persistence.pluginRuntime.getStream(
          workspaceId,
          pluginConnectionId,
          PluginStreamKey.make(firstPartySyncStreamKey(providerId))
        )
        return yield* readinessInventoryIsComplete(stream).pipe(Effect.mapError(() => failure("snapshot")))
      })
  )
  const inventoriesComplete = inventories.every((complete) => complete)
  if (items.size > 0) {
    const batch = yield* Schema.encodeEffect(DeliveryGraphWriteBatch)({
      entityProjections: [],
      nodes: [],
      relationships: [],
      evidenceItems: [...items.values()],
      evidenceClaims: [...claims.values()]
    })
    yield* persistence.deliveryGraph.write(workspaceId, batch)
  }
  const headRevisions = [
    ...new Set(
      pullRequests.flatMap(({ projection }) =>
        projection.details._tag === "pull-request" ? [projection.details.headRevision] : []
      )
    )
  ].sort()
  const artifactRevision = headRevisions.join("+")
  return {
    complete: complete && membershipComplete && inventoriesComplete && !boundedEvidence,
    observations,
    artifactRevision: artifactRevision.length > 512
      ? `head-set:${yield* identity(artifactRevision)}`
      : artifactRevision.length === 0
      ? "unresolved"
      : artifactRevision
  }
})
