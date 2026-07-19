import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

import type { PluginSynchronizationState } from "../../api/plugins.js"
import { PluginHealth, type PluginHealth as PluginHealthType } from "../../domain/freshness.js"
import type { PluginConnectionId, WorkspaceId } from "../../domain/identifiers.js"
import { PluginCheckpointV1, type PluginSyncPageV1, PluginSyncRequestV1 } from "../../domain/plugins/events.js"
import type { ProviderId } from "../../domain/sourceRevision.js"
import type { UtcTimestamp } from "../../domain/utcTimestamp.js"
import {
  ApplicationInvalidRequest,
  ApplicationResourceNotFound,
  ApplicationServiceUnavailable,
  type PluginAdministrationError
} from "../api/ApplicationServices.js"
import type { PersistenceOperationFailure } from "../persistence/Persistence.js"
import { Persistence } from "../persistence/Persistence.js"
import type {
  PluginSyncAttemptRecord,
  PluginSyncAttemptState
} from "../persistence/repositories/pluginRuntimeModels.js"
import { PluginStreamKey } from "../persistence/repositories/pluginRuntimeModels.js"
import type { PluginFailure } from "../plugins/failures.js"
import { pluginFailureClass, PluginMalformedResponseFailure } from "../plugins/failures.js"
import { PluginConnection, type PluginConnectionV1 } from "../plugins/PluginConnection.js"
import type { PluginConnectionMapV1 } from "../plugins/PluginConnectionMap.js"
import { DomainEventWakeups } from "../runtime/DomainEventWakeups.js"
import { materializeNormalizedPluginPage } from "./normalizedPluginPageMaterialization.js"
import {
  capturePluginSynchronizationAuthority,
  type PluginSynchronizationAuthority,
  verifyPluginSynchronizationAuthority
} from "./pluginSynchronizationAuthority.js"
import { appendPortfolioInvalidation } from "./portfolioInvalidation.js"

const MAXIMUM_PAGES_PER_INVOCATION = 100
const SYNCHRONIZATION_CLAIM_LIFETIME_MINUTES = 15
const SOURCE_UNAVAILABLE_OUTCOME = "source-unavailable"
const SYNCHRONIZED_OUTCOME = "synchronized"

/** One provider-neutral manual synchronization driver with a fixed logical stream identity. */
export interface ManualPluginSyncDriver {
  readonly providerId: ProviderId
  readonly streamKey: string
  readonly sync: (
    connection: PluginConnectionV1,
    request: typeof PluginSyncRequestV1.Type
  ) => Stream.Stream<PluginSyncPageV1, PluginFailure>
}

/** Fixed lookup boundary that keeps provider identifiers out of the orchestration state machine. */
export interface ManualPluginSyncDriverRegistry {
  readonly get: (providerId: ProviderId) => Option.Option<ManualPluginSyncDriver>
}

/** Build a deterministic driver registry for production or fixture connections. */
export const makeManualPluginSyncDriverRegistry = (
  drivers: ReadonlyArray<ManualPluginSyncDriver>
): ManualPluginSyncDriverRegistry => {
  const byProvider = new Map<ProviderId, ManualPluginSyncDriver>()
  for (const driver of drivers) byProvider.set(driver.providerId, driver)
  return { get: (providerId) => Option.fromNullishOr(byProvider.get(providerId)) }
}

const connectionSync = (
  connection: PluginConnectionV1,
  request: typeof PluginSyncRequestV1.Type
) => connection.sync(request)

/** Production drivers for first-party connections that currently negotiate synchronization. */
export const firstPartyManualPluginSyncDrivers = makeManualPluginSyncDriverRegistry([
  { providerId: "codecommit", streamKey: "pull-requests", sync: connectionSync },
  { providerId: "codepipeline", streamKey: "executions", sync: connectionSync },
  { providerId: "jira", streamKey: "project-issues", sync: connectionSync },
  { providerId: "clockify", streamKey: "time-entries", sync: connectionSync }
])

const unavailable = () => new ApplicationServiceUnavailable({ retryAt: null })

const mapPersistenceRead = (
  failure: PersistenceOperationFailure
): ApplicationResourceNotFound | ApplicationServiceUnavailable =>
  failure._tag === "RecordNotFoundError" ? new ApplicationResourceNotFound() : unavailable()

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
  if (
    Predicate.hasProperty(failure, "_tag") &&
    failure._tag === "NormalizedPluginPageMaterializationError"
  ) {
    return new PluginMalformedResponseFailure({
      operation: "manual-sync",
      diagnosticCode: "normalized-plugin-page-rejected"
    })
  }
  if (
    Predicate.hasProperty(failure, "_tag") &&
    failure._tag === "SourceIdentityMismatchError" &&
    Predicate.hasProperty(failure, "recordKind") &&
    (failure.recordKind === "plugin-sync-event" || failure.recordKind === "plugin-sync-page")
  ) {
    return new PluginMalformedResponseFailure({
      operation: "manual-sync",
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

const failureHealth = Effect.fn("ManualPluginSynchronization.failureHealth")(function*(
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

const stateFromAttemptState = (
  pluginConnectionId: PluginConnectionId,
  providerId: ProviderId,
  streamKey: string,
  attemptState: PluginSyncAttemptState
): PluginSynchronizationState => {
  const lastAttempt: PluginSyncAttemptRecord | undefined = attemptState.latestAttempt ?? undefined
  const lastSuccess: PluginSyncAttemptRecord | undefined = attemptState.latestSynchronized ?? undefined
  return {
    pluginConnectionId,
    providerId,
    streamKey,
    lastAttemptAt: lastAttempt?.startedAt ?? null,
    lastSuccessAt: lastSuccess?.completedAt ?? null,
    result: lastAttempt === undefined
      ? "never"
      : lastAttempt.outcome === null
      ? "running"
      : lastAttempt.outcome,
    pagesCommitted: lastAttempt?.pagesCommitted ?? 0
  }
}

interface BoundManualSync {
  readonly workspaceId: WorkspaceId
  readonly pluginConnectionId: PluginConnectionId
  readonly providerId: ProviderId
  readonly driver: ManualPluginSyncDriver
  readonly streamKey: PluginStreamKey
}

interface SynchronizationClaim extends BoundManualSync {
  readonly claimId: string
}

export interface ManualPluginSynchronizationService {
  readonly state: (input: {
    readonly workspaceId: WorkspaceId
    readonly pluginConnectionId: PluginConnectionId
  }) => Effect.Effect<PluginSynchronizationState, ApplicationInvalidRequest | PluginAdministrationError>
  readonly synchronize: (input: {
    readonly workspaceId: WorkspaceId
    readonly pluginConnectionId: PluginConnectionId
  }) => Effect.Effect<PluginSynchronizationState, ApplicationInvalidRequest | PluginAdministrationError>
}

/** Build the bounded synchronization application over a scoped provider runtime map. */
export const makeManualPluginSynchronization = Effect.fn(
  "ManualPluginSynchronization.make"
)(function*(
  connections: PluginConnectionMapV1,
  drivers: ManualPluginSyncDriverRegistry = firstPartyManualPluginSyncDrivers
): Effect.fn.Return<ManualPluginSynchronizationService, never, Crypto.Crypto | DomainEventWakeups | Persistence> {
  const persistence = yield* Persistence
  const wakeups = yield* DomainEventWakeups
  const cryptoService = yield* Crypto.Crypto

  const bind = Effect.fn("ManualPluginSynchronization.bind")(function*(input: {
    readonly workspaceId: WorkspaceId
    readonly pluginConnectionId: PluginConnectionId
  }): Effect.fn.Return<BoundManualSync, ApplicationInvalidRequest | PluginAdministrationError> {
    const connection = yield* persistence.pluginConnections.get(
      input.workspaceId,
      input.pluginConnectionId
    ).pipe(Effect.mapError(mapPersistenceRead))
    const driver = drivers.get(connection.providerId)
    if (Option.isNone(driver)) return yield* new ApplicationInvalidRequest()
    const streamKey = yield* Schema.decodeUnknownEffect(PluginStreamKey)(driver.value.streamKey).pipe(
      Effect.mapError(() => new ApplicationInvalidRequest())
    )
    return { ...input, providerId: connection.providerId, driver: driver.value, streamKey }
  })

  const releaseSynchronization = Effect.fn(
    "ManualPluginSynchronization.releaseSynchronization"
  )(function*(claim: SynchronizationClaim) {
    yield* persistence.pluginRuntime.releaseSyncClaim(
      claim.workspaceId,
      claim.pluginConnectionId,
      claim.streamKey,
      claim.claimId
    ).pipe(Effect.mapError(() => unavailable()))
  })

  const claimSynchronization = Effect.fn(
    "ManualPluginSynchronization.claimSynchronization"
  )(function*(bound: BoundManualSync) {
    const claimId = yield* cryptoService.randomUUIDv4.pipe(Effect.mapError(() => unavailable()))
    const claimedAt = DateTime.makeUnsafe(yield* Effect.clockWith((clock) => clock.currentTimeMillis))
    const expiresAt = DateTime.add(claimedAt, { minutes: SYNCHRONIZATION_CLAIM_LIFETIME_MINUTES })
    const claimed = yield* persistence.pluginRuntime.claimSync(
      bound.workspaceId,
      bound.pluginConnectionId,
      bound.providerId,
      bound.streamKey,
      claimId,
      claimedAt,
      expiresAt
    ).pipe(Effect.mapError(() => unavailable()))
    if (!claimed) return yield* unavailable()
    return { ...bound, claimId }
  })

  const stateFor = Effect.fn("ManualPluginSynchronization.stateFor")(function*(bound: BoundManualSync) {
    const attemptState = yield* persistence.pluginRuntime.getSyncAttemptState(
      bound.workspaceId,
      bound.pluginConnectionId,
      bound.streamKey
    ).pipe(Effect.mapError(() => unavailable()))
    return stateFromAttemptState(
      bound.pluginConnectionId,
      bound.providerId,
      bound.streamKey,
      attemptState
    )
  })

  const readState = Effect.fn("ManualPluginSynchronization.state")(function*(input: {
    readonly workspaceId: WorkspaceId
    readonly pluginConnectionId: PluginConnectionId
  }) {
    const bound = yield* bind(input)
    return yield* stateFor(bound)
  })

  const persistHealth = Effect.fn("ManualPluginSynchronization.persistHealth")(function*(
    bound: BoundManualSync,
    authority: PluginSynchronizationAuthority,
    health: PluginHealthType,
    failed: boolean
  ) {
    const persisted = yield* persistence.transact(Effect.gen(function*() {
      yield* verifyPluginSynchronizationAuthority(persistence, authority)
      const runtime = yield* persistence.pluginRuntime.getRuntime(
        bound.workspaceId,
        bound.pluginConnectionId
      )
      yield* persistence.pluginRuntime.recordHealth(
        bound.workspaceId,
        bound.pluginConnectionId,
        runtime.revision,
        health,
        failed ? runtime.consecutiveFailures + 1 : 0
      )
      yield* appendPortfolioInvalidation({
        workspaceId: bound.workspaceId,
        pluginConnectionId: bound.pluginConnectionId,
        releaseId: null,
        occurredAt: health.checkedAt,
        reason: "plugin-health"
      }).pipe(
        Effect.provideService(Crypto.Crypto, cryptoService),
        Effect.provideService(Persistence, persistence)
      )
      return true
    })).pipe(
      Effect.catchTag("PluginConflictFailure", () => Effect.succeed(false)),
      Effect.mapError(() => unavailable())
    )
    if (persisted) yield* wakeups.notify(bound.workspaceId)
    return persisted
  })

  const initialCheckpoint = Effect.fn("ManualPluginSynchronization.initialCheckpoint")(function*(
    bound: BoundManualSync
  ) {
    const current = yield* Effect.result(
      persistence.pluginRuntime.getStream(bound.workspaceId, bound.pluginConnectionId, bound.streamKey)
    )
    if (Result.isFailure(current)) {
      if (current.failure._tag === "RecordNotFoundError") return null
      return yield* Effect.fail(current.failure)
    }
    return current.success.checkpointJson === null
      ? null
      : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PluginCheckpointV1))(
        current.success.checkpointJson
      )
  })

  const run = Effect.fn("ManualPluginSynchronization.run")(function*(
    bound: BoundManualSync,
    authority: PluginSynchronizationAuthority,
    connection: PluginConnectionV1,
    health: Extract<PluginHealthType, { readonly _tag: "healthy" | "degraded" }>
  ) {
    const checkpoint = yield* initialCheckpoint(bound)
    const request = yield* Schema.decodeUnknownEffect(PluginSyncRequestV1)({
      streamKey: bound.streamKey,
      checkpoint
    })
    const initialStream = yield* Effect.result(
      persistence.pluginRuntime.getStream(bound.workspaceId, bound.pluginConnectionId, bound.streamKey)
    )
    const revision = Result.isSuccess(initialStream) ? initialStream.success.revision : 0
    return yield* Stream.runFoldEffect(
      bound.driver.sync(connection, request).pipe(Stream.take(MAXIMUM_PAGES_PER_INVOCATION)),
      () => ({ isTerminal: false, pagesSeen: 0, pagesCommitted: 0, revision }),
      (state, page) =>
        Effect.gen(function*() {
          if (state.isTerminal) {
            return yield* new PluginMalformedResponseFailure({
              operation: "manual-sync",
              diagnosticCode: "manual-sync-page-after-terminal"
            })
          }
          const committedAt = DateTime.makeUnsafe(yield* Clock.currentTimeMillis)
          const receipt = yield* materializeNormalizedPluginPage({
            workspaceId: bound.workspaceId,
            pluginConnectionId: bound.pluginConnectionId,
            providerId: bound.providerId,
            streamKey: bound.streamKey,
            expectedRevision: state.revision,
            committedAt,
            successfulHealth: health,
            expectedAuthority: authority
          }, page).pipe(
            Effect.provideService(Crypto.Crypto, cryptoService),
            Effect.provideService(Persistence, persistence)
          )
          const pagesSeen = state.pagesSeen + 1
          return {
            isTerminal: !page.hasMore,
            pagesSeen,
            pagesCommitted: state.pagesCommitted + (receipt.pageCommitted ? 1 : 0),
            revision: state.revision + (receipt.pageCommitted ? 1 : 0)
          }
        })
    )
  })

  const synchronizeBound = Effect.fn("ManualPluginSynchronization.synchronizeBound")(function*(
    input: {
      readonly workspaceId: WorkspaceId
      readonly pluginConnectionId: PluginConnectionId
    },
    bound: BoundManualSync
  ) {
    const captured = yield* capturePluginSynchronizationAuthority(
      persistence,
      bound.workspaceId,
      bound.pluginConnectionId
    ).pipe(Effect.mapError(mapPersistenceRead))
    const { authority, connection: connectionRecord } = captured
    if (!connectionRecord.isEnabled) return yield* new ApplicationInvalidRequest()
    const startedAt = DateTime.makeUnsafe(yield* Effect.clockWith((clock) => clock.currentTimeMillis))
    const attempt = yield* persistence.pluginRuntime.beginSyncAttempt(
      bound.workspaceId,
      bound.pluginConnectionId,
      bound.providerId,
      bound.streamKey,
      startedAt
    ).pipe(Effect.mapError(() => unavailable()))
    const synchronized = yield* Effect.result(Effect.scoped(
      Effect.flatMap(
        connections.contextEffect({
          workspaceId: bound.workspaceId,
          pluginConnectionId: bound.pluginConnectionId
        }),
        (context) =>
          Effect.gen(function*() {
            const connection = Context.get(context, PluginConnection)
            const health = yield* connection.health
            if (health._tag === "unavailable" || health._tag === "disabled") return health
            const completed = yield* run(bound, authority, connection, health)
            if (
              !completed.isTerminal &&
              (
                completed.pagesSeen < MAXIMUM_PAGES_PER_INVOCATION ||
                completed.pagesCommitted === 0
              )
            ) {
              return yield* new PluginMalformedResponseFailure({
                operation: "manual-sync",
                diagnosticCode: "manual-sync-terminal-page-missing"
              })
            }
            return health
          }).pipe(Effect.provide(context))
      )
    ))
    const outcome = yield* Effect.gen(function*() {
      if (Result.isSuccess(synchronized)) {
        const health = synchronized.success
        const sourceUnavailable = health._tag === "unavailable" || health._tag === "disabled"
        const healthPersisted = yield* persistHealth(bound, authority, health, sourceUnavailable)
        return sourceUnavailable || !healthPersisted ? SOURCE_UNAVAILABLE_OUTCOME : SYNCHRONIZED_OUTCOME
      }
      const failure = sourceFailure(synchronized.failure)
      if (failure === null) return yield* unavailable()
      const failedAt = DateTime.makeUnsafe(yield* Effect.clockWith((clock) => clock.currentTimeMillis))
      const health = yield* failureHealth(failure, failedAt).pipe(Effect.mapError(() => unavailable()))
      yield* persistHealth(bound, authority, health, true)
      return SOURCE_UNAVAILABLE_OUTCOME
    })
    const completedAt = DateTime.makeUnsafe(yield* Effect.clockWith((clock) => clock.currentTimeMillis))
    yield* persistence.pluginRuntime.completeSyncAttempt(
      bound.workspaceId,
      bound.pluginConnectionId,
      bound.streamKey,
      attempt.attemptSequence,
      outcome,
      completedAt
    ).pipe(Effect.mapError(() => unavailable()))
    return yield* readState(input)
  })

  const synchronize = Effect.fn("ManualPluginSynchronization.synchronize")(function*(input: {
    readonly workspaceId: WorkspaceId
    readonly pluginConnectionId: PluginConnectionId
  }) {
    const bound = yield* bind(input)
    return yield* Effect.acquireUseRelease(
      claimSynchronization(bound),
      () => synchronizeBound(input, bound),
      releaseSynchronization
    )
  })

  return { state: readState, synchronize }
})
