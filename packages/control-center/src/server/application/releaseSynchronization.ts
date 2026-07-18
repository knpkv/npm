import type * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

import { Person, type PersonSourceIdentity } from "../../domain/actors.js"
import { PluginHealth, type PluginHealth as PluginHealthType } from "../../domain/freshness.js"
import type { PluginConnectionId, WorkspaceId } from "../../domain/identifiers.js"
import { PluginCheckpointV1, PluginSyncRequestV1 } from "../../domain/plugins/events.js"
import { Release } from "../../domain/release.js"
import type { ProviderId } from "../../domain/sourceRevision.js"
import type { UtcTimestamp } from "../../domain/utcTimestamp.js"
import { SourceIdentityMismatchError } from "../persistence/errors.js"
import { Persistence, type PersistenceOperationFailure } from "../persistence/Persistence.js"
import { PluginStreamKey } from "../persistence/repositories/pluginRuntimeModels.js"
import { type PluginFailure, pluginFailureClass, PluginMalformedResponseFailure } from "../plugins/failures.js"
import { PluginConnection } from "../plugins/PluginConnection.js"
import { PluginConnectionMap } from "../plugins/PluginConnectionMap.js"
import { DomainEventWakeups } from "../runtime/DomainEventWakeups.js"
import {
  fakeReleaseIdFromCache,
  FakeReleaseNormalizationError,
  normalizeFakeReleaseCache,
  prevalidateFakeReleasePage
} from "./fakeReleaseNormalization.js"
import { appendPortfolioInvalidation } from "./portfolioInvalidation.js"

const pluginFailureTags = new Set([
  "PluginAuthenticationFailure",
  "PluginAuthorizationFailure",
  "PluginRateLimitFailure",
  "PluginTimeoutFailure",
  "PluginMalformedResponseFailure",
  "PluginOutageFailure",
  "PluginCancellationFailure",
  "PluginConflictFailure",
  "PluginUnsupportedCapabilityFailure",
  "PluginConfigurationFailure",
  "PluginUnknownOutcomeFailure"
])

const isPluginFailure = (failure: unknown): failure is PluginFailure =>
  Predicate.hasProperty(failure, "_tag") &&
  typeof failure._tag === "string" &&
  pluginFailureTags.has(failure._tag)

const sourceFailure = (failure: unknown): PluginFailure | null => {
  if (isPluginFailure(failure)) return failure
  if (Predicate.hasProperty(failure, "_tag") && failure._tag === "FakeReleaseNormalizationError") {
    return new PluginMalformedResponseFailure({
      operation: "sync",
      diagnosticCode: "fake-release-normalization-rejected"
    })
  }
  if (
    Predicate.hasProperty(failure, "_tag") &&
    failure._tag === "SourceIdentityMismatchError" &&
    Predicate.hasProperty(failure, "recordKind") &&
    (failure.recordKind === "plugin-sync-event" || failure.recordKind === "plugin-sync-page")
  ) {
    return new PluginMalformedResponseFailure({
      operation: "sync",
      diagnosticCode: "plugin-sync-source-identity-conflict"
    })
  }
  return null
}

const safeFailureMessage = (failure: PluginFailure): string => {
  switch (failure._tag) {
    case "PluginAuthenticationFailure":
      return "Provider authentication failed."
    case "PluginAuthorizationFailure":
      return "Provider permission was denied."
    case "PluginRateLimitFailure":
      return "Provider rate limit was reached."
    case "PluginTimeoutFailure":
      return "Provider request timed out."
    case "PluginMalformedResponseFailure":
      return "Provider returned an invalid response."
    case "PluginOutageFailure":
      return "Provider is temporarily unavailable."
    case "PluginCancellationFailure":
      return "Provider synchronization was cancelled."
    case "PluginConflictFailure":
      return "Provider state changed during synchronization."
    case "PluginUnsupportedCapabilityFailure":
      return "Provider synchronization is not supported."
    case "PluginConfigurationFailure":
      return "Provider configuration is incomplete."
    case "PluginUnknownOutcomeFailure":
      return "Provider synchronization outcome is unknown."
  }
}

const failureHealth = Effect.fn("ReleaseSynchronization.failureHealth")(function*(
  failure: PluginFailure,
  checkedAt: UtcTimestamp
) {
  return yield* Schema.decodeUnknownEffect(Schema.toType(PluginHealth))({
    _tag: "unavailable",
    checkedAt,
    failureClass: pluginFailureClass(failure),
    retryAt: failure._tag === "PluginRateLimitFailure" ? failure.retryAt : null,
    safeMessage: safeFailureMessage(failure)
  })
})

export interface ReleaseSynchronizationInput {
  readonly workspaceId: WorkspaceId
  readonly pluginConnectionId: PluginConnectionId
  readonly streamKey: string
}

interface BoundReleaseSynchronizationInput extends ReleaseSynchronizationInput {
  readonly providerId: ProviderId
}

export type ReleaseSynchronizationOutcome =
  | {
    readonly _tag: "synchronized"
    readonly pagesCommitted: number
    readonly releaseId: Release["id"] | null
  }
  | {
    readonly _tag: "source-unavailable"
    readonly releaseId: Release["id"] | null
  }

export type ReleaseSynchronizationFailure =
  | FakeReleaseNormalizationError
  | PersistenceOperationFailure
  | PluginFailure
  | Schema.SchemaError

const persistHealth = Effect.fn("ReleaseSynchronization.persistHealth")(function*(
  input: BoundReleaseSynchronizationInput,
  health: PluginHealthType,
  failed: boolean
) {
  const persistence = yield* Persistence
  const wakeups = yield* DomainEventWakeups
  const recorded = yield* persistence.transact(
    Effect.gen(function*() {
      const runtime = yield* persistence.pluginRuntime.getRuntime(input.workspaceId, input.pluginConnectionId)
      const updated = yield* persistence.pluginRuntime.recordHealth(
        input.workspaceId,
        input.pluginConnectionId,
        runtime.revision,
        health,
        failed ? runtime.consecutiveFailures + 1 : 0
      )
      yield* appendPortfolioInvalidation({
        workspaceId: input.workspaceId,
        pluginConnectionId: input.pluginConnectionId,
        releaseId: null,
        occurredAt: health.checkedAt,
        reason: "plugin-health"
      })
      return updated
    })
  )
  yield* wakeups.notify(input.workspaceId)
  return recorded
})

const personEquivalence = Schema.toEquivalence(Schema.toEncoded(Person))
const releaseEquivalence = Schema.toEquivalence(Schema.toEncoded(Release))

const peopleEqual = Effect.fn("ReleaseSynchronization.peopleEqual")(function*(left: Person, right: Person) {
  const encodedLeft = yield* Schema.encodeEffect(Person)(left)
  const encodedRight = yield* Schema.encodeEffect(Person)(right)
  return personEquivalence(encodedLeft, encodedRight)
})

const releasesEqual = Effect.fn("ReleaseSynchronization.releasesEqual")(function*(left: Release, right: Release) {
  const encodedLeft = yield* Schema.encodeEffect(Release)(left)
  const encodedRight = yield* Schema.encodeEffect(Release)(right)
  return releaseEquivalence(encodedLeft, encodedRight)
})

const recoveryProjectionsEqual = Effect.fn("ReleaseSynchronization.recoveryProjectionsEqual")(function*(
  previous: Release,
  projected: Release
) {
  const previousFreshness = previous.freshness
  const projectedFreshness = projected.freshness
  if (
    (previousFreshness._tag !== "current" && previousFreshness._tag !== "stale") ||
    previousFreshness._tag !== projectedFreshness._tag
  ) return false

  const provenance = previousFreshness._tag === "current" &&
      previousFreshness.provenance._tag === "provider" &&
      projectedFreshness._tag === "current" &&
      projectedFreshness.provenance._tag === "cache"
    ? previousFreshness.provenance
    : projectedFreshness.provenance
  const comparableResult = yield* Schema.decodeUnknownEffect(Schema.toType(Release))({
    ...projected,
    freshness: { ...projectedFreshness, evaluatedAt: previousFreshness.evaluatedAt, provenance },
    updatedAt: previousFreshness._tag === "stale" ? previous.updatedAt : projected.updatedAt
  }).pipe(Effect.result)
  if (Result.isFailure(comparableResult)) return false
  return yield* releasesEqual(previous, comparableResult.success)
})

const identityKey = ({ pluginConnectionId, providerId, vendorPersonId }: PersonSourceIdentity): string =>
  `${providerId}\u0000${pluginConnectionId}\u0000${vendorPersonId}`

const mergePersonIdentities = (current: Person, synchronized: Person): Person => {
  const identities = new Map<string, PersonSourceIdentity>()
  for (const identity of current.sourceIdentities) identities.set(identityKey(identity), identity)
  for (const identity of synchronized.sourceIdentities) identities.set(identityKey(identity), identity)
  return {
    ...synchronized,
    sourceIdentities: Array.from(identities.values()).sort((left, right) => {
      const leftKey = identityKey(left)
      const rightKey = identityKey(right)
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
    })
  }
}

const persistPerson = Effect.fn("ReleaseSynchronization.persistPerson")(function*(
  workspaceId: WorkspaceId,
  person: Person,
  updatedAt: UtcTimestamp
) {
  const persistence = yield* Persistence
  const current = yield* Effect.result(persistence.people.getPerson(workspaceId, person.personId))
  if (Result.isFailure(current)) {
    if (current.failure._tag !== "RecordNotFoundError") return yield* Effect.fail(current.failure)
    return { record: yield* persistence.people.createPerson(workspaceId, person, updatedAt), changed: true }
  }
  const mergedPerson = mergePersonIdentities(current.success.person, person)
  if (yield* peopleEqual(current.success.person, mergedPerson)) return { record: current.success, changed: false }
  return {
    record: yield* persistence.people.updatePerson(
      workspaceId,
      mergedPerson,
      current.success.revision,
      updatedAt
    ),
    changed: true
  }
})

const persistRelease = Effect.fn("ReleaseSynchronization.persistRelease")(function*(
  workspaceId: WorkspaceId,
  release: Release
) {
  const persistence = yield* Persistence
  const current = yield* Effect.result(persistence.releases.get(workspaceId, release.id))
  if (Result.isFailure(current)) {
    if (current.failure._tag !== "RecordNotFoundError") return yield* Effect.fail(current.failure)
    return { record: yield* persistence.releases.create(workspaceId, release), changed: true }
  }
  if (yield* releasesEqual(current.success.release, release)) return { record: current.success, changed: false }
  return {
    record: yield* persistence.releases.append(workspaceId, release, current.success.revision),
    changed: true
  }
})

const readPreviousRelease = Effect.fn("ReleaseSynchronization.readPreviousRelease")(function*(
  input: BoundReleaseSynchronizationInput,
  records: Parameters<typeof fakeReleaseIdFromCache>[0]
) {
  const persistence = yield* Persistence
  const releaseId = yield* fakeReleaseIdFromCache(records)
  if (Option.isNone(releaseId)) return null
  const current = yield* Effect.result(persistence.releases.get(input.workspaceId, releaseId.value))
  if (Result.isFailure(current)) {
    if (current.failure._tag === "RecordNotFoundError") return null
    return yield* Effect.fail(current.failure)
  }
  return current.success.release
})

const reconcileProjectionFacts = Effect.fn("ReleaseSynchronization.reconcileProjectionFacts")(function*(
  input: BoundReleaseSynchronizationInput,
  health: PluginHealthType,
  evaluatedAt: UtcTimestamp,
  provenance: "provider" | "cache"
) {
  const persistence = yield* Persistence
  const streamKey = yield* Schema.decodeUnknownEffect(PluginStreamKey)(input.streamKey)
  const records = yield* persistence.pluginRuntime.getCache(
    input.workspaceId,
    input.pluginConnectionId,
    streamKey
  )
  const previousRelease = yield* readPreviousRelease(input, records)
  const projection = yield* normalizeFakeReleaseCache(records, {
    workspaceId: input.workspaceId,
    pluginConnectionId: input.pluginConnectionId,
    providerId: input.providerId,
    pluginHealth: health,
    evaluatedAt,
    provenance,
    previousRelease
  })
  if (Option.isNone(projection)) return { releaseId: null, changed: false }
  let changed = false
  for (const person of projection.value.people) {
    const persisted = yield* persistPerson(input.workspaceId, person, projection.value.release.updatedAt)
    changed = changed || persisted.changed
  }
  if (
    provenance === "cache" &&
    previousRelease !== null &&
    (yield* recoveryProjectionsEqual(previousRelease, projection.value.release))
  ) return { releaseId: previousRelease.id, changed }
  const persisted = yield* persistRelease(input.workspaceId, projection.value.release)
  return { releaseId: persisted.record.release.id, changed: changed || persisted.changed }
})

const reconcileProjection = Effect.fn("ReleaseSynchronization.reconcileProjection")(function*(
  input: BoundReleaseSynchronizationInput,
  health: PluginHealthType,
  evaluatedAt: UtcTimestamp,
  provenance: "provider" | "cache"
) {
  const persistence = yield* Persistence
  const wakeups = yield* DomainEventWakeups
  const outcome = yield* persistence.transact(
    Effect.gen(function*() {
      const projected = yield* reconcileProjectionFacts(input, health, evaluatedAt, provenance)
      if (projected.changed) {
        yield* appendPortfolioInvalidation({
          workspaceId: input.workspaceId,
          pluginConnectionId: input.pluginConnectionId,
          releaseId: projected.releaseId,
          occurredAt: evaluatedAt,
          reason: "release-projection"
        })
      }
      return projected
    })
  )
  if (outcome.changed) yield* wakeups.notify(input.workspaceId)
  return outcome.releaseId
})

const lastValidProjectionId = Effect.fn("ReleaseSynchronization.lastValidProjectionId")(function*(
  input: BoundReleaseSynchronizationInput
) {
  const persistence = yield* Persistence
  const streamKey = yield* Schema.decodeUnknownEffect(PluginStreamKey)(input.streamKey)
  const records = yield* persistence.pluginRuntime.getCache(
    input.workspaceId,
    input.pluginConnectionId,
    streamKey
  )
  return (yield* readPreviousRelease(input, records))?.id ?? null
})

const reconcileLastValidProjection = Effect.fn(
  "ReleaseSynchronization.reconcileLastValidProjection"
)(function*(
  input: BoundReleaseSynchronizationInput,
  health: PluginHealthType,
  evaluatedAt: UtcTimestamp,
  provenance: "provider" | "cache"
) {
  return yield* reconcileProjection(input, health, evaluatedAt, provenance).pipe(
    Effect.catchTag("FakeReleaseNormalizationError", () => lastValidProjectionId(input)),
    Effect.catchTag("PersistedRecordError", () => Effect.succeed(null))
  )
})

const initialStream = Effect.fn("ReleaseSynchronization.initialStream")(
  function*(input: BoundReleaseSynchronizationInput) {
    const persistence = yield* Persistence
    const streamKey = yield* Schema.decodeUnknownEffect(PluginStreamKey)(input.streamKey)
    const current = yield* Effect.result(
      persistence.pluginRuntime.getStream(input.workspaceId, input.pluginConnectionId, streamKey)
    )
    if (Result.isFailure(current)) {
      if (current.failure._tag !== "RecordNotFoundError") return yield* Effect.fail(current.failure)
      return { checkpoint: null, revision: 0, streamKey }
    }
    const checkpoint = current.success.checkpointJson === null
      ? null
      : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PluginCheckpointV1))(
        current.success.checkpointJson
      )
    return { checkpoint, revision: current.success.revision, streamKey }
  }
)

const bindProvider = Effect.fn("ReleaseSynchronization.bindProvider")(function*(input: ReleaseSynchronizationInput) {
  const persistence = yield* Persistence
  const connection = yield* persistence.pluginConnections.get(input.workspaceId, input.pluginConnectionId)
  const runtime = yield* persistence.pluginRuntime.getRuntime(input.workspaceId, input.pluginConnectionId)
  if (connection.providerId !== runtime.providerId) {
    return yield* new SourceIdentityMismatchError({
      workspaceId: input.workspaceId,
      recordKind: "plugin-runtime",
      recordKey: input.pluginConnectionId
    })
  }
  return { ...input, providerId: connection.providerId } satisfies BoundReleaseSynchronizationInput
})

/** Rebuild the server-authoritative release projection from the durable plugin cache. */
export const reconcileFakeReleaseProjection = Effect.fn(
  "ReleaseSynchronization.reconcileFakeReleaseProjection"
)(function*(
  input: ReleaseSynchronizationInput,
  health: PluginHealthType,
  evaluatedAt: UtcTimestamp
): Effect.fn.Return<
  Release["id"] | null,
  ReleaseSynchronizationFailure,
  Crypto.Crypto | DomainEventWakeups | Persistence
> {
  const boundInput = yield* bindProvider(input)
  return yield* reconcileProjection(boundInput, health, evaluatedAt, "cache")
})

/** Recover the last valid release projection from durable cache without acquiring a provider. */
export const recoverFakeReleaseProjection = Effect.fn(
  "ReleaseSynchronization.recoverFakeReleaseProjection"
)(function*(
  input: ReleaseSynchronizationInput
): Effect.fn.Return<
  Release["id"] | null,
  ReleaseSynchronizationFailure,
  Crypto.Crypto | DomainEventWakeups | Persistence
> {
  const persistence = yield* Persistence
  const runtime = yield* persistence.pluginRuntime.getRuntime(input.workspaceId, input.pluginConnectionId)
  const boundInput = yield* bindProvider(input)
  const streamKey = yield* Schema.decodeUnknownEffect(PluginStreamKey)(input.streamKey)
  const lastSuccessfulHealth = yield* persistence.pluginRuntime.getLastSuccessfulHealth(
    input.workspaceId,
    input.pluginConnectionId,
    streamKey
  )
  const recoveryHealth = lastSuccessfulHealth ?? runtime.health
  const evaluatedAt = DateTime.makeUnsafe(yield* Effect.clockWith((clock) => clock.currentTimeMillis))
  return yield* reconcileLastValidProjection(
    boundInput,
    recoveryHealth,
    evaluatedAt,
    "cache"
  )
})

/** Close crash-left fake synchronization work as interrupted before startup continues. */
export const reconcileFakeReleaseSyncAttempts = Effect.fn(
  "ReleaseSynchronization.reconcileFakeReleaseSyncAttempts"
)(function*(
  input: ReleaseSynchronizationInput
): Effect.fn.Return<number, ReleaseSynchronizationFailure, Persistence> {
  const persistence = yield* Persistence
  const boundInput = yield* bindProvider(input)
  const streamKey = yield* Schema.decodeUnknownEffect(PluginStreamKey)(input.streamKey)
  const completedAt = DateTime.makeUnsafe(yield* Effect.clockWith((clock) => clock.currentTimeMillis))
  return yield* persistence.pluginRuntime.reconcileSyncAttempts(
    input.workspaceId,
    input.pluginConnectionId,
    boundInput.providerId,
    streamKey,
    completedAt
  )
})

/** Synchronize and materialize one fake release without widening the page transaction boundary. */
export const synchronizeFakeRelease = Effect.fn("ReleaseSynchronization.synchronizeFakeRelease")(function*(
  input: ReleaseSynchronizationInput
): Effect.fn.Return<
  ReleaseSynchronizationOutcome,
  ReleaseSynchronizationFailure,
  Crypto.Crypto | DomainEventWakeups | Persistence | PluginConnection
> {
  const persistence = yield* Persistence
  const connection = yield* PluginConnection
  const boundInput = yield* bindProvider(input)
  const evaluatedAt = DateTime.makeUnsafe(yield* Effect.clockWith((clock) => clock.currentTimeMillis))
  const healthResult = yield* Effect.result(connection.health)
  if (Result.isFailure(healthResult)) {
    const health = yield* failureHealth(healthResult.failure, evaluatedAt)
    yield* persistHealth(boundInput, health, true)
    const releaseId = yield* reconcileLastValidProjection(boundInput, health, evaluatedAt, "cache")
    return { _tag: "source-unavailable", releaseId }
  }
  const health = healthResult.success
  yield* persistHealth(boundInput, health, health._tag === "unavailable")
  if (health._tag === "unavailable" || health._tag === "disabled") {
    const releaseId = yield* reconcileLastValidProjection(boundInput, health, evaluatedAt, "cache")
    return { _tag: "source-unavailable", releaseId }
  }

  const stream = yield* initialStream(boundInput)
  const request = yield* Schema.decodeUnknownEffect(PluginSyncRequestV1)({
    streamKey: input.streamKey,
    checkpoint: stream.checkpoint
  })
  const synchronized = yield* Effect.result(
    Stream.runFoldEffect(
      connection.sync(request),
      () => ({ revision: stream.revision, pagesCommitted: 0, isTerminal: false }),
      (state, page) =>
        Effect.gen(function*() {
          if (state.isTerminal) {
            return yield* new FakeReleaseNormalizationError({
              diagnosticCode: "fake-release-page-after-terminal"
            })
          }
          const currentCache = yield* persistence.pluginRuntime.getCache(
            boundInput.workspaceId,
            boundInput.pluginConnectionId,
            stream.streamKey
          )
          const previousRelease = yield* readPreviousRelease(boundInput, currentCache)
          const collaborators = yield* prevalidateFakeReleasePage(page, currentCache, {
            workspaceId: boundInput.workspaceId,
            pluginConnectionId: boundInput.pluginConnectionId,
            providerId: boundInput.providerId,
            streamKey: stream.streamKey,
            pluginHealth: health,
            evaluatedAt: health.checkedAt,
            provenance: "provider",
            previousRelease
          })
          for (const collaborator of collaborators) {
            const owner = yield* Effect.result(persistence.people.findPersonBySourceIdentity(
              boundInput.workspaceId,
              {
                pluginConnectionId: boundInput.pluginConnectionId,
                providerId: boundInput.providerId,
                vendorPersonId: collaborator.vendorPersonId
              }
            ))
            if (Result.isSuccess(owner) && owner.success.person.personId !== collaborator.personId) {
              return yield* new FakeReleaseNormalizationError({
                diagnosticCode: "fake-release-durable-person-identity-conflict"
              })
            }
            if (Result.isFailure(owner) && owner.failure._tag !== "RecordNotFoundError") {
              return yield* Effect.fail(owner.failure)
            }
          }
          const committed = yield* persistence.pluginRuntime.commitNormalizedPage(
            boundInput.workspaceId,
            boundInput.pluginConnectionId,
            boundInput.providerId,
            stream.streamKey,
            state.revision,
            page,
            health.checkedAt,
            health
          )
          return {
            revision: committed.revision,
            pagesCommitted: state.pagesCommitted + 1,
            isTerminal: !page.hasMore
          }
        })
    )
  )
  if (Result.isFailure(synchronized)) {
    const failure = sourceFailure(synchronized.failure)
    if (failure === null) return yield* Effect.fail(synchronized.failure)
    const failedAt = DateTime.makeUnsafe(yield* Effect.clockWith((clock) => clock.currentTimeMillis))
    const unavailable = yield* failureHealth(failure, failedAt)
    yield* persistHealth(boundInput, unavailable, true)
    const unavailableProjection = yield* reconcileLastValidProjection(boundInput, unavailable, failedAt, "cache")
    const releaseId = unavailableProjection === null
      ? yield* reconcileLastValidProjection(boundInput, health, failedAt, "cache")
      : unavailableProjection
    return { _tag: "source-unavailable", releaseId }
  }
  if (!synchronized.success.isTerminal) {
    const failedAt = DateTime.makeUnsafe(yield* Effect.clockWith((clock) => clock.currentTimeMillis))
    const malformed = new PluginMalformedResponseFailure({
      operation: "sync",
      diagnosticCode: "fake-release-terminal-page-missing"
    })
    const unavailable = yield* failureHealth(malformed, failedAt)
    yield* persistHealth(boundInput, unavailable, true)
    const unavailableProjection = yield* reconcileLastValidProjection(boundInput, unavailable, failedAt, "cache")
    const releaseId = unavailableProjection === null
      ? yield* reconcileLastValidProjection(boundInput, health, failedAt, "cache")
      : unavailableProjection
    return { _tag: "source-unavailable", releaseId }
  }
  const releaseId = yield* reconcileProjection(boundInput, health, health.checkedAt, "provider")
  return {
    _tag: "synchronized",
    pagesCommitted: synchronized.success.pagesCommitted,
    releaseId
  }
})

/** Recover the durable projection before acquiring one scoped provider connection and synchronizing it. */
export const synchronizeFakeReleaseFromMap = Effect.fn(
  "ReleaseSynchronization.synchronizeFakeReleaseFromMap"
)(function*(
  input: ReleaseSynchronizationInput
): Effect.fn.Return<
  ReleaseSynchronizationOutcome,
  ReleaseSynchronizationFailure,
  Crypto.Crypto | DomainEventWakeups | Persistence | PluginConnectionMap
> {
  yield* recoverFakeReleaseProjection(input)
  const persistence = yield* Persistence
  const boundInput = yield* bindProvider(input)
  const streamKey = yield* Schema.decodeUnknownEffect(PluginStreamKey)(input.streamKey)
  const startedAt = DateTime.makeUnsafe(yield* Effect.clockWith((clock) => clock.currentTimeMillis))
  const attempt = yield* persistence.pluginRuntime.beginSyncAttempt(
    input.workspaceId,
    input.pluginConnectionId,
    boundInput.providerId,
    streamKey,
    startedAt
  )
  const connections = yield* PluginConnectionMap
  const synchronized = yield* Effect.result(Effect.scoped(
    Effect.flatMap(
      connections.contextEffect({
        workspaceId: input.workspaceId,
        pluginConnectionId: input.pluginConnectionId
      }),
      (context) => synchronizeFakeRelease(input).pipe(Effect.provide(context))
    )
  ))
  const outcome = yield* Effect.gen(function*() {
    if (Result.isSuccess(synchronized)) return synchronized.success
    if (!isPluginFailure(synchronized.failure)) return yield* Effect.fail(synchronized.failure)
    const failedAt = DateTime.makeUnsafe(yield* Effect.clockWith((clock) => clock.currentTimeMillis))
    const unavailable = yield* failureHealth(synchronized.failure, failedAt)
    yield* persistHealth(boundInput, unavailable, true)
    const releaseId = yield* reconcileLastValidProjection(boundInput, unavailable, failedAt, "cache")
    return { _tag: "source-unavailable", releaseId } satisfies ReleaseSynchronizationOutcome
  })
  const completedAt = DateTime.makeUnsafe(yield* Effect.clockWith((clock) => clock.currentTimeMillis))
  yield* persistence.pluginRuntime.completeSyncAttempt(
    input.workspaceId,
    input.pluginConnectionId,
    streamKey,
    attempt.attemptSequence,
    outcome._tag,
    completedAt
  )
  return outcome
})
