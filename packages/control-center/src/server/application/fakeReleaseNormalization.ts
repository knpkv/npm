import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import { derivePersonInitials, Person, type Person as PersonType } from "../../domain/actors.js"
import { type PluginHealth } from "../../domain/freshness.js"
import type { PluginConnectionId, WorkspaceId } from "../../domain/identifiers.js"
import { EnvironmentId, PersonId, ReleaseId, RoleAssignmentId } from "../../domain/identifiers.js"
import { NormalizedPluginEventV1, type PluginSyncPageV1 } from "../../domain/plugins/events.js"
import {
  Release,
  type Release as ReleaseType,
  ReleaseLifecycle,
  ReleaseServiceName,
  ReleaseVersion
} from "../../domain/release.js"
import { deriveReleaseRelay } from "../../domain/releaseRelay.js"
import type { ProviderId } from "../../domain/sourceRevision.js"
import { SourceRevision, VendorImmutableId } from "../../domain/sourceRevision.js"
import type { UtcTimestamp } from "../../domain/utcTimestamp.js"
import { ContentBlobDigest } from "../persistence/repositories/models.js"
import {
  type PluginCacheRecord,
  PluginPageId,
  PluginRecordKey,
  type PluginStreamKey
} from "../persistence/repositories/pluginRuntimeModels.js"

const FakeReleaseCollaborator = Schema.Struct({
  personId: PersonId,
  assignmentId: RoleAssignmentId,
  vendorPersonId: VendorImmutableId,
  role: Schema.Literals(["release-owner", "release-approver"])
})

/** Strict host fixture carried inside the fake adapter's otherwise generic attributes. */
export const FakeReleaseAttributes = Schema.Struct({
  releaseId: ReleaseId,
  serviceName: ReleaseServiceName,
  version: ReleaseVersion,
  lifecycle: ReleaseLifecycle,
  targetEnvironmentIds: Schema.Array(EnvironmentId).check(Schema.isNonEmpty(), Schema.isUnique()),
  staleAfterSeconds: Schema.Int.check(Schema.isGreaterThan(0)),
  collaborators: Schema.Array(FakeReleaseCollaborator).check(
    Schema.isNonEmpty(),
    Schema.makeFilter((collaborators) => collaborators.length <= 20, {
      expected: "at most 20 fake release collaborators"
    }),
    Schema.makeFilter(
      (collaborators) => new Set(collaborators.map(({ assignmentId }) => assignmentId)).size === collaborators.length,
      { expected: "unique fake release assignment identifiers" }
    ),
    Schema.makeFilter(
      (collaborators) =>
        collaborators.filter(({ role }) => role === "release-owner").length === 1 &&
        collaborators.filter(({ role }) => role === "release-approver").length === 1,
      { expected: "one fake release owner and one fake release approver" }
    )
  )
}).annotate({ identifier: "FakeReleaseAttributes" })

/** Bounded failure raised before a fake release page can advance its checkpoint. */
export class FakeReleaseNormalizationError extends Schema.TaggedErrorClass<FakeReleaseNormalizationError>()(
  "FakeReleaseNormalizationError",
  {
    diagnosticCode: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(100))
  }
) {}

const normalizationError = (diagnosticCode: string): FakeReleaseNormalizationError =>
  new FakeReleaseNormalizationError({ diagnosticCode })

const decodeAttributes = (attributes: unknown) =>
  Schema.decodeUnknownEffect(FakeReleaseAttributes)(attributes).pipe(
    Effect.mapError(() => normalizationError("fake-release-attributes-invalid"))
  )

const releaseEventKey = (event: Extract<typeof NormalizedPluginEventV1.Type, { readonly _tag: "UpsertEntity" }>) =>
  `${event.entityType}\u0000${event.vendorImmutableId}`

const personEventKey = (vendorPersonId: string) => `person\u0000${vendorPersonId}`

/** Validate the complete prospective cache before the durable checkpoint transaction starts. */
export const prevalidateFakeReleasePage = Effect.fn("FakeRelease.prevalidatePage")(function*(
  page: PluginSyncPageV1,
  existingRecords: ReadonlyArray<PluginCacheRecord>,
  input: FakeReleaseNormalizationInput & { readonly streamKey: PluginStreamKey }
) {
  const existingEvents = yield* Effect.forEach(
    existingRecords.filter(({ state }) => state === "present"),
    decodeCachedEvent
  )
  const entities = new Map<string, Extract<typeof NormalizedPluginEventV1.Type, { readonly _tag: "UpsertEntity" }>>()
  const people = new Map<string, Extract<typeof NormalizedPluginEventV1.Type, { readonly _tag: "UpsertPerson" }>>()
  const existingReleases: Array<Extract<typeof NormalizedPluginEventV1.Type, { readonly _tag: "UpsertEntity" }>> = []
  for (const event of existingEvents) {
    if (event._tag === "UpsertEntity") {
      entities.set(releaseEventKey(event), event)
      if (event.entityType === "release") existingReleases.push(event)
    } else if (event._tag === "UpsertPerson") {
      people.set(personEventKey(event.vendorPersonId), event)
    }
  }
  if (existingReleases.length > 1) {
    return yield* normalizationError("fake-release-cache-cardinality-invalid")
  }

  const existingRelease = existingReleases[0]
  const existingAttributes = existingRelease === undefined ? null : yield* decodeAttributes(existingRelease.attributes)
  for (const event of page.events) {
    if (event._tag === "UpsertEntity") {
      if (event.entityType === "release" && existingRelease !== undefined) {
        const attributes = yield* decodeAttributes(event.attributes)
        if (
          event.vendorImmutableId !== existingRelease.vendorImmutableId ||
          attributes.releaseId !== existingAttributes?.releaseId
        ) {
          return yield* normalizationError("fake-release-identity-conflict")
        }
      }
      entities.set(releaseEventKey(event), event)
    } else if (event._tag === "TombstoneEntity") {
      if (event.entityType === "release") {
        return yield* normalizationError("fake-release-tombstone-unsupported")
      }
      entities.delete(`${event.entityType}\u0000${event.vendorImmutableId}`)
    } else if (event._tag === "UpsertPerson") {
      people.set(personEventKey(event.vendorPersonId), event)
    }
  }

  const releaseEvents = Array.from(entities.values()).filter(({ entityType }) => entityType === "release")
  if (releaseEvents.length > 1) {
    return yield* normalizationError("fake-release-projection-cardinality-invalid")
  }
  const missingCollaborators: Array<{
    readonly observedAt: string
    readonly revision: string
    readonly vendorPersonId: string
  }> = []
  for (const releaseEvent of releaseEvents) {
    const attributes = yield* decodeAttributes(releaseEvent.attributes)
    const personByVendor = new Map(
      existingAttributes?.collaborators.map(({ personId, vendorPersonId }) => [vendorPersonId, personId]) ?? []
    )
    const vendorByPerson = new Map(
      existingAttributes?.collaborators.map(({ personId, vendorPersonId }) => [personId, vendorPersonId]) ?? []
    )
    for (const collaborator of attributes.collaborators) {
      const previousPerson = personByVendor.get(collaborator.vendorPersonId)
      const previousVendor = vendorByPerson.get(collaborator.personId)
      if (
        (previousPerson !== undefined && previousPerson !== collaborator.personId) ||
        (previousVendor !== undefined && previousVendor !== collaborator.vendorPersonId)
      ) {
        return yield* normalizationError("fake-release-person-identity-conflict")
      }
      personByVendor.set(collaborator.vendorPersonId, collaborator.personId)
      vendorByPerson.set(collaborator.personId, collaborator.vendorPersonId)
      const personEvent = people.get(personEventKey(collaborator.vendorPersonId))
      if (personEvent === undefined) {
        if (!page.hasMore) {
          return yield* normalizationError("fake-release-terminal-collaborator-missing")
        }
        missingCollaborators.push({
          observedAt: DateTime.formatIso(releaseEvent.observedAt),
          revision: releaseEvent.revision,
          vendorPersonId: collaborator.vendorPersonId
        })
        continue
      }
      yield* Schema.decodeUnknownEffect(Schema.toType(Person))({
        personId: collaborator.personId,
        displayName: personEvent.displayName,
        avatar: { _tag: "initials", text: derivePersonInitials(personEvent.displayName) },
        isActive: personEvent.active,
        sourceIdentities: []
      }).pipe(Effect.mapError(() => normalizationError("fake-release-page-person-invalid")))
    }
  }

  const pendingPeople = page.hasMore
    ? yield* Effect.forEach(
      missingCollaborators,
      (collaborator, index) =>
        Schema.decodeUnknownEffect(NormalizedPluginEventV1)({
          _tag: "UpsertPerson",
          eventId: `prospective-person-${index}`,
          observedAt: collaborator.observedAt,
          revision: collaborator.revision,
          vendorPersonId: collaborator.vendorPersonId,
          displayName: `Pending collaborator ${index + 1}`,
          avatarUrl: null,
          active: true
        }).pipe(Effect.mapError(() => normalizationError("fake-release-pending-person-invalid")))
    )
    : []
  const prospectiveEvents = [...entities.values(), ...people.values(), ...pendingPeople]
  const prospectiveRecords = yield* Effect.forEach(prospectiveEvents, (event, index) =>
    Effect.gen(function*() {
      const payloadJson = yield* Schema.encodeEffect(cachedEventSchema)(event).pipe(
        Effect.mapError(() => normalizationError("fake-release-prospective-event-invalid"))
      )
      return {
        workspaceId: input.workspaceId,
        pluginConnectionId: input.pluginConnectionId,
        streamKey: input.streamKey,
        recordKey: PluginRecordKey.make(`prospective/${index}`),
        state: "present",
        payloadJson,
        payloadDigest: ContentBlobDigest.make("0".repeat(64)),
        sourceRevision: event.revision,
        lastPageId: PluginPageId.make("prospective-validation"),
        cachedAt: input.pluginHealth.checkedAt,
        tombstonedAt: null
      } satisfies PluginCacheRecord
    }))
  yield* normalizeFakeReleaseCache(prospectiveRecords, input)
  return releaseEvents.flatMap((event) => {
    const decoded = Schema.decodeUnknownResult(FakeReleaseAttributes)(event.attributes)
    return Result.isSuccess(decoded) ? decoded.success.collaborators : []
  })
})

const cachedEventSchema = Schema.fromJsonString(NormalizedPluginEventV1)

const decodeCachedEvent = Effect.fn("FakeRelease.decodeCachedEvent")(function*(record: PluginCacheRecord) {
  if (record.state !== "present" || record.payloadJson === null) {
    return yield* normalizationError("fake-release-cache-record-unavailable")
  }
  return yield* Schema.decodeUnknownEffect(cachedEventSchema)(record.payloadJson).pipe(
    Effect.mapError(() => normalizationError("fake-release-cache-event-invalid"))
  )
})

export interface FakeReleaseProjection {
  readonly people: ReadonlyArray<PersonType>
  readonly release: ReleaseType
}

export interface FakeReleaseNormalizationInput {
  readonly workspaceId: WorkspaceId
  readonly pluginConnectionId: PluginConnectionId
  readonly providerId: ProviderId
  readonly pluginHealth: PluginHealth
  readonly evaluatedAt: UtcTimestamp
  readonly provenance: "provider" | "cache"
  readonly previousRelease: ReleaseType | null
}

/** Resolve the canonical fixture identity without reading a mutable presentation projection. */
export const fakeReleaseIdFromCache = Effect.fn("FakeRelease.releaseIdFromCache")(function*(
  records: ReadonlyArray<PluginCacheRecord>
): Effect.fn.Return<Option.Option<ReleaseId>, FakeReleaseNormalizationError> {
  const candidates: Array<ReleaseId> = []
  for (const record of records) {
    if (record.state !== "present") continue
    const event = yield* decodeCachedEvent(record)
    if (event._tag === "UpsertEntity" && event.entityType === "release") {
      const attributes = yield* decodeAttributes(event.attributes)
      candidates.push(attributes.releaseId)
    }
  }
  if (candidates.length === 0) return Option.none()
  if (candidates.length !== 1) {
    return yield* normalizationError("fake-release-cache-cardinality-invalid")
  }
  const releaseId = candidates[0]
  return releaseId === undefined ? Option.none() : Option.some(releaseId)
})

const findPersonEvent = (
  events: ReadonlyArray<typeof NormalizedPluginEventV1.Type>,
  vendorPersonId: VendorImmutableId
) =>
  events.find(
    (event) => event._tag === "UpsertPerson" && event.vendorPersonId === vendorPersonId
  )

const usableHealth = (
  health: PluginHealth
): health is Extract<PluginHealth, { readonly _tag: "healthy" | "degraded" }> =>
  health._tag === "healthy" || health._tag === "degraded"

const matchingPreviousSource = (
  release: ReleaseType | null,
  pluginConnectionId: PluginConnectionId,
  providerId: ProviderId,
  vendorImmutableId: VendorImmutableId
) =>
  release?.sourceRevisions.find(
    (revision) =>
      revision.pluginConnectionId === pluginConnectionId &&
      revision.providerId === providerId &&
      revision.vendorImmutableId === vendorImmutableId
  )

/** Build one canonical fake release strictly from the committed last-valid cache. */
export const normalizeFakeReleaseCache = Effect.fn("FakeRelease.normalizeCache")(function*(
  records: ReadonlyArray<PluginCacheRecord>,
  input: FakeReleaseNormalizationInput
): Effect.fn.Return<Option.Option<FakeReleaseProjection>, FakeReleaseNormalizationError> {
  const presentRecords = records.filter(({ state }) => state === "present")
  const decodedRecords = yield* Effect.forEach(
    presentRecords,
    (record) => decodeCachedEvent(record).pipe(Effect.map((event) => ({ event, record })))
  )
  const events = decodedRecords.map(({ event }) => event)
  const releaseRecords = decodedRecords.filter(
    ({ event }) => event._tag === "UpsertEntity" && event.entityType === "release"
  )
  if (releaseRecords.length === 0) return Option.none()
  if (releaseRecords.length !== 1) {
    return yield* normalizationError("fake-release-cache-cardinality-invalid")
  }
  const selectedRelease = releaseRecords[0]
  const releaseEvent = selectedRelease?.event
  if (selectedRelease === undefined || releaseEvent === undefined || releaseEvent._tag !== "UpsertEntity") {
    return yield* normalizationError("fake-release-cache-cardinality-invalid")
  }
  const releaseRecord = selectedRelease.record
  const attributes = yield* decodeAttributes(releaseEvent.attributes)

  const previousSource = matchingPreviousSource(
    input.previousRelease,
    input.pluginConnectionId,
    input.providerId,
    releaseEvent.vendorImmutableId
  )
  const sourceRevision = yield* Schema.decodeUnknownEffect(Schema.toType(SourceRevision))({
    pluginConnectionId: input.pluginConnectionId,
    providerId: input.providerId,
    vendorImmutableId: releaseEvent.vendorImmutableId,
    revision: releaseEvent.revision,
    normalizationSchemaVersion: 1,
    sourceUrl: releaseEvent.sourceUrl,
    firstObservedAt: previousSource?.firstObservedAt ?? releaseEvent.observedAt,
    lastObservedAt: releaseEvent.observedAt,
    synchronizedAt: releaseRecord.cachedAt
  }).pipe(Effect.mapError(() => normalizationError("fake-release-source-revision-invalid")))

  const ageSeconds = (
    DateTime.toEpochMillis(input.evaluatedAt) - DateTime.toEpochMillis(sourceRevision.lastObservedAt)
  ) / 1_000
  const isStale = ageSeconds > attributes.staleAfterSeconds
  if (!usableHealth(input.pluginHealth) && !isStale) {
    return input.previousRelease === null
      ? Option.none()
      : Option.some({ release: input.previousRelease, people: [] })
  }

  const people = yield* Effect.forEach(attributes.collaborators, (collaborator) =>
    Effect.gen(function*() {
      const personEvent = findPersonEvent(events, collaborator.vendorPersonId)
      if (personEvent === undefined || personEvent._tag !== "UpsertPerson") {
        return yield* normalizationError("fake-release-collaborator-missing")
      }
      return yield* Schema.decodeUnknownEffect(Schema.toType(Person))({
        personId: collaborator.personId,
        displayName: personEvent.displayName,
        avatar: { _tag: "initials", text: derivePersonInitials(personEvent.displayName) },
        isActive: personEvent.active,
        sourceIdentities: [{
          pluginConnectionId: input.pluginConnectionId,
          providerId: input.providerId,
          vendorPersonId: personEvent.vendorPersonId
        }]
      }).pipe(Effect.mapError(() => normalizationError("fake-release-person-invalid")))
    }))

  const freshness = isStale
    ? {
      _tag: "stale",
      pluginHealth: input.pluginHealth,
      provenance: { _tag: "cache", cachedAt: releaseRecord.cachedAt, sourceRevision },
      sourceObservedAt: sourceRevision.lastObservedAt,
      staleAfterSeconds: attributes.staleAfterSeconds,
      synchronizedAt: releaseRecord.cachedAt
    }
    : {
      _tag: "current",
      pluginHealth: input.pluginHealth,
      provenance: input.provenance === "provider"
        ? { _tag: "provider", sourceRevision }
        : { _tag: "cache", cachedAt: releaseRecord.cachedAt, sourceRevision },
      sourceObservedAt: sourceRevision.lastObservedAt,
      staleAfterSeconds: attributes.staleAfterSeconds,
      synchronizedAt: releaseRecord.cachedAt
    }

  const release = yield* Schema.decodeUnknownEffect(Schema.toType(Release))({
    createdAt: input.previousRelease?.createdAt ?? releaseEvent.observedAt,
    freshness,
    id: attributes.releaseId,
    lifecycle: attributes.lifecycle,
    relay: deriveReleaseRelay(attributes.releaseId),
    roleAssignments: attributes.collaborators.map((collaborator) => ({
      actor: { _tag: "human", personId: collaborator.personId },
      assignmentId: collaborator.assignmentId,
      lifecycle: { _tag: "active", assignedAt: releaseEvent.observedAt },
      role: collaborator.role,
      scope: { _tag: "release", releaseId: attributes.releaseId, workspaceId: input.workspaceId }
    })),
    serviceName: attributes.serviceName,
    sourceRevisions: [sourceRevision],
    targetEnvironmentIds: attributes.targetEnvironmentIds,
    updatedAt: isStale ? input.evaluatedAt : releaseRecord.cachedAt,
    version: attributes.version,
    workspaceId: input.workspaceId
  }).pipe(Effect.mapError(() => normalizationError("fake-release-aggregate-invalid")))

  return Option.some({ people, release })
})
