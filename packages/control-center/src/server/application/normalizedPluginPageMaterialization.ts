import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import { derivePersonInitials, Person } from "../../domain/actors.js"
import {
  type DeliveryEntityDetails,
  type DeliveryEntityKind,
  type DeliveryNode,
  type DeliveryRelationship,
  EvidencePredicate,
  EvidenceValue,
  LedgerRevision,
  RelationshipKind
} from "../../domain/deliveryGraph.js"
import type { PluginHealth } from "../../domain/freshness.js"
import {
  EntityId,
  EnvironmentId,
  EvidenceClaimId,
  EvidenceId,
  GraphNodeId,
  PersonId,
  type PluginConnectionId,
  RelationshipId,
  ReleaseId,
  type WorkspaceId
} from "../../domain/identifiers.js"
import { NormalizedIssueAttributes } from "../../domain/normalizedIssue.js"
import type { NormalizedPluginEventV1, PluginSyncPageV1 } from "../../domain/plugins/events.js"
import { Release } from "../../domain/release.js"
import { deriveReleaseRelay } from "../../domain/releaseRelay.js"
import { NormalizationSchemaVersion, type ProviderId, VendorImmutableId } from "../../domain/sourceRevision.js"
import { UtcTimestamp } from "../../domain/utcTimestamp.js"
import type { PersistenceOperationFailure, PersistenceService } from "../persistence/Persistence.js"
import { Persistence } from "../persistence/Persistence.js"
import { DeliveryGraphWriteBatch } from "../persistence/repositories/deliveryGraphRepository.js"
import type { EntityRecord } from "../persistence/repositories/models.js"
import type { PluginStreamKey } from "../persistence/repositories/pluginRuntimeModels.js"
import type { PluginConflictFailure } from "../plugins/failures.js"
import {
  type PluginSynchronizationAuthority,
  verifyPluginSynchronizationAuthority
} from "./pluginSynchronizationAuthority.js"
import { materializeRelationshipInference } from "./relationshipInferenceMaterialization.js"

type EntityUpsert = Extract<NormalizedPluginEventV1, { readonly _tag: "UpsertEntity" }>
type EntityTombstone = Extract<NormalizedPluginEventV1, { readonly _tag: "TombstoneEntity" }>
type EvidenceAppend = Extract<NormalizedPluginEventV1, { readonly _tag: "AppendEvidence" }>
type PersonUpsert = Extract<NormalizedPluginEventV1, { readonly _tag: "UpsertPerson" }>
type RelationshipProposal = Extract<NormalizedPluginEventV1, { readonly _tag: "ProposeRelationship" }>

interface RelationshipEndpointResolution {
  readonly entity: EntityRecord | null
  readonly kind: DeliveryRelationship["sourceNodeKind"]
  readonly node: DeliveryNode | null
  readonly nodeId: GraphNodeId
  readonly releaseId: ReleaseId | null
}

const OptionalText = Schema.optionalKey(Schema.NullOr(Schema.String))
const OptionalUnknown = Schema.optionalKey(Schema.NullOr(Schema.Unknown))
const NamedText = Schema.Union([
  Schema.String,
  Schema.Struct({ name: Schema.optionalKey(Schema.NullOr(Schema.String)) })
])
const EntityAttributes = Schema.Struct({
  key: OptionalText,
  status: Schema.optionalKey(Schema.NullOr(NamedText)),
  priority: Schema.optionalKey(Schema.NullOr(NamedText)),
  estimatePoints: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  repository: OptionalText,
  sourceBranch: OptionalText,
  targetBranch: OptionalText,
  headRevision: OptionalText,
  baseRevision: OptionalText,
  mergeBase: OptionalText,
  description: OptionalText,
  authorArn: OptionalText,
  creationDate: OptionalUnknown,
  lastActivityDate: OptionalUnknown,
  reviewState: OptionalText,
  spaceKey: OptionalText,
  spaceId: OptionalText,
  currentVersion: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  linkedIssueKeys: Schema.optionalKey(Schema.Array(Schema.String)),
  linkedReleaseVersions: Schema.optionalKey(Schema.Array(Schema.String)),
  pipelineName: OptionalText,
  executionId: OptionalText,
  triggerRevision: OptionalText,
  sourceRevisions: Schema.optionalKey(Schema.Array(Schema.Struct({ revisionId: OptionalText }))),
  environmentId: OptionalText,
  revision: OptionalText,
  durationMinutes: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  billable: Schema.optionalKey(Schema.Boolean),
  approvalState: OptionalText,
  interval: Schema.optionalKey(Schema.Struct({
    duration: OptionalText,
    state: OptionalText
  }))
})
const LegacyIssueAttributes = Schema.Struct({
  key: OptionalText,
  status: Schema.optionalKey(Schema.NullOr(NamedText)),
  priority: Schema.optionalKey(Schema.NullOr(NamedText)),
  estimatePoints: Schema.optionalKey(Schema.NullOr(Schema.Number))
})
const LegacyIssueAttributeKeys: ReadonlySet<string> = new Set([
  "key",
  "status",
  "priority",
  "estimatePoints",
  "schemaVersion",
  "summary"
])
const ReleaseAttributes = Schema.Struct({
  serviceName: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200)),
  version: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(100)),
  lifecycle: Schema.Literals(["assembling", "candidate", "deploying", "released", "cancelled"])
})
const JiraIssueRelationshipSnapshot = Schema.Struct({
  fixVersions: Schema.Array(Schema.Struct({
    sourceId: Schema.NullOr(Schema.String)
  })),
  truncatedFields: Schema.Array(Schema.String)
})
const EvidenceData = Schema.Struct({
  predicate: Schema.optionalKey(EvidencePredicate),
  value: Schema.optionalKey(EvidenceValue)
})

/** Redacted failure raised before a normalized page can become a canonical projection. */
export class NormalizedPluginPageMaterializationError extends Schema.TaggedErrorClass<
  NormalizedPluginPageMaterializationError
>()("NormalizedPluginPageMaterializationError", {
  diagnosticCode: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(100)),
  eventId: Schema.NullOr(Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512)))
}) {}

const malformed = (diagnosticCode: string, eventId: string | null = null) =>
  new NormalizedPluginPageMaterializationError({ diagnosticCode, eventId })

const decodedAttributes = Effect.fn("NormalizedPluginPageMaterialization.decodeAttributes")(function*(
  event: EntityUpsert
) {
  return yield* Schema.decodeUnknownEffect(EntityAttributes)(event.attributes).pipe(
    Effect.mapError(() => malformed("normalized-entity-attributes-invalid", event.eventId))
  )
})

const bounded = (value: string | null | undefined, fallback: string, maximum: number): string => {
  const normalized = value?.trim()
  return (normalized === undefined || normalized.length === 0 ? fallback : normalized).slice(0, maximum)
}

const optionalBounded = (value: string | null | undefined, maximum: number): string | null => {
  const normalized = value?.trim()
  return normalized === undefined || normalized.length === 0 ? null : normalized.slice(0, maximum)
}

const namedText = (value: typeof NamedText.Type | null | undefined): string | null =>
  typeof value === "string" ? value : (value?.name ?? null)

const decodedPullRequestTimestamp = Effect.fn(
  "NormalizedPluginPageMaterialization.decodePullRequestTimestamp"
)(function*(
  value: unknown,
  eventId: string
): Effect.fn.Return<UtcTimestamp | null, NormalizedPluginPageMaterializationError> {
  if (value === null || value === undefined) return null
  return yield* Schema.decodeUnknownEffect(UtcTimestamp)(value).pipe(
    Effect.mapError(() => malformed("normalized-pull-request-timestamp-invalid", eventId))
  )
})

const decodedIssueAttributes = Effect.fn("NormalizedPluginPageMaterialization.decodeIssueAttributes")(function*(
  event: EntityUpsert
) {
  const normalized = Schema.decodeUnknownResult(NormalizedIssueAttributes)(event.attributes)
  if (Result.isSuccess(normalized)) return normalized.success
  if (Object.keys(event.attributes).some((key) => !LegacyIssueAttributeKeys.has(key))) {
    return yield* malformed("normalized-issue-attributes-invalid", event.eventId)
  }

  const legacy = yield* Schema.decodeUnknownEffect(LegacyIssueAttributes)(event.attributes).pipe(
    Effect.mapError(() => malformed("normalized-issue-attributes-invalid", event.eventId))
  )
  const key = bounded(legacy.key, event.vendorImmutableId, 100)
  return yield* Schema.decodeUnknownEffect(NormalizedIssueAttributes)({
    key,
    status: bounded(namedText(legacy.status), "unknown", 100),
    priority: legacy.priority === null || legacy.priority === undefined
      ? null
      : bounded(namedText(legacy.priority), "unknown", 100),
    estimatePoints: legacy.estimatePoints ?? null
  }).pipe(Effect.mapError(() => malformed("normalized-issue-attributes-invalid", event.eventId)))
})

const canonicalKind = (entityType: string): typeof DeliveryEntityKind.Type | null => {
  switch (entityType) {
    case "issue":
    case "jira.issue":
      return "issue"
    case "pull-request":
      return "pull-request"
    case "page":
    case "confluence-page":
      return "page"
    case "pipeline-execution":
    case "aws.codepipeline.execution":
      return "pipeline-execution"
    case "deployment":
      return "deployment"
    case "time-entry":
    case "clockify.time-entry":
      return "time-entry"
    default:
      return null
  }
}

const reviewState = (
  value: string | null | undefined
): "approved" | "changes-requested" | "merged" | "not-requested" | "requested" => {
  switch (value?.toLowerCase()) {
    case "requested":
    case "open":
      return "requested"
    case "changes-requested":
    case "changes requested":
      return "changes-requested"
    case "approved":
      return "approved"
    case "merged":
      return "merged"
    default:
      return "not-requested"
  }
}

const pullRequestLifecycle = (value: string | null | undefined): "closed" | "merged" | "open" | null => {
  switch (value?.toLowerCase()) {
    case "open":
      return "open"
    case "closed":
      return "closed"
    case "merged":
      return "merged"
    default:
      return null
  }
}

const pipelineStatus = (
  value: string | null | undefined
): "failed" | "queued" | "running" | "stopped" | "succeeded" => {
  switch (value?.toLowerCase()) {
    case "inprogress":
    case "in-progress":
    case "running":
      return "running"
    case "succeeded":
    case "success":
      return "succeeded"
    case "failed":
    case "failure":
      return "failed"
    case "stopped":
    case "stopping":
    case "superseded":
    case "abandoned":
      return "stopped"
    default:
      return "queued"
  }
}

const isoDurationMinutes = (value: string | null | undefined): number => {
  if (value === null || value === undefined) return 0
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/u.exec(value)
  if (match === null) return 0
  const hours = Number(match[1] ?? 0)
  const minutes = Number(match[2] ?? 0)
  const seconds = Number(match[3] ?? 0)
  return Math.max(0, Math.round(hours * 60 + minutes + seconds / 60))
}

const entityPresentation = Effect.fn("NormalizedPluginPageMaterialization.entityPresentation")(function*(
  event: EntityUpsert,
  kind: typeof DeliveryEntityKind.Type
): Effect.fn.Return<
  { readonly details: DeliveryEntityDetails; readonly displayKey: string },
  NormalizedPluginPageMaterializationError
> {
  const attributes = yield* decodedAttributes(event)
  switch (kind) {
    case "issue": {
      const issueAttributes = yield* decodedIssueAttributes(event)
      return {
        displayKey: issueAttributes.key,
        details: {
          _tag: "issue",
          ...issueAttributes
        }
      }
    }
    case "pull-request": {
      const creationDate = yield* decodedPullRequestTimestamp(attributes.creationDate, event.eventId)
      const lastActivityDate = yield* decodedPullRequestTimestamp(attributes.lastActivityDate, event.eventId)
      return {
        displayKey: bounded(event.vendorImmutableId, event.vendorImmutableId, 200),
        details: {
          _tag: "pull-request",
          repository: bounded(attributes.repository, "unknown", 200),
          sourceBranch: bounded(attributes.sourceBranch, "unknown", 500),
          targetBranch: bounded(attributes.targetBranch, "unknown", 500),
          headRevision: bounded(attributes.headRevision, event.revision, 512),
          reviewState: reviewState(attributes.reviewState),
          lifecycle: pullRequestLifecycle(namedText(attributes.status)),
          description: optionalBounded(attributes.description, 50_000),
          authorReference: optionalBounded(attributes.authorArn, 512),
          baseRevision: optionalBounded(attributes.baseRevision, 512),
          mergeBaseRevision: optionalBounded(attributes.mergeBase, 512),
          createdAt: creationDate === null ? null : DateTime.formatIso(creationDate),
          updatedAt: lastActivityDate === null ? null : DateTime.formatIso(lastActivityDate)
        }
      }
    }
    case "page":
      return {
        displayKey: bounded(event.vendorImmutableId, event.vendorImmutableId, 200),
        details: {
          _tag: "page",
          spaceKey: bounded(attributes.spaceKey ?? attributes.spaceId, "unknown", 100),
          revision: bounded(
            attributes.currentVersion === null || attributes.currentVersion === undefined
              ? attributes.revision
              : String(attributes.currentVersion),
            event.revision,
            512
          ),
          status: namedText(attributes.status)?.toLowerCase() === "superseded" ? "superseded" : "current",
          linkedIssueKeys: attributes.linkedIssueKeys
            ?.map((key) => key.trim())
            .filter((key, index, keys) => key.length > 0 && key.length <= 100 && keys.indexOf(key) === index)
            .slice(0, 100),
          linkedReleaseVersions: attributes.linkedReleaseVersions
            ?.map((version) => version.trim())
            .filter(
              (version, index, versions) =>
                version.length > 0 && version.length <= 100 && versions.indexOf(version) === index
            )
            .slice(0, 100)
        }
      }
    case "pipeline-execution": {
      const executionId = bounded(attributes.executionId, event.vendorImmutableId, 512)
      const pipelineName = bounded(attributes.pipelineName, "unknown", 200)
      const sourceRevision = attributes.sourceRevisions?.find(({ revisionId }) => revisionId !== null)?.revisionId
      return {
        displayKey: bounded(`${pipelineName}/${executionId}`, executionId, 200),
        details: {
          _tag: "pipeline-execution",
          pipelineName,
          executionId,
          status: pipelineStatus(namedText(attributes.status)),
          triggerRevision: bounded(attributes.triggerRevision ?? sourceRevision, event.revision, 512)
        }
      }
    }
    case "deployment": {
      const environmentId = yield* Schema.decodeUnknownEffect(EnvironmentId)(attributes.environmentId).pipe(
        Effect.mapError(() => malformed("normalized-deployment-environment-invalid", event.eventId))
      )
      const status = pipelineStatus(namedText(attributes.status))
      return {
        displayKey: bounded(event.vendorImmutableId, event.vendorImmutableId, 200),
        details: {
          _tag: "deployment",
          environmentId,
          revision: bounded(attributes.revision, event.revision, 512),
          status: status === "queued" ? "pending" : status === "running" ?
            "deploying" :
            status === "stopped"
            ? "rolled-back"
            : status
        }
      }
    }
    case "time-entry":
      return {
        displayKey: bounded(event.vendorImmutableId, event.vendorImmutableId, 200),
        details: {
          _tag: "time-entry",
          durationMinutes: Math.max(
            0,
            Math.round(attributes.durationMinutes ?? isoDurationMinutes(attributes.interval?.duration))
          ),
          billable: attributes.billable ?? false,
          approvalState: attributes.approvalState === "approved" || attributes.approvalState === "rejected"
            ? attributes.approvalState
            : attributes.interval?.state === "running"
            ? "pending"
            : "not-required"
        }
      }
  }
})

const stableUuid = Effect.fn("NormalizedPluginPageMaterialization.stableUuid")(function*(
  cryptoService: Crypto.Crypto,
  identity: string,
  eventId: string
) {
  const bytes = yield* Effect.fromResult(Encoding.decodeBase64(Encoding.encodeBase64(identity))).pipe(
    Effect.mapError(() => malformed("normalized-identity-encoding-failed", eventId))
  )
  const digest = yield* cryptoService.digest("SHA-256", bytes).pipe(
    Effect.mapError(() => malformed("normalized-identity-digest-failed", eventId))
  )
  const hex = Encoding.encodeHex(digest)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
})

const sourceIdentity = (
  scope: NormalizedPluginPageMaterializationScope,
  vendorImmutableId: typeof VendorImmutableId.Type
) => ({
  pluginConnectionId: scope.pluginConnectionId,
  providerId: scope.providerId,
  vendorImmutableId
})

const findEntity = Effect.fn("NormalizedPluginPageMaterialization.findEntity")(function*(
  persistence: PersistenceService,
  scope: NormalizedPluginPageMaterializationScope,
  vendorImmutableId: typeof VendorImmutableId.Type
) {
  const found = yield* persistence.entities.findBySourceIdentity(
    scope.workspaceId,
    sourceIdentity(scope, vendorImmutableId)
  ).pipe(Effect.result)
  if (Result.isSuccess(found)) return found.success
  if (found.failure._tag === "RecordNotFoundError") return null
  return yield* found.failure
})

const readProjection = Effect.fn("NormalizedPluginPageMaterialization.readProjection")(function*(
  persistence: PersistenceService,
  workspaceId: WorkspaceId,
  entityId: EntityId
) {
  const found = yield* persistence.deliveryGraph.read(workspaceId, {
    _tag: "entityProjection",
    entityId,
    revision: null
  }).pipe(Effect.result)
  if (Result.isSuccess(found)) {
    return found.success._tag === "entityProjection" ? found.success.value : null
  }
  if (found.failure._tag === "RecordNotFoundError") return null
  return yield* found.failure
})

const materializationKey = (
  scope: NormalizedPluginPageMaterializationScope,
  kind: string,
  externalId: string
) => `${scope.workspaceId}\u0000${scope.pluginConnectionId}\u0000${scope.providerId}\u0000${kind}\u0000${externalId}`

const entityIdFor = Effect.fn("NormalizedPluginPageMaterialization.entityIdFor")(function*(
  cryptoService: Crypto.Crypto,
  scope: NormalizedPluginPageMaterializationScope,
  vendorImmutableId: string,
  eventId: string
) {
  return EntityId.make(
    yield* stableUuid(
      cryptoService,
      materializationKey(scope, "entity", vendorImmutableId),
      eventId
    )
  )
})

const nodeIdFor = Effect.fn("NormalizedPluginPageMaterialization.nodeIdFor")(function*(
  cryptoService: Crypto.Crypto,
  scope: NormalizedPluginPageMaterializationScope,
  vendorImmutableId: string,
  eventId: string
) {
  return GraphNodeId.make(
    yield* stableUuid(cryptoService, materializationKey(scope, "entity-node", vendorImmutableId), eventId)
  )
})

const releaseIdFor = Effect.fn("NormalizedPluginPageMaterialization.releaseIdFor")(function*(
  cryptoService: Crypto.Crypto,
  scope: NormalizedPluginPageMaterializationScope,
  vendorImmutableId: string,
  eventId: string
) {
  return ReleaseId.make(
    yield* stableUuid(
      cryptoService,
      materializationKey(scope, "release", vendorImmutableId),
      eventId
    )
  )
})

const releaseNodeIdFor = Effect.fn("NormalizedPluginPageMaterialization.releaseNodeIdFor")(function*(
  cryptoService: Crypto.Crypto,
  scope: NormalizedPluginPageMaterializationScope,
  vendorImmutableId: string,
  eventId: string
) {
  return GraphNodeId.make(
    yield* stableUuid(
      cryptoService,
      materializationKey(scope, "release-node", vendorImmutableId),
      eventId
    )
  )
})

const sourceRevision = (
  scope: NormalizedPluginPageMaterializationScope,
  event: EntityUpsert | EntityTombstone,
  firstObservedAt: UtcTimestamp,
  sourceUrl: EntityUpsert["sourceUrl"]
) => ({
  ...sourceIdentity(scope, event.vendorImmutableId),
  revision: event.revision,
  sourceUrl,
  firstObservedAt,
  lastObservedAt: event.observedAt,
  synchronizedAt: scope.committedAt,
  normalizationSchemaVersion: NormalizationSchemaVersion.make(1)
})

const laterTimestamp = (left: UtcTimestamp, right: UtcTimestamp): UtcTimestamp =>
  DateTime.Order(left, right) >= 0 ? left : right

const sameSourceUrl = (
  left: EntityUpsert["sourceUrl"],
  right: EntityUpsert["sourceUrl"]
): boolean => left?.href === right?.href

const projectionSchemaVersion = (kind: DeliveryEntityKind): number => kind === "pull-request" ? 2 : 1

const writeGraph = Effect.fn("NormalizedPluginPageMaterialization.writeGraph")(function*(
  persistence: PersistenceService,
  workspaceId: WorkspaceId,
  batch: typeof DeliveryGraphWriteBatch.Type,
  eventId: string
) {
  const encoded = yield* Schema.encodeEffect(DeliveryGraphWriteBatch)(batch).pipe(
    Effect.mapError(() => malformed("normalized-delivery-graph-batch-invalid", eventId))
  )
  return yield* persistence.deliveryGraph.write(workspaceId, encoded)
})

const materializeUpsertEntity = Effect.fn(
  "NormalizedPluginPageMaterialization.upsertEntity"
)(function*(
  persistence: PersistenceService,
  cryptoService: Crypto.Crypto,
  scope: NormalizedPluginPageMaterializationScope,
  event: EntityUpsert
) {
  const kind = canonicalKind(event.entityType)
  if (kind === null) return { entityProjectionCount: 0, nodeCount: 0, skippedEntityCount: 1 }
  const presentation = yield* entityPresentation(event, kind)
  const existing = yield* findEntity(persistence, scope, event.vendorImmutableId)
  const entityId = existing?.entityId ??
    (yield* entityIdFor(cryptoService, scope, event.vendorImmutableId, event.eventId))
  const currentProjection = existing === null
    ? null
    : yield* readProjection(persistence, scope.workspaceId, entityId)
  const schemaVersion = projectionSchemaVersion(kind)
  if (
    existing !== null &&
    existing.sourceRevision.revision === event.revision &&
    currentProjection?.projection.entityState === "present" &&
    currentProjection.projection.projectionSchemaVersion === schemaVersion
  ) {
    return { entityProjectionCount: 0, nodeCount: 0, skippedEntityCount: 0 }
  }

  const persisted = existing === null
    ? yield* persistence.entities.create(scope.workspaceId, {
      entityId,
      entityType: kind,
      sourceRevision: sourceRevision(scope, event, event.observedAt, event.sourceUrl),
      createdAt: scope.committedAt
    })
    : yield* persistence.entities.updateSourceRevision(scope.workspaceId, entityId, {
      sourceRevision: sourceRevision(
        scope,
        event,
        existing.sourceRevision.firstObservedAt,
        event.sourceUrl
      ),
      expectedRevision: existing.revision,
      updatedAt: scope.committedAt
    })
  const projectionRevision = LedgerRevision.make((currentProjection?.projection.projectionRevision ?? 0) + 1)
  const nodeId = yield* nodeIdFor(cryptoService, scope, event.vendorImmutableId, event.eventId)
  const batch = {
    entityProjections: [{
      projection: {
        workspaceId: scope.workspaceId,
        entityId,
        projectionRevision,
        sourceEntityRevision: LedgerRevision.make(persisted.revision),
        supersedesProjectionRevision: currentProjection?.projection.projectionRevision ?? null,
        projectionSchemaVersion: schemaVersion,
        entityState: "present",
        entityType: kind,
        displayKey: presentation.displayKey,
        title: event.title,
        details: presentation.details
      },
      recordedAt: scope.committedAt
    }],
    nodes: currentProjection === null
      ? [{
        workspaceId: scope.workspaceId,
        nodeId,
        endpointKind: kind,
        resolution: { _tag: "resolved", target: { _tag: "entity", entityId, entityKind: kind } },
        createdAt: scope.committedAt
      }]
      : [],
    evidenceItems: [],
    evidenceClaims: [],
    relationships: []
  } satisfies typeof DeliveryGraphWriteBatch.Type
  const receipt = yield* writeGraph(persistence, scope.workspaceId, batch, event.eventId)
  return { ...receipt, skippedEntityCount: 0 }
})

const materializeRelease = Effect.fn("NormalizedPluginPageMaterialization.upsertRelease")(function*(
  persistence: PersistenceService,
  cryptoService: Crypto.Crypto,
  scope: NormalizedPluginPageMaterializationScope,
  event: EntityUpsert
) {
  const attributes = yield* Schema.decodeUnknownEffect(ReleaseAttributes)(event.attributes).pipe(
    Effect.mapError(() => malformed("normalized-release-attributes-invalid", event.eventId))
  )
  const releaseId = yield* releaseIdFor(cryptoService, scope, event.vendorImmutableId, event.eventId)
  const existing = yield* persistence.releases.get(scope.workspaceId, releaseId).pipe(Effect.result)
  if (Result.isFailure(existing) && existing.failure._tag !== "RecordNotFoundError") {
    return yield* existing.failure
  }
  const previous = Result.isSuccess(existing) ? existing.success : null
  const previousSource = previous?.release.sourceRevisions.find(
    ({ pluginConnectionId, providerId, vendorImmutableId }) =>
      pluginConnectionId === scope.pluginConnectionId &&
      providerId === scope.providerId &&
      vendorImmutableId === event.vendorImmutableId
  )
  const observedAt = previousSource === undefined
    ? event.observedAt
    : laterTimestamp(previousSource.lastObservedAt, event.observedAt)
  const source = sourceRevision(
    scope,
    event,
    previousSource?.firstObservedAt ?? event.observedAt,
    event.sourceUrl
  )
  const refreshedSource = { ...source, lastObservedAt: observedAt }
  const sourceAgeSeconds = Math.max(
    0,
    (DateTime.toEpochMillis(scope.committedAt) - DateTime.toEpochMillis(observedAt)) / 1_000
  )
  const release = yield* Schema.decodeUnknownEffect(Schema.toType(Release))({
    createdAt: previous?.release.createdAt ?? event.observedAt,
    freshness: {
      _tag: "current",
      evaluatedAt: scope.committedAt,
      pluginHealth: scope.successfulHealth,
      provenance: { _tag: "provider", sourceRevision: refreshedSource },
      sourceObservedAt: observedAt,
      staleAfterSeconds: Math.max(1, Math.ceil(sourceAgeSeconds) + 86_400),
      synchronizedAt: scope.committedAt
    },
    id: releaseId,
    lifecycle: attributes.lifecycle,
    relay: deriveReleaseRelay(releaseId),
    roleAssignments: previous?.release.roleAssignments ?? [],
    serviceName: attributes.serviceName,
    sourceRevisions: [
      ...(previous?.release.sourceRevisions.filter(
        ({ pluginConnectionId, providerId, vendorImmutableId }) =>
          pluginConnectionId !== scope.pluginConnectionId ||
          providerId !== scope.providerId ||
          vendorImmutableId !== event.vendorImmutableId
      ) ?? []),
      refreshedSource
    ],
    targetEnvironmentIds: previous?.release.targetEnvironmentIds ?? [],
    updatedAt: scope.committedAt,
    version: attributes.version,
    workspaceId: scope.workspaceId
  }).pipe(Effect.mapError(() => malformed("normalized-release-invalid", event.eventId)))
  if (previous === null) {
    yield* persistence.releases.create(scope.workspaceId, release)
  } else if (
    previousSource === undefined ||
    previousSource.revision !== refreshedSource.revision ||
    !sameSourceUrl(previousSource.sourceUrl, refreshedSource.sourceUrl) ||
    !DateTime.Equivalence(previousSource.lastObservedAt, refreshedSource.lastObservedAt) ||
    !DateTime.Equivalence(previousSource.synchronizedAt, refreshedSource.synchronizedAt) ||
    previous.release.serviceName !== release.serviceName ||
    previous.release.version !== release.version ||
    previous.release.lifecycle !== release.lifecycle
  ) {
    yield* persistence.releases.append(scope.workspaceId, release, previous.revision)
  }
  const nodeId = yield* releaseNodeIdFor(cryptoService, scope, event.vendorImmutableId, event.eventId)
  const existingNode = yield* persistence.deliveryGraph.read(scope.workspaceId, {
    _tag: "node",
    nodeId
  }).pipe(Effect.result)
  if (Result.isSuccess(existingNode)) return { nodeCount: 0 }
  if (existingNode.failure._tag !== "RecordNotFoundError") return yield* existingNode.failure
  const receipt = yield* writeGraph(persistence, scope.workspaceId, {
    entityProjections: [],
    nodes: [{
      workspaceId: scope.workspaceId,
      nodeId,
      endpointKind: "release",
      resolution: { _tag: "resolved", target: { _tag: "release", releaseId } },
      createdAt: scope.committedAt
    }],
    evidenceItems: [],
    evidenceClaims: [],
    relationships: []
  }, event.eventId)
  return { nodeCount: receipt.nodeCount }
})

const materializeTombstoneEntity = Effect.fn(
  "NormalizedPluginPageMaterialization.tombstoneEntity"
)(function*(
  persistence: PersistenceService,
  scope: NormalizedPluginPageMaterializationScope,
  event: EntityTombstone
) {
  const existing = yield* findEntity(persistence, scope, event.vendorImmutableId)
  if (existing === null) return { entityProjectionCount: 0 }
  const current = yield* readProjection(persistence, scope.workspaceId, existing.entityId)
  if (current === null) return yield* malformed("normalized-tombstone-projection-missing", event.eventId)
  if (existing.sourceRevision.revision === event.revision && current.projection.entityState === "deleted") {
    return { entityProjectionCount: 0 }
  }
  const persisted = existing.sourceRevision.revision === event.revision
    ? existing
    : yield* persistence.entities.updateSourceRevision(scope.workspaceId, existing.entityId, {
      sourceRevision: sourceRevision(
        scope,
        event,
        existing.sourceRevision.firstObservedAt,
        existing.sourceRevision.sourceUrl
      ),
      expectedRevision: existing.revision,
      updatedAt: scope.committedAt
    })
  const projectionRevision = LedgerRevision.make(current.projection.projectionRevision + 1)
  const receipt = yield* writeGraph(persistence, scope.workspaceId, {
    entityProjections: [{
      projection: {
        ...current.projection,
        projectionRevision,
        sourceEntityRevision: LedgerRevision.make(persisted.revision),
        supersedesProjectionRevision: current.projection.projectionRevision,
        entityState: "deleted"
      },
      recordedAt: scope.committedAt
    }],
    nodes: [],
    evidenceItems: [],
    evidenceClaims: [],
    relationships: []
  }, event.eventId)
  return { entityProjectionCount: receipt.entityProjectionCount }
})

const materializePerson = Effect.fn("NormalizedPluginPageMaterialization.upsertPerson")(function*(
  persistence: PersistenceService,
  cryptoService: Crypto.Crypto,
  scope: NormalizedPluginPageMaterializationScope,
  event: PersonUpsert
) {
  const identity = {
    pluginConnectionId: scope.pluginConnectionId,
    providerId: scope.providerId,
    vendorPersonId: VendorImmutableId.make(event.vendorPersonId)
  }
  const existing = yield* persistence.people.findPersonBySourceIdentity(scope.workspaceId, identity).pipe(
    Effect.result
  )
  if (Result.isFailure(existing) && existing.failure._tag !== "RecordNotFoundError") {
    return yield* existing.failure
  }
  const personId = Result.isSuccess(existing)
    ? existing.success.person.personId
    : PersonId.make(
      yield* stableUuid(
        cryptoService,
        materializationKey(scope, "person", event.vendorPersonId),
        event.eventId
      )
    )
  const avatar = event.avatarUrl !== null && event.avatarUrl.toString().length <= 500
    ? { _tag: "reference", reference: event.avatarUrl.toString() }
    : { _tag: "initials", text: derivePersonInitials(event.displayName) }
  const person = yield* Schema.decodeUnknownEffect(Schema.toType(Person))({
    personId,
    displayName: event.displayName,
    avatar,
    isActive: event.active,
    sourceIdentities: Result.isSuccess(existing) ? existing.success.person.sourceIdentities : [identity]
  }).pipe(Effect.mapError(() => malformed("normalized-person-invalid", event.eventId)))
  if (
    Result.isSuccess(existing) &&
    existing.success.person.displayName === person.displayName &&
    existing.success.person.isActive === person.isActive &&
    existing.success.person.avatar._tag === person.avatar._tag &&
    (existing.success.person.avatar._tag === "initials"
      ? existing.success.person.avatar.text === (person.avatar._tag === "initials" ? person.avatar.text : "")
      : existing.success.person.avatar.reference ===
        (person.avatar._tag === "reference" ? person.avatar.reference : ""))
  ) {
    return 0
  }
  if (Result.isSuccess(existing)) {
    yield* persistence.people.updatePerson(
      scope.workspaceId,
      person,
      existing.success.revision,
      scope.committedAt
    )
  } else {
    yield* persistence.people.createPerson(scope.workspaceId, person, scope.committedAt)
  }
  return 1
})

const evidencePredicate = (event: EvidenceAppend): typeof EvidencePredicate.Type => {
  const decoded = Schema.decodeUnknownResult(EvidencePredicate)(event.evidenceType)
  if (Result.isSuccess(decoded)) return decoded.success
  return "status-observed"
}

const materializeEvidence = Effect.fn("NormalizedPluginPageMaterialization.appendEvidence")(function*(
  persistence: PersistenceService,
  cryptoService: Crypto.Crypto,
  scope: NormalizedPluginPageMaterializationScope,
  event: EvidenceAppend
) {
  const subject = yield* findEntity(persistence, scope, event.subject.vendorImmutableId)
  if (subject === null) return yield* malformed("normalized-evidence-subject-missing", event.eventId)
  const subjectKind = canonicalKind(event.subject.entityType)
  if (subjectKind === null) return yield* malformed("normalized-evidence-subject-unsupported", event.eventId)
  const nodeId = yield* nodeIdFor(cryptoService, scope, event.subject.vendorImmutableId, event.eventId)
  const evidenceId = EvidenceId.make(
    yield* stableUuid(
      cryptoService,
      materializationKey(scope, "evidence", event.evidenceId),
      event.eventId
    )
  )
  const evidenceClaimId = EvidenceClaimId.make(
    yield* stableUuid(
      cryptoService,
      materializationKey(scope, "evidence-claim", event.evidenceId),
      event.eventId
    )
  )
  const decodedData = Schema.decodeUnknownResult(EvidenceData)(event.data)
  const predicate = Result.isSuccess(decodedData) && decodedData.success.predicate !== undefined
    ? decodedData.success.predicate
    : evidencePredicate(event)
  const value: typeof EvidenceValue.Type = Result.isSuccess(decodedData) && decodedData.success.value !== undefined
    ? decodedData.success.value
    : { _tag: "state", value: event.summary }
  const source = subject.sourceRevision
  const ageSeconds = Math.max(
    0,
    (DateTime.toEpochMillis(scope.committedAt) - DateTime.toEpochMillis(source.lastObservedAt)) / 1_000
  )
  const health: Extract<PluginHealth, { readonly _tag: "degraded" | "healthy" }> =
    scope.successfulHealth._tag === "healthy"
      ? { _tag: "healthy", checkedAt: scope.committedAt }
      : { ...scope.successfulHealth, checkedAt: scope.committedAt }
  const receipt = yield* writeGraph(persistence, scope.workspaceId, {
    entityProjections: [],
    nodes: [],
    evidenceItems: [{
      workspaceId: scope.workspaceId,
      evidenceId,
      schemaVersion: 1,
      attribution: {
        _tag: "plugin",
        pluginConnectionId: scope.pluginConnectionId,
        sourceEntityId: subject.entityId,
        sourceEntityRevision: LedgerRevision.make(subject.revision)
      },
      verifier: { _tag: "system", component: "normalized-plugin-page-materializer" },
      observedAt: event.capturedAt,
      recordedAt: scope.committedAt,
      validUntil: null,
      freshness: {
        _tag: "current",
        evaluatedAt: scope.committedAt,
        pluginHealth: health,
        provenance: { _tag: "provider", sourceRevision: source },
        sourceObservedAt: source.lastObservedAt,
        staleAfterSeconds: Math.max(1, Math.ceil(ageSeconds) + 1),
        synchronizedAt: scope.committedAt
      },
      retention: { classification: "evidence", retainUntil: null, legalHold: false }
    }],
    evidenceClaims: [{
      workspaceId: scope.workspaceId,
      evidenceClaimId,
      evidenceId,
      subjectNodeId: nodeId,
      predicate,
      value,
      recordedAt: scope.committedAt,
      supersedesEvidenceClaimId: null
    }],
    relationships: []
  }, event.eventId)
  return {
    evidenceItemCount: receipt.evidenceItemCount,
    evidenceClaimCount: receipt.evidenceClaimCount
  }
})

const materializeRelationship = Effect.fn(
  "NormalizedPluginPageMaterialization.proposeRelationship"
)(function*(
  persistence: PersistenceService,
  cryptoService: Crypto.Crypto,
  scope: NormalizedPluginPageMaterializationScope,
  event: RelationshipProposal
) {
  const resolveEndpoint = Effect.fn("NormalizedPluginPageMaterialization.resolveRelationshipEndpoint")(function*(
    reference: RelationshipProposal["from"]
  ) {
    if (reference.entityType === "release") {
      const releaseId = yield* releaseIdFor(cryptoService, scope, reference.vendorImmutableId, event.eventId)
      const release = yield* persistence.releases.get(scope.workspaceId, releaseId).pipe(Effect.result)
      if (Result.isFailure(release)) {
        if (release.failure._tag === "RecordNotFoundError") {
          return yield* malformed("normalized-relationship-endpoint-missing", event.eventId)
        }
        return yield* release.failure
      }
      const nodeId = yield* releaseNodeIdFor(cryptoService, scope, reference.vendorImmutableId, event.eventId)
      const existingNode = yield* persistence.deliveryGraph.read(scope.workspaceId, {
        _tag: "node",
        nodeId
      }).pipe(Effect.result)
      if (Result.isFailure(existingNode) && existingNode.failure._tag !== "RecordNotFoundError") {
        return yield* existingNode.failure
      }
      return {
        entity: null,
        kind: "release",
        node: Result.isSuccess(existingNode)
          ? null
          : {
            workspaceId: scope.workspaceId,
            nodeId,
            endpointKind: "release",
            resolution: { _tag: "resolved", target: { _tag: "release", releaseId } },
            createdAt: scope.committedAt
          },
        nodeId,
        releaseId
      } satisfies RelationshipEndpointResolution
    }
    const entity = yield* findEntity(persistence, scope, reference.vendorImmutableId)
    const kind = canonicalKind(reference.entityType)
    if (entity === null) return yield* malformed("normalized-relationship-endpoint-missing", event.eventId)
    if (kind === null) return yield* malformed("normalized-relationship-endpoint-unsupported", event.eventId)
    return {
      entity,
      kind,
      node: null,
      nodeId: yield* nodeIdFor(cryptoService, scope, reference.vendorImmutableId, event.eventId),
      releaseId: null
    } satisfies RelationshipEndpointResolution
  })
  const source = yield* resolveEndpoint(event.from)
  const target = yield* resolveEndpoint(event.to)
  const kind = yield* Schema.decodeUnknownEffect(RelationshipKind)(event.relationshipType).pipe(
    Effect.mapError(() => malformed("normalized-relationship-kind-invalid", event.eventId))
  )
  const provenanceEntity = source.entity ?? target.entity
  if (provenanceEntity === null) {
    return yield* malformed("normalized-relationship-provenance-entity-missing", event.eventId)
  }
  const relationshipScope: DeliveryRelationship["scope"] = source.releaseId !== null
    ? { _tag: "release", releaseId: source.releaseId }
    : null
  const relationshipId = RelationshipId.make(
    yield* stableUuid(
      cryptoService,
      materializationKey(scope, "relationship", event.relationshipId),
      event.eventId
    )
  )
  const existing = yield* persistence.deliveryGraph.read(scope.workspaceId, {
    _tag: "relationship",
    relationshipId,
    revision: null
  }).pipe(Effect.result)
  if (Result.isFailure(existing) && existing.failure._tag !== "RecordNotFoundError") {
    return yield* existing.failure
  }
  const previous = Result.isSuccess(existing) && existing.success._tag === "relationship"
    ? existing.success.value
    : null
  const revision = LedgerRevision.make((previous?.revision ?? 0) + 1)
  const nodes: Array<DeliveryNode> = []
  if (source.node !== null) nodes.push(source.node)
  if (target.node !== null && target.node.nodeId !== source.nodeId) nodes.push(target.node)
  const receipt = yield* writeGraph(
    persistence,
    scope.workspaceId,
    {
      entityProjections: [],
      nodes,
      evidenceItems: [],
      evidenceClaims: [],
      relationships: [
        {
          workspaceId: scope.workspaceId,
          relationshipId,
          relationshipSchemaVersion: 1,
          revision,
          supersedesRevision: previous?.revision ?? null,
          kind,
          sourceNodeId: source.nodeId,
          sourceNodeKind: source.kind,
          targetNodeId: target.nodeId,
          targetNodeKind: target.kind,
          scope: relationshipScope,
          lifecycle: { _tag: "proposed", effectiveAt: event.observedAt },
          confidence: {
            _tag: "inferred",
            score: event.confidence,
            rationale: `Proposed by ${scope.providerId} normalized synchronization.`
          },
          provenance: {
            _tag: "plugin",
            pluginConnectionId: scope.pluginConnectionId,
            sourceEntityId: provenanceEntity.entityId,
            sourceEntityRevision: LedgerRevision.make(provenanceEntity.revision)
          },
          recordedBy: { _tag: "system", component: "normalized-plugin-page-materializer" },
          evidenceClaimIds: yield* Effect.forEach(
            event.evidenceIds,
            (evidenceId) =>
              stableUuid(cryptoService, materializationKey(scope, "evidence-claim", evidenceId), event.eventId).pipe(
                Effect.map(EvidenceClaimId.make)
              )
          ),
          recordedAt: scope.committedAt
        }
      ]
    },
    event.eventId
  )
  return { nodeCount: receipt.nodeCount, relationshipCount: receipt.relationshipCount }
})

const hasAuthoritativeJiraFixVersions = (event: NormalizedPluginEventV1): event is EntityUpsert => {
  if (event._tag !== "UpsertEntity" || event.entityType !== "jira.issue") return false
  const snapshot = Schema.decodeUnknownResult(JiraIssueRelationshipSnapshot)(event.attributes)
  return Result.isSuccess(snapshot) && !snapshot.success.truncatedFields.includes("fixVersions")
}

const isReleaseContainmentForIssue = (
  event: NormalizedPluginEventV1,
  issue: EntityUpsert
): event is RelationshipProposal =>
  event._tag === "ProposeRelationship" &&
  event.relationshipType === "contains" &&
  event.from.entityType === "release" &&
  event.to.entityType === issue.entityType &&
  event.to.vendorImmutableId === issue.vendorImmutableId

const retireMissingJiraReleaseContainments = Effect.fn(
  "NormalizedPluginPageMaterialization.retireMissingJiraReleaseContainments"
)(function*(
  persistence: PersistenceService,
  cryptoService: Crypto.Crypto,
  scope: NormalizedPluginPageMaterializationScope,
  acceptedEvents: ReadonlyArray<NormalizedPluginEventV1>
) {
  let relationshipCount = 0
  for (const issue of acceptedEvents) {
    if (!hasAuthoritativeJiraFixVersions(issue)) continue
    const source = yield* findEntity(persistence, scope, issue.vendorImmutableId)
    if (source === null) return yield* malformed("normalized-relationship-endpoint-missing", issue.eventId)
    const issueNodeId = yield* nodeIdFor(cryptoService, scope, issue.vendorImmutableId, issue.eventId)
    const neighborhood = yield* persistence.deliveryGraph.read(scope.workspaceId, {
      _tag: "nodeRelationships",
      nodeId: issueNodeId,
      limit: 500
    })
    if (neighborhood._tag !== "nodeRelationships") continue
    if (neighborhood.value.truncated) {
      return yield* malformed("normalized-jira-containment-neighborhood-truncated", issue.eventId)
    }
    const currentRelationshipIds = new Set(
      yield* Effect.forEach(
        acceptedEvents.filter((event) => isReleaseContainmentForIssue(event, issue)),
        ({ relationshipId }) =>
          stableUuid(
            cryptoService,
            materializationKey(scope, "relationship", relationshipId),
            issue.eventId
          ).pipe(Effect.map(RelationshipId.make))
      )
    )
    const removed = neighborhood.value.relationships.filter(
      (relationship) =>
        relationship.kind === "contains" &&
        relationship.sourceNodeKind === "release" &&
        relationship.targetNodeId === issueNodeId &&
        relationship.targetNodeKind === "issue" &&
        relationship.provenance._tag === "plugin" &&
        relationship.provenance.pluginConnectionId === scope.pluginConnectionId &&
        relationship.provenance.sourceEntityId === source.entityId &&
        !currentRelationshipIds.has(relationship.relationshipId)
    )
    if (removed.length === 0) continue

    for (const previous of removed) {
      if (previous.lifecycle._tag === "rejected" || previous.lifecycle._tag === "superseded") continue
      const receipt = yield* writeGraph(persistence, scope.workspaceId, {
        entityProjections: [],
        nodes: [],
        evidenceItems: [],
        evidenceClaims: [],
        relationships: [{
          ...previous,
          revision: LedgerRevision.make(previous.revision + 1),
          supersedesRevision: previous.revision,
          lifecycle: {
            _tag: "superseded",
            effectiveAt: issue.observedAt,
            reason: "No longer present in the latest Jira fixVersion observation."
          },
          provenance: {
            _tag: "plugin",
            pluginConnectionId: scope.pluginConnectionId,
            sourceEntityId: source.entityId,
            sourceEntityRevision: LedgerRevision.make(source.revision)
          },
          recordedBy: { _tag: "system", component: "normalized-plugin-page-materializer" },
          recordedAt: scope.committedAt
        }]
      }, issue.eventId)
      relationshipCount += receipt.relationshipCount
    }
  }
  return relationshipCount
})

/** Host authority supplied separately from provider-controlled normalized data. */
export interface NormalizedPluginPageMaterializationScope {
  readonly workspaceId: WorkspaceId
  readonly pluginConnectionId: PluginConnectionId
  readonly providerId: ProviderId
  readonly streamKey: PluginStreamKey
  readonly expectedRevision: number
  readonly committedAt: UtcTimestamp
  readonly successfulHealth: Extract<PluginHealth, { readonly _tag: "healthy" | "degraded" }>
  readonly expectedAuthority?: PluginSynchronizationAuthority
}

/** Durable counts from one new page, or zero counts when the exact page is replayed. */
export interface NormalizedPluginPageMaterializationReceipt {
  readonly pageCommitted: boolean
  readonly acceptedEventCount: number
  readonly entityProjectionCount: number
  readonly evidenceClaimCount: number
  readonly evidenceItemCount: number
  readonly nodeCount: number
  readonly personCount: number
  readonly relationshipCount: number
  readonly skippedEntityCount: number
}

/**
 * Commit one decoded page and all accepted canonical projections atomically.
 * The existing plugin checkpoint transaction nests as a savepoint; only its
 * newly accepted event identities cross the materialization seam.
 */
export const materializeNormalizedPluginPage = Effect.fn(
  "NormalizedPluginPageMaterialization.materializePage"
)(function*(
  scope: NormalizedPluginPageMaterializationScope,
  page: PluginSyncPageV1
): Effect.fn.Return<
  NormalizedPluginPageMaterializationReceipt,
  NormalizedPluginPageMaterializationError | PersistenceOperationFailure | PluginConflictFailure,
  Crypto.Crypto | Persistence
> {
  const cryptoService = yield* Crypto.Crypto
  const persistence = yield* Persistence
  return yield* persistence.transact(Effect.gen(function*() {
    if (scope.expectedAuthority !== undefined) {
      yield* verifyPluginSynchronizationAuthority(persistence, scope.expectedAuthority)
    }
    const committed = yield* persistence.pluginRuntime.commitNormalizedPageReceipt(
      scope.workspaceId,
      scope.pluginConnectionId,
      scope.providerId,
      scope.streamKey,
      scope.expectedRevision,
      page,
      scope.committedAt,
      scope.successfulHealth
    )
    const accepted = new Set(committed.acceptedEventIds)
    const events = page.events.filter(({ eventId }) => accepted.has(eventId))
    let entityProjectionCount = 0
    let evidenceClaimCount = 0
    let evidenceItemCount = 0
    let nodeCount = 0
    let personCount = 0
    let relationshipCount = 0
    let skippedEntityCount = 0

    for (const event of events) {
      if (event._tag !== "UpsertPerson") continue
      personCount += yield* materializePerson(persistence, cryptoService, scope, event)
    }
    for (const event of events) {
      if (event._tag === "UpsertEntity") {
        if (event.entityType === "release") {
          nodeCount += (yield* materializeRelease(persistence, cryptoService, scope, event)).nodeCount
          continue
        }
        const receipt = yield* materializeUpsertEntity(persistence, cryptoService, scope, event)
        entityProjectionCount += receipt.entityProjectionCount
        nodeCount += receipt.nodeCount
        skippedEntityCount += receipt.skippedEntityCount
      } else if (event._tag === "TombstoneEntity") {
        entityProjectionCount += (yield* materializeTombstoneEntity(persistence, scope, event)).entityProjectionCount
      }
    }
    for (const event of events) {
      if (event._tag !== "AppendEvidence") continue
      const receipt = yield* materializeEvidence(persistence, cryptoService, scope, event)
      evidenceItemCount += receipt.evidenceItemCount
      evidenceClaimCount += receipt.evidenceClaimCount
    }
    for (const event of events) {
      if (event._tag !== "ProposeRelationship") continue
      const receipt = yield* materializeRelationship(persistence, cryptoService, scope, event)
      nodeCount += receipt.nodeCount
      relationshipCount += receipt.relationshipCount
    }
    relationshipCount += yield* retireMissingJiraReleaseContainments(
      persistence,
      cryptoService,
      scope,
      events
    )
    if (events.length > 0) {
      const inference = yield* materializeRelationshipInference(
        persistence,
        (identity) => stableUuid(cryptoService, identity, "relationship-inference"),
        scope
      )
      evidenceClaimCount += inference.evidenceClaimCount
      evidenceItemCount += inference.evidenceItemCount
      nodeCount += inference.nodeCount
      relationshipCount += inference.relationshipCount
    }
    return {
      pageCommitted: committed.pageCommitted,
      acceptedEventCount: events.length,
      entityProjectionCount,
      evidenceClaimCount,
      evidenceItemCount,
      nodeCount,
      personCount,
      relationshipCount,
      skippedEntityCount
    }
  }))
})
