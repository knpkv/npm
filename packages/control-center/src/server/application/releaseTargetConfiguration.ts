import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import { Hex } from "effect/encoding"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import type { ReleaseDeliveryGraphInspection } from "../../api/deliveryGraph.js"
import { EnvironmentId, type ReleaseId, type WorkspaceId } from "../../domain/identifiers.js"
import { NormalizedPluginEventV1 } from "../../domain/plugins/events.js"
import type { Release } from "../../domain/release.js"
import {
  type PipelineReleaseTarget,
  PipelineTopologyDigest,
  ReleaseTargetCatalog,
  ReleaseTargetConfiguration,
  type ReleaseTargetPipeline
} from "../../domain/releaseTargets.js"
import type { UtcTimestamp } from "../../domain/utcTimestamp.js"
import type { WorkspaceSettingsV1 } from "../../domain/workspaceSettings.js"
import { PersistenceOperationError } from "../persistence/errors.js"
import { Persistence, type PersistenceOperationFailure, type PersistenceService } from "../persistence/Persistence.js"
import { PluginStreamKey } from "../persistence/repositories/pluginRuntimeModels.js"
import { firstPartySyncStreamKey } from "../plugins/firstPartySynchronization.js"
import { stableUuid } from "./internal/stableUuid.js"
import { appendPortfolioInvalidation } from "./portfolioInvalidation.js"

const Definition = Schema.Struct({
  pipelineName: Schema.String,
  sampledAt: Schema.String,
  stages: Schema.Array(Schema.Struct({
    name: Schema.String,
    actions: Schema.Array(Schema.Struct({
      name: Schema.String,
      actionType: Schema.Struct({ category: Schema.String, provider: Schema.String })
    }))
  }))
})

const hash = Effect.fn("ReleaseTargetConfiguration.hash")(function*(value: string) {
  const cryptoService = yield* Crypto.Crypto
  return Hex.encode(
    yield* cryptoService.digest("SHA-256", new TextEncoder().encode(value)).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "release-targets.digest" }))
    )
  )
})

/** Stable environment identity scoped to workspace and key, independent of display name. */
export const releaseEnvironmentId = Effect.fn("ReleaseTargetConfiguration.environmentId")(function*(
  workspaceId: WorkspaceId,
  key: string
) {
  const cryptoService = yield* Crypto.Crypto
  const identity = yield* stableUuid(
    cryptoService,
    `${workspaceId}\u0000release-environment-v1\u0000${key}`,
    (operation) => new PersistenceOperationError({ operation: `release-targets.${operation}` })
  )
  return EnvironmentId.make(identity)
})

/** Read only safe ordered topology from durable followed-pipeline snapshots. */
export const readReleaseTargetCatalog = Effect.fn("ReleaseTargetConfiguration.catalog")(function*(
  persistence: PersistenceService,
  workspaceId: WorkspaceId,
  settings: WorkspaceSettingsV1
) {
  const connections = yield* persistence.pluginConnections.list(workspaceId)
  const now = yield* DateTime.now
  const pipelines: Array<ReleaseTargetPipeline> = []
  let complete = true
  for (const connection of connections.filter(({ providerId }) => providerId === "codepipeline")) {
    const runtime = yield* persistence.pluginRuntime.getRuntime(workspaceId, connection.pluginConnectionId).pipe(
      Effect.catchTag("RecordNotFoundError", () => Effect.succeed(null))
    )
    const definitions = yield* persistence.pluginRuntime.getCodePipelineDefinitions(
      workspaceId,
      connection.pluginConnectionId,
      PluginStreamKey.make(firstPartySyncStreamKey("codepipeline"))
    )
    const attempts = yield* persistence.pluginRuntime.getSyncAttemptState(
      workspaceId,
      connection.pluginConnectionId,
      PluginStreamKey.make(firstPartySyncStreamKey("codepipeline"))
    )
    complete = complete && !definitions.truncated
    for (const record of definitions.records) {
      if (pipelines.length >= 100) {
        complete = false
        break
      }
      const event = Schema.decodeUnknownResult(Schema.fromJsonString(NormalizedPluginEventV1))(record.payloadJson)
      if (Result.isFailure(event) || event.success._tag !== "UpsertEntity") {
        complete = false
        continue
      }
      const decoded = Schema.decodeUnknownResult(Definition)(event.success.attributes)
      if (Result.isFailure(decoded)) {
        complete = false
        continue
      }
      const value = decoded.success
      const stages = value.stages.map((stage) => ({
        name: stage.name,
        actions: stage.actions.map((action) => ({
          name: action.name,
          category: action.actionType.category,
          provider: action.actionType.provider
        }))
      }))
      const digest = PipelineTopologyDigest.make(`sha256:${yield* hash(JSON.stringify(stages))}`)
      const unavailable = !connection.isEnabled || runtime === null || runtime.health._tag === "unavailable" ||
        runtime.health._tag === "disabled"
      const completedAt = attempts.latestSynchronized?.completedAt
      const observedAt =
        completedAt !== undefined && completedAt !== null && DateTime.Order(completedAt, record.cachedAt) > 0
          ? completedAt :
          record.cachedAt
      const stale = runtime?.health._tag === "degraded" ||
        DateTime.toEpochMillis(now) - DateTime.toEpochMillis(observedAt) >=
          settings.synchronization.staleAfterMinutes * 60_000
      pipelines.push({
        pluginConnectionId: connection.pluginConnectionId,
        displayName: connection.displayName,
        pipelineName: value.pipelineName,
        topologyDigest: digest,
        stages,
        observedAt,
        state: unavailable ? "unavailable" : stale ? "stale" : "current"
      })
    }
  }
  return yield* Schema.decodeUnknownEffect(Schema.toType(ReleaseTargetCatalog))({ complete, pipelines }).pipe(
    Effect.mapError(() => new PersistenceOperationError({ operation: "release-targets.catalogue" }))
  )
})

/** Exact current delivery edges select pipeline identities, independent of their settings validity. */
const deliveringPipelineKeys = Effect.fn("ReleaseTargetConfiguration.deliveringPipelines")(function*(
  persistence: PersistenceService,
  release: Release,
  inspection: ReleaseDeliveryGraphInspection
) {
  const nodes = new Map(inspection.nodes.map((node) => [node.nodeId, node]))
  const projections = new Map(inspection.entityProjections.map(({ projection }) => [projection.entityId, projection]))
  const delivering = new Set<string>()
  for (const relationship of inspection.relationships) {
    if (
      relationship.kind !== "delivered-by" || relationship.sourceNodeKind !== "pull-request" ||
      relationship.lifecycle._tag === "missing" || relationship.lifecycle._tag === "rejected" ||
      relationship.lifecycle._tag === "superseded"
    ) continue
    const node = nodes.get(relationship.targetNodeId)
    if (node?.resolution._tag !== "resolved" || node.resolution.target._tag !== "entity") continue
    const projection = projections.get(node.resolution.target.entityId)
    if (projection?.entityState !== "present" || projection.details._tag !== "pipeline-execution") continue
    const entity = yield* persistence.entities.get(release.workspaceId, projection.entityId)
    delivering.add(`${entity.sourceRevision.pluginConnectionId}\u0000${projection.details.pipelineName}`)
  }
  return delivering
})

/** Resolve only pipelines actually delivering a release PR, retaining stale policy as a held state. */
export const inspectReleaseTargets = Effect.fn("ReleaseTargetConfiguration.inspect")(function*(
  persistence: PersistenceService,
  release: Release,
  inspection: ReleaseDeliveryGraphInspection,
  mappings: ReadonlyArray<PipelineReleaseTarget>,
  catalogue: ReleaseTargetCatalog
) {
  const delivering = yield* deliveringPipelineKeys(persistence, release, inspection)
  const selected = mappings.filter((mapping) =>
    delivering.has(`${mapping.pluginConnectionId}\u0000${mapping.pipelineName}`)
  )
  const targets = new Map<string, ReleaseTargetConfiguration["targets"][number]>()
  let stale = false
  let unavailable = inspection.truncated || !catalogue.complete
  for (const mapping of selected) {
    const pipeline = catalogue.pipelines.find((entry) =>
      entry.pluginConnectionId === mapping.pluginConnectionId &&
      entry.pipelineName === mapping.pipelineName
    )
    unavailable ||= pipeline === undefined || pipeline.state === "unavailable"
    stale ||= pipeline?.state === "stale" || pipeline?.topologyDigest !== mapping.topologyDigest
    for (const range of mapping.environments) {
      targets.set(range.key, {
        key: range.key,
        name: range.name,
        environmentId: yield* releaseEnvironmentId(release.workspaceId, range.key)
      })
    }
  }
  unavailable ||= targets.size > 50
  const state = targets.size === 0 ? "unconfigured" : unavailable ? "unavailable" : stale ? "stale" : "configured"
  return ReleaseTargetConfiguration.make({
    state,
    targets: [...targets.values()].slice(0, 50),
    verdict: state === "configured" ? null : "held",
    reason: state === "unconfigured" ? "no-target-environment" : state === "unavailable" ?
      "pipeline-unavailable" :
      state === "stale"
      ? "stale-topology"
      : null
  })
})

/** Reconcile configured release targets transactionally, preserving retired targets and assessment history. */
export const reconcileReleaseTargets = Effect.fn("ReleaseTargetConfiguration.reconcile")(function*(
  persistence: PersistenceService,
  workspaceId: WorkspaceId,
  settings: WorkspaceSettingsV1,
  occurredAt: UtcTimestamp,
  changedMappings: ReadonlyArray<PipelineReleaseTarget> = []
): Effect.fn.Return<void, PersistenceOperationFailure, Crypto.Crypto> {
  const catalogue = yield* readReleaseTargetCatalog(persistence, workspaceId, settings)
  let after: ReleaseId | null = null
  do {
    const page: Effect.Success<ReturnType<PersistenceService["releases"]["listForReconciliation"]>> = yield* persistence
      .releases.listForReconciliation(workspaceId, after)
    for (const record of page.records) {
      const source = record.release.sourceRevisions.find(({ providerId }) => providerId === "jira")
      if (source === undefined) continue
      const result = yield* persistence.deliveryGraph.read(workspaceId, {
        _tag: "releaseSlice",
        releaseId: record.release.id,
        environmentId: null,
        limit: 500
      })
      if (result._tag !== "releaseSlice") continue
      const configuration = yield* inspectReleaseTargets(
        persistence,
        record.release,
        result.value,
        settings.pipeline.releaseTargets ?? [],
        catalogue
      )
      // An incomplete slice cannot authorize retiring targets absent from its bounded prefix.
      if (result.value.truncated || !catalogue.complete || configuration.state === "unavailable") continue
      const desired = configuration.targets.map(({ environmentId }) => environmentId).sort()
      const delivering = yield* deliveringPipelineKeys(persistence, record.release, result.value)
      if (
        changedMappings.some((mapping) => delivering.has(`${mapping.pluginConnectionId}\u0000${mapping.pipelineName}`))
      ) {
        for (const environmentId of record.release.targetEnvironmentIds) {
          yield* persistence.readiness.enqueueInvalidation({
            _tag: "environment",
            workspaceId,
            releaseId: record.release.id,
            environmentId,
            reason: "candidate-changed",
            enqueuedAt: occurredAt
          })
        }
        yield* persistence.readiness.enqueueInvalidation({
          _tag: "release",
          workspaceId,
          releaseId: record.release.id,
          reason: "candidate-changed",
          enqueuedAt: occurredAt
        })
      }
      if (JSON.stringify([...record.release.targetEnvironmentIds].sort()) === JSON.stringify(desired)) continue
      yield* persistence.releases.append(workspaceId, {
        ...record.release,
        targetEnvironmentIds: desired,
        roleAssignments: record.release.roleAssignments.filter(({ scope }) =>
          scope._tag !== "environment" || desired.includes(scope.environmentId)
        ),
        updatedAt: occurredAt
      }, record.revision)
      yield* persistence.readiness.enqueueInvalidation({
        _tag: "release",
        workspaceId,
        releaseId: record.release.id,
        reason: "candidate-changed",
        enqueuedAt: occurredAt
      })
      yield* appendPortfolioInvalidation({
        workspaceId,
        releaseId: record.release.id,
        pluginConnectionId: source.pluginConnectionId,
        reason: "release-projection",
        occurredAt
      }).pipe(
        Effect.provideService(Persistence, persistence)
      )
    }
    after = page.nextReleaseId
  } while (after !== null)
})
