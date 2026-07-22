import {
  renderOpenPluginSyncAttemptsQuery,
  renderPluginSyncAttemptsQuery,
  renderPluginSyncAttemptStateQuery
} from "@knpkv/control-center-sql"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import type { Success } from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import { PluginHealth } from "../../../domain/freshness.js"
import type { PluginConnectionId, WorkspaceId } from "../../../domain/identifiers.js"
import { NegotiatedPluginDescriptorV1 } from "../../../domain/plugins/descriptor.js"
import { NormalizedPluginEventV1, type PluginSyncPageV1 } from "../../../domain/plugins/events.js"
import { ProviderId } from "../../../domain/sourceRevision.js"
import { UtcTimestamp } from "../../../domain/utcTimestamp.js"
import { negotiatePluginDescriptorV1 } from "../../plugins/negotiation.js"
import { Database } from "../Database.js"
import {
  PersistedRecordError,
  PersistenceOperationError,
  RecordNotFoundError,
  RevisionConflictError,
  SourceIdentityMismatchError
} from "../errors.js"
import { mapPersistenceOperation, readChanges } from "./internal.js"
import { ContentBlobDigest } from "./models.js"
import type { CodePipelineCacheSelector, PluginStreamKey } from "./pluginRuntimeModels.js"
import {
  DescriptorCandidate,
  MaximumCodePipelineCorrelationExecutions,
  PluginCacheRecord,
  PluginEvidenceRecord,
  PluginRuntimeRecord,
  PluginStreamRecord,
  PluginSyncAttemptRecord,
  PluginSyncAttemptState,
  PluginSyncCompletionOutcome,
  PluginSyncPage
} from "./pluginRuntimeModels.js"
import { QuarantineRepository } from "./quarantineRepository.js"

type DescriptorRejection = {
  readonly code:
    | "plugin-capability-duplicate"
    | "plugin-contract-major-unsupported"
    | "plugin-descriptor-envelope-invalid"
    | "plugin-descriptor-schema-invalid"
    | "plugin-negotiated-descriptor-invalid"
    | "plugin-required-capability-unsupported"
  readonly summary:
    | "Plugin descriptor contains duplicate capability offers."
    | "Plugin descriptor contract major is unsupported."
    | "Plugin descriptor envelope failed schema validation."
    | "Plugin descriptor candidate failed schema validation."
    | "Negotiated plugin descriptor failed schema validation."
    | "Plugin descriptor requires an unsupported capability version."
}

const descriptorRejection = (diagnosticCode: string): DescriptorRejection => {
  switch (diagnosticCode) {
    case "plugin-capability-duplicate":
      return {
        code: diagnosticCode,
        summary: "Plugin descriptor contains duplicate capability offers."
      }
    case "plugin-contract-major-unsupported":
      return {
        code: diagnosticCode,
        summary: "Plugin descriptor contract major is unsupported."
      }
    case "plugin-descriptor-envelope-invalid":
      return {
        code: diagnosticCode,
        summary: "Plugin descriptor envelope failed schema validation."
      }
    case "plugin-negotiated-descriptor-invalid":
      return {
        code: diagnosticCode,
        summary: "Negotiated plugin descriptor failed schema validation."
      }
    case "plugin-required-capability-unsupported":
      return {
        code: diagnosticCode,
        summary: "Plugin descriptor requires an unsupported capability version."
      }
    case "plugin-descriptor-schema-invalid":
    default:
      return {
        code: "plugin-descriptor-schema-invalid",
        summary: "Plugin descriptor candidate failed schema validation."
      }
  }
}

const serialize = Effect.fn("PluginRuntimeRepository.serialize")(function*(value: unknown) {
  return yield* Effect.try({
    try: () => JSON.stringify(value),
    catch: () => new PersistenceOperationError({ operation: "plugin-runtime.serialize" })
  })
})

const encodeTimestamp = Schema.encodeSync(UtcTimestamp)

const makePluginRuntimeRepository = Effect.gen(function*() {
  const cryptoService = yield* Crypto.Crypto
  const database = yield* Database
  const quarantine = yield* QuarantineRepository
  const sql = database.sql

  const digestText = Effect.fn("PluginRuntimeRepository.digestText")(function*(value: string) {
    const bytes = yield* Effect.fromResult(Encoding.decodeBase64(Encoding.encodeBase64(value))).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "plugin-runtime.digest" }))
    )
    const digest = yield* cryptoService.digest("SHA-256", bytes).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "plugin-runtime.digest" }))
    )
    return ContentBlobDigest.make(Encoding.encodeHex(digest))
  })

  const digestUnknown = Effect.fn("PluginRuntimeRepository.digestUnknown")(function*(value: unknown) {
    const encoded = yield* serialize(value).pipe(Effect.orElseSucceed(() => "<unserializable>"))
    return yield* digestText(encoded)
  })

  const normalizedRecordKey = Effect.fn("PluginRuntimeRepository.normalizedRecordKey")(function*(
    event: typeof NormalizedPluginEventV1.Type
  ) {
    switch (event._tag) {
      case "UpsertEntity":
      case "TombstoneEntity":
        return `entity/${yield* digestText(yield* serialize([event.entityType, event.vendorImmutableId]))}`
      case "AppendEvidence":
        return `evidence/${yield* digestText(yield* serialize(event.evidenceId))}`
      case "UpsertPerson":
        return `person/${yield* digestText(yield* serialize(event.vendorPersonId))}`
      case "ProposeRelationship":
        return `relationship/${yield* digestText(yield* serialize(event.relationshipId))}`
    }
  })

  const readConnectionProvider = Effect.fn("PluginRuntimeRepository.readProvider")(function*(
    workspaceId: WorkspaceId,
    pluginConnectionId: PluginConnectionId
  ) {
    const rows = yield* sql<{ readonly providerId: string }>`SELECT provider_id AS providerId
      FROM plugin_connections
      WHERE workspace_id = ${workspaceId}
        AND plugin_connection_id = ${pluginConnectionId}`
    if (rows.length === 0) {
      return yield* new RecordNotFoundError({
        workspaceId,
        recordKind: "plugin-connection",
        recordKey: pluginConnectionId
      })
    }
    return yield* Schema.decodeUnknownEffect(ProviderId)(rows[0]?.providerId)
  })

  const verifyProvider = Effect.fn("PluginRuntimeRepository.verifyProvider")(function*(
    workspaceId: WorkspaceId,
    pluginConnectionId: PluginConnectionId,
    providerId: typeof ProviderId.Type
  ) {
    const actual = yield* readConnectionProvider(workspaceId, pluginConnectionId)
    if (actual !== providerId) {
      return yield* new SourceIdentityMismatchError({
        workspaceId,
        recordKind: "plugin-runtime",
        recordKey: pluginConnectionId
      })
    }
  })

  const getRuntime = Effect.fn("PluginRuntimeRepository.getRuntime")(function*(
    workspaceId: WorkspaceId,
    pluginConnectionId: PluginConnectionId
  ) {
    const rows = yield* sql<Record<string, unknown>>`SELECT
      workspace_id AS workspaceId, plugin_connection_id AS pluginConnectionId,
      provider_id AS providerId, revision, descriptor_generation AS descriptorGeneration,
      descriptor_schema_version AS descriptorSchemaVersion,
      descriptor_json AS descriptorJson, descriptor_digest AS descriptorDigest,
      accepted_at AS acceptedAt, health_state AS healthState, failure_class AS failureClass,
      safe_message AS safeMessage, checked_at AS checkedAt, retry_at AS retryAt,
      consecutive_failures AS consecutiveFailures
      FROM plugin_runtime_state
      WHERE workspace_id = ${workspaceId} AND plugin_connection_id = ${pluginConnectionId}`.pipe(
      mapPersistenceOperation("plugin-runtime.get")
    )
    if (rows.length === 0) {
      return yield* new RecordNotFoundError({
        workspaceId,
        recordKind: "plugin-runtime",
        recordKey: pluginConnectionId
      })
    }
    const row = rows[0]
    const state = row?.healthState
    const health = state === "healthy" || state === "disabled"
      ? { _tag: state, checkedAt: row?.checkedAt }
      : {
        _tag: state,
        checkedAt: row?.checkedAt,
        failureClass: row?.failureClass,
        retryAt: row?.retryAt,
        safeMessage: row?.safeMessage
      }
    const decoded = Schema.decodeUnknownResult(PluginRuntimeRecord)({ ...row, health })
    const descriptorText = row?.descriptorJson
    const descriptorDigest = row?.descriptorDigest
    const descriptor = typeof descriptorText === "string"
      ? Schema.decodeUnknownResult(Schema.UnknownFromJsonString)(descriptorText)
      : null
    const canonical = descriptor !== null && Result.isSuccess(descriptor)
      ? Schema.decodeUnknownResult(NegotiatedPluginDescriptorV1)(descriptor.success)
      : null
    const actualDigest = typeof descriptorText === "string" ? yield* digestText(descriptorText) : null
    if (
      Result.isFailure(decoded) ||
      canonical === null ||
      Result.isFailure(canonical) ||
      typeof descriptorDigest !== "string" ||
      actualDigest !== descriptorDigest ||
      canonical.success.descriptor.contractVersion.major !== row?.descriptorSchemaVersion
    ) {
      const observedAt = yield* DateTime.now
      yield* quarantine.recordMalformed(workspaceId, {
        recordKind: "plugin-descriptor",
        recordKey: pluginConnectionId,
        schemaVersion: 1,
        payloadDigest: yield* digestUnknown(row),
        diagnosticCode: "plugin-descriptor-schema-invalid",
        diagnosticSummary: "Plugin descriptor candidate failed schema validation.",
        observedAt
      })
      return yield* new PersistedRecordError({
        workspaceId,
        recordKind: "plugin-runtime",
        recordKey: pluginConnectionId,
        diagnosticCode: "plugin-runtime-schema-invalid"
      })
    }
    return decoded.success
  })

  const acceptDescriptor = Effect.fn("PluginRuntimeRepository.acceptDescriptor")(function*(
    workspaceId: WorkspaceId,
    pluginConnectionId: PluginConnectionId,
    candidate: unknown,
    expectedRevision: number,
    acceptedAt: UtcTimestamp
  ) {
    const decoded = Schema.decodeUnknownResult(DescriptorCandidate)(candidate)
    if (Result.isFailure(decoded)) {
      yield* quarantine.recordMalformed(workspaceId, {
        recordKind: "plugin-descriptor",
        recordKey: pluginConnectionId,
        schemaVersion: 1,
        payloadDigest: yield* digestUnknown(candidate),
        diagnosticCode: "plugin-descriptor-schema-invalid",
        diagnosticSummary: "Plugin descriptor candidate failed schema validation.",
        observedAt: acceptedAt
      })
      return yield* new PersistedRecordError({
        workspaceId,
        recordKind: "plugin-descriptor",
        recordKey: pluginConnectionId,
        diagnosticCode: "plugin-descriptor-schema-invalid"
      })
    }
    const descriptorDigest = yield* digestText(decoded.success.descriptorJson)
    const acceptedAtText = encodeTimestamp(acceptedAt)
    yield* database.transaction(
      Effect.gen(function*() {
        yield* verifyProvider(workspaceId, pluginConnectionId, decoded.success.providerId)
        if (expectedRevision === 0) {
          yield* sql`INSERT INTO plugin_runtime_state (
            workspace_id, plugin_connection_id, provider_id, revision,
            descriptor_schema_version, descriptor_json, descriptor_digest, accepted_at,
            health_state, checked_at, consecutive_failures
          ) VALUES (
            ${workspaceId}, ${pluginConnectionId}, ${decoded.success.providerId}, 1,
            ${decoded.success.schemaVersion}, ${decoded.success.descriptorJson}, ${descriptorDigest}, ${acceptedAtText},
            'healthy', ${acceptedAtText}, 0
          ) ON CONFLICT (workspace_id, plugin_connection_id) DO NOTHING`
        } else {
          yield* sql`UPDATE plugin_runtime_state SET
            revision = revision + 1,
            descriptor_generation = descriptor_generation + 1,
            provider_id = ${decoded.success.providerId},
            descriptor_schema_version = ${decoded.success.schemaVersion},
            descriptor_json = ${decoded.success.descriptorJson},
            descriptor_digest = ${descriptorDigest},
            accepted_at = ${acceptedAtText}
            WHERE workspace_id = ${workspaceId} AND plugin_connection_id = ${pluginConnectionId}
              AND revision = ${expectedRevision}`
        }
        if ((yield* readChanges(sql)) === 0) {
          const revisions = yield* sql<{ readonly revision: number }>`SELECT revision FROM plugin_runtime_state
            WHERE workspace_id = ${workspaceId} AND plugin_connection_id = ${pluginConnectionId}`
          return yield* new RevisionConflictError({
            workspaceId,
            recordKind: "plugin-runtime",
            recordKey: pluginConnectionId,
            expectedRevision,
            actualRevision: revisions[0]?.revision ?? null
          })
        }
      })
    ).pipe(mapPersistenceOperation("plugin-runtime.accept-descriptor"))
    return yield* getRuntime(workspaceId, pluginConnectionId)
  })

  const acceptPluginDescriptor = Effect.fn("PluginRuntimeRepository.acceptPluginDescriptor")(function*(
    workspaceId: WorkspaceId,
    pluginConnectionId: PluginConnectionId,
    providerId: typeof ProviderId.Type,
    rawDescriptor: unknown,
    expectedRevision: number,
    observedAt: UtcTimestamp
  ) {
    const payloadDigest = yield* digestUnknown(rawDescriptor)
    const negotiated = yield* negotiatePluginDescriptorV1(rawDescriptor).pipe(Effect.result)
    if (Result.isFailure(negotiated)) {
      const rejection = descriptorRejection(negotiated.failure.diagnosticCode)
      yield* quarantine.recordMalformed(workspaceId, {
        recordKind: "plugin-descriptor",
        recordKey: pluginConnectionId,
        schemaVersion: 1,
        payloadDigest,
        diagnosticCode: rejection.code,
        diagnosticSummary: rejection.summary,
        observedAt
      })
      return yield* new PersistedRecordError({
        workspaceId,
        recordKind: "plugin-descriptor",
        recordKey: pluginConnectionId,
        diagnosticCode: rejection.code
      })
    }

    const connectionProvider = yield* readConnectionProvider(workspaceId, pluginConnectionId).pipe(
      mapPersistenceOperation("plugin-runtime.read-descriptor-provider")
    )
    if (connectionProvider !== providerId) {
      yield* quarantine.recordMalformed(workspaceId, {
        recordKind: "plugin-descriptor",
        recordKey: pluginConnectionId,
        schemaVersion: 1,
        payloadDigest,
        diagnosticCode: "plugin-descriptor-provider-mismatch",
        diagnosticSummary: "Plugin descriptor provider does not match its connection.",
        observedAt
      })
      return yield* new SourceIdentityMismatchError({
        workspaceId,
        recordKind: "plugin-descriptor",
        recordKey: pluginConnectionId
      })
    }

    return yield* acceptDescriptor(
      workspaceId,
      pluginConnectionId,
      {
        providerId,
        schemaVersion: negotiated.success.descriptor.contractVersion.major,
        descriptorJson: yield* serialize(negotiated.success)
      },
      expectedRevision,
      observedAt
    )
  })

  const recordHealth = Effect.fn("PluginRuntimeRepository.recordHealth")(function*(
    workspaceId: WorkspaceId,
    pluginConnectionId: PluginConnectionId,
    expectedRevision: number,
    health: PluginHealth,
    consecutiveFailures: number
  ) {
    const failure = health._tag === "degraded" || health._tag === "unavailable" ? health : undefined
    const checkedAt = encodeTimestamp(health.checkedAt)
    const retryAt = failure?.retryAt === null || failure?.retryAt === undefined
      ? null
      : encodeTimestamp(failure.retryAt)
    yield* database.transaction(
      Effect.gen(function*() {
        yield* sql`UPDATE plugin_runtime_state SET
          revision = revision + 1,
          health_state = ${health._tag},
          failure_class = ${failure?.failureClass ?? null},
          safe_message = ${failure?.safeMessage ?? null},
          checked_at = ${checkedAt},
          retry_at = ${retryAt},
          consecutive_failures = ${consecutiveFailures}
          WHERE workspace_id = ${workspaceId} AND plugin_connection_id = ${pluginConnectionId}
            AND revision = ${expectedRevision}`
        if ((yield* readChanges(sql)) === 0) {
          const revisions = yield* sql<{ readonly revision: number }>`SELECT revision FROM plugin_runtime_state
            WHERE workspace_id = ${workspaceId} AND plugin_connection_id = ${pluginConnectionId}`
          if (revisions.length === 0) {
            return yield* new RecordNotFoundError({
              workspaceId,
              recordKind: "plugin-runtime",
              recordKey: pluginConnectionId
            })
          }
          return yield* new RevisionConflictError({
            workspaceId,
            recordKind: "plugin-runtime",
            recordKey: pluginConnectionId,
            expectedRevision,
            actualRevision: revisions[0]?.revision ?? null
          })
        }
      })
    ).pipe(mapPersistenceOperation("plugin-runtime.record-health"))
    return yield* getRuntime(workspaceId, pluginConnectionId)
  })

  const getStream = Effect.fn("PluginRuntimeRepository.getStream")(function*(
    workspaceId: WorkspaceId,
    pluginConnectionId: PluginConnectionId,
    streamKey: PluginStreamKey
  ) {
    const rows = yield* sql<Record<string, unknown>>`SELECT workspace_id AS workspaceId,
      plugin_connection_id AS pluginConnectionId, provider_id AS providerId,
      stream_key AS streamKey, revision, checkpoint_json AS checkpointJson,
      checkpoint_digest AS checkpointDigest, last_page_id AS lastPageId,
      synchronized_at AS synchronizedAt
      FROM plugin_sync_streams
      WHERE workspace_id = ${workspaceId} AND plugin_connection_id = ${pluginConnectionId}
        AND stream_key = ${streamKey}`
    if (rows.length === 0) {
      return yield* new RecordNotFoundError({
        workspaceId,
        recordKind: "plugin-sync-stream",
        recordKey: pluginConnectionId
      })
    }
    const row = rows[0]
    const decoded = Schema.decodeUnknownResult(PluginStreamRecord)(row)
    const checkpointText = row?.checkpointJson
    const checkpointDigest = row?.checkpointDigest
    const actualDigest = typeof checkpointText === "string" ? yield* digestText(checkpointText) : null
    if (
      Result.isFailure(decoded) ||
      ((checkpointText === null || checkpointText === undefined)
        ? checkpointDigest !== null
        : typeof checkpointDigest !== "string" || actualDigest !== checkpointDigest)
    ) {
      const observedAt = yield* DateTime.now
      yield* quarantine.recordMalformed(workspaceId, {
        recordKind: "plugin-sync-page",
        recordKey: pluginConnectionId,
        schemaVersion: 1,
        payloadDigest: yield* digestUnknown(row),
        diagnosticCode: "plugin-sync-page-schema-invalid",
        diagnosticSummary: "Plugin sync page failed schema validation.",
        observedAt
      })
      return yield* new PersistedRecordError({
        workspaceId,
        recordKind: "plugin-sync-stream",
        recordKey: pluginConnectionId,
        diagnosticCode: "plugin-sync-page-schema-invalid"
      })
    }
    return decoded.success
  })

  const currentStreamRevision = Effect.fn("PluginRuntimeRepository.currentStreamRevision")(function*(
    workspaceId: WorkspaceId,
    pluginConnectionId: PluginConnectionId,
    streamKey: PluginStreamKey
  ) {
    const rows = yield* sql<{ readonly revision: number }>`SELECT revision
      FROM plugin_sync_streams
      WHERE workspace_id = ${workspaceId} AND plugin_connection_id = ${pluginConnectionId}
        AND stream_key = ${streamKey}`
    return rows[0]?.revision ?? 0
  })

  const openSyncAttempts = Effect.fn("PluginRuntimeRepository.openSyncAttempts")(function*(
    workspaceId: WorkspaceId,
    pluginConnectionId: PluginConnectionId,
    streamKey: PluginStreamKey
  ) {
    const rendered = renderOpenPluginSyncAttemptsQuery({ workspaceId, pluginConnectionId, streamKey })
    return yield* sql.unsafe<{
      readonly attemptSequence: number
      readonly startedRevision: number
    }>(rendered.sql, [...rendered.params])
  })

  const reconcileOpenSyncAttempts = Effect.fn("PluginRuntimeRepository.reconcileOpenSyncAttempts")(function*(
    workspaceId: WorkspaceId,
    pluginConnectionId: PluginConnectionId,
    streamKey: PluginStreamKey,
    completedAt: UtcTimestamp
  ) {
    const attempts = yield* openSyncAttempts(workspaceId, pluginConnectionId, streamKey)
    const endingRevision = yield* currentStreamRevision(workspaceId, pluginConnectionId, streamKey)
    for (const attempt of attempts) {
      yield* sql`INSERT INTO plugin_sync_attempt_completions (
        workspace_id, plugin_connection_id, stream_key, attempt_sequence, outcome,
        ending_revision, pages_committed, completed_at
      ) VALUES (
        ${workspaceId}, ${pluginConnectionId}, ${streamKey}, ${attempt.attemptSequence}, 'interrupted',
        ${endingRevision}, ${endingRevision - attempt.startedRevision}, ${encodeTimestamp(completedAt)}
      )`
    }
    return attempts.length
  })

  const reconcileSyncAttempts = Effect.fn("PluginRuntimeRepository.reconcileSyncAttempts")(function*(
    workspaceId: WorkspaceId,
    pluginConnectionId: PluginConnectionId,
    providerId: typeof ProviderId.Type,
    streamKey: PluginStreamKey,
    completedAt: UtcTimestamp
  ) {
    return yield* database.transaction(Effect.gen(function*() {
      yield* verifyProvider(workspaceId, pluginConnectionId, providerId)
      return yield* reconcileOpenSyncAttempts(workspaceId, pluginConnectionId, streamKey, completedAt)
    })).pipe(mapPersistenceOperation("plugin-runtime.reconcile-sync-attempts"))
  })

  const beginSyncAttempt = Effect.fn("PluginRuntimeRepository.beginSyncAttempt")(function*(
    workspaceId: WorkspaceId,
    pluginConnectionId: PluginConnectionId,
    providerId: typeof ProviderId.Type,
    streamKey: PluginStreamKey,
    startedAt: UtcTimestamp
  ) {
    return yield* database.transaction(Effect.gen(function*() {
      yield* verifyProvider(workspaceId, pluginConnectionId, providerId)
      yield* reconcileOpenSyncAttempts(workspaceId, pluginConnectionId, streamKey, startedAt)
      const startedRevision = yield* currentStreamRevision(workspaceId, pluginConnectionId, streamKey)
      const sequences = yield* sql<{ readonly nextSequence: number }>`SELECT
        COALESCE(MAX(attempt_sequence), 0) + 1 AS nextSequence
        FROM plugin_sync_attempts
        WHERE workspace_id = ${workspaceId} AND plugin_connection_id = ${pluginConnectionId}
          AND stream_key = ${streamKey}`
      const attemptSequence = sequences[0]?.nextSequence ?? 1
      yield* sql`INSERT INTO plugin_sync_attempts (
        workspace_id, plugin_connection_id, provider_id, stream_key,
        attempt_sequence, started_revision, started_at
      ) VALUES (
        ${workspaceId}, ${pluginConnectionId}, ${providerId}, ${streamKey},
        ${attemptSequence}, ${startedRevision}, ${encodeTimestamp(startedAt)}
      )`
      return yield* Schema.decodeUnknownEffect(Schema.toType(PluginSyncAttemptRecord))({
        workspaceId,
        pluginConnectionId,
        providerId,
        streamKey,
        attemptSequence,
        startedRevision,
        startedAt,
        outcome: null,
        endingRevision: null,
        pagesCommitted: null,
        completedAt: null
      })
    })).pipe(mapPersistenceOperation("plugin-runtime.begin-sync-attempt"))
  })

  const claimSync = Effect.fn("PluginRuntimeRepository.claimSync")(function*(
    workspaceId: WorkspaceId,
    pluginConnectionId: PluginConnectionId,
    providerId: typeof ProviderId.Type,
    streamKey: PluginStreamKey,
    claimId: string,
    claimedAt: UtcTimestamp,
    expiresAt: UtcTimestamp
  ) {
    return yield* database.transaction(Effect.gen(function*() {
      yield* verifyProvider(workspaceId, pluginConnectionId, providerId)
      yield* sql`DELETE FROM plugin_sync_claims
        WHERE workspace_id = ${workspaceId} AND plugin_connection_id = ${pluginConnectionId}
          AND stream_key = ${streamKey} AND expires_at <= ${encodeTimestamp(claimedAt)}`
      yield* sql`INSERT INTO plugin_sync_claims (
        workspace_id, plugin_connection_id, provider_id, stream_key, claim_id, claimed_at, expires_at
      ) VALUES (
        ${workspaceId}, ${pluginConnectionId}, ${providerId}, ${streamKey}, ${claimId},
        ${encodeTimestamp(claimedAt)}, ${encodeTimestamp(expiresAt)}
      ) ON CONFLICT (workspace_id, plugin_connection_id, stream_key) DO NOTHING`
      return (yield* readChanges(sql)) === 1
    })).pipe(mapPersistenceOperation("plugin-runtime.claim-sync"))
  })

  const releaseSyncClaim = Effect.fn("PluginRuntimeRepository.releaseSyncClaim")(function*(
    workspaceId: WorkspaceId,
    pluginConnectionId: PluginConnectionId,
    streamKey: PluginStreamKey,
    claimId: string
  ) {
    yield* sql`DELETE FROM plugin_sync_claims
      WHERE workspace_id = ${workspaceId} AND plugin_connection_id = ${pluginConnectionId}
        AND stream_key = ${streamKey} AND claim_id = ${claimId}`
  }, mapPersistenceOperation("plugin-runtime.release-sync-claim"))

  const listSyncAttempts = Effect.fn("PluginRuntimeRepository.listSyncAttempts")(function*(
    workspaceId: WorkspaceId,
    pluginConnectionId: PluginConnectionId,
    streamKey: PluginStreamKey
  ) {
    const rendered = renderPluginSyncAttemptsQuery({ workspaceId, pluginConnectionId, streamKey })
    const rows = yield* sql.unsafe<Record<string, unknown>>(rendered.sql, [...rendered.params])
    return yield* Schema.decodeUnknownEffect(Schema.Array(PluginSyncAttemptRecord))(rows)
  })

  const getSyncAttemptState = Effect.fn("PluginRuntimeRepository.getSyncAttemptState")(function*(
    workspaceId: WorkspaceId,
    pluginConnectionId: PluginConnectionId,
    streamKey: PluginStreamKey
  ) {
    const rendered = renderPluginSyncAttemptStateQuery({ workspaceId, pluginConnectionId, streamKey })
    const rows = yield* sql.unsafe<Record<string, unknown>>(rendered.sql, [...rendered.params])
    const decodedRows = yield* Schema.decodeUnknownEffect(
      Schema.Array(PluginSyncAttemptRecord).check(Schema.isMaxLength(2))
    )(rows)
    const latestAttempt = decodedRows.at(0) ?? null
    const latestSynchronized = decodedRows.find(({ outcome }) => outcome === "synchronized") ?? null
    return yield* Schema.decodeUnknownEffect(Schema.toType(PluginSyncAttemptState))({
      latestAttempt,
      latestSynchronized
    })
  })

  const completeSyncAttempt = Effect.fn("PluginRuntimeRepository.completeSyncAttempt")(function*(
    workspaceId: WorkspaceId,
    pluginConnectionId: PluginConnectionId,
    streamKey: PluginStreamKey,
    attemptSequence: number,
    outcome: typeof PluginSyncCompletionOutcome.Type,
    completedAt: UtcTimestamp
  ) {
    return yield* database.transaction(Effect.gen(function*() {
      const decodedOutcome = yield* Schema.decodeUnknownEffect(PluginSyncCompletionOutcome)(outcome)
      const attempts = yield* sql<{ readonly startedRevision: number }>`SELECT
        started_revision AS startedRevision FROM plugin_sync_attempts
        WHERE workspace_id = ${workspaceId} AND plugin_connection_id = ${pluginConnectionId}
          AND stream_key = ${streamKey} AND attempt_sequence = ${attemptSequence}`
      const attempt = attempts[0]
      if (attempt === undefined) {
        return yield* new RecordNotFoundError({
          workspaceId,
          recordKind: "plugin-sync-attempt",
          recordKey: `${pluginConnectionId}/${streamKey}/${attemptSequence}`
        })
      }
      const existingRecords = yield* listSyncAttempts(workspaceId, pluginConnectionId, streamKey)
      const existing = existingRecords.find((record) => record.attemptSequence === attemptSequence)
      if (existing !== undefined && existing.outcome !== null) {
        if (existing.outcome !== decodedOutcome) {
          return yield* new SourceIdentityMismatchError({
            workspaceId,
            recordKind: "plugin-sync-attempt",
            recordKey: `${pluginConnectionId}/${streamKey}/${attemptSequence}`
          })
        }
        return existing
      }
      const endingRevision = yield* currentStreamRevision(workspaceId, pluginConnectionId, streamKey)
      yield* sql`INSERT INTO plugin_sync_attempt_completions (
        workspace_id, plugin_connection_id, stream_key, attempt_sequence, outcome,
        ending_revision, pages_committed, completed_at
      ) VALUES (
        ${workspaceId}, ${pluginConnectionId}, ${streamKey}, ${attemptSequence}, ${decodedOutcome},
        ${endingRevision}, ${endingRevision - attempt.startedRevision}, ${encodeTimestamp(completedAt)}
      )`
      const records = yield* listSyncAttempts(workspaceId, pluginConnectionId, streamKey)
      const completed = records.find((record) => record.attemptSequence === attemptSequence)
      if (
        completed === undefined ||
        completed.outcome !== decodedOutcome ||
        completed.endingRevision !== endingRevision ||
        completed.pagesCommitted !== endingRevision - attempt.startedRevision
      ) {
        return yield* new SourceIdentityMismatchError({
          workspaceId,
          recordKind: "plugin-sync-attempt",
          recordKey: `${pluginConnectionId}/${streamKey}/${attemptSequence}`
        })
      }
      return completed
    })).pipe(mapPersistenceOperation("plugin-runtime.complete-sync-attempt"))
  })

  const commitPageReceipt = Effect.fn("PluginRuntimeRepository.commitPageReceipt")(function*(
    workspaceId: WorkspaceId,
    pluginConnectionId: PluginConnectionId,
    input: unknown
  ) {
    const decoded = Schema.decodeUnknownResult(PluginSyncPage)(input)
    const observedAt = Result.isSuccess(decoded) ? decoded.success.committedAt : yield* DateTime.now
    if (Result.isFailure(decoded)) {
      yield* quarantine.recordMalformed(workspaceId, {
        recordKind: "plugin-sync-page",
        recordKey: pluginConnectionId,
        schemaVersion: 1,
        payloadDigest: yield* digestUnknown(input),
        diagnosticCode: "plugin-sync-page-schema-invalid",
        diagnosticSummary: "Plugin sync page failed schema validation.",
        observedAt
      })
      return yield* new PersistedRecordError({
        workspaceId,
        recordKind: "plugin-sync-page",
        recordKey: pluginConnectionId,
        diagnosticCode: "plugin-sync-page-schema-invalid"
      })
    }
    const page = decoded.success
    const pageDigest = yield* digestText(
      yield* serialize({
        providerId: page.providerId,
        streamKey: page.streamKey,
        pageId: page.pageId,
        checkpointJson: page.checkpointJson,
        hasMore: page.hasMore,
        events: page.events
      })
    )
    const checkpointDigest = yield* digestText(page.checkpointJson)
    const timelineEventDigest = yield* digestText(
      yield* serialize([workspaceId, pluginConnectionId, page.streamKey, page.pageId])
    )
    const successfulHealthJson = yield* serialize(yield* Schema.encodeEffect(PluginHealth)(page.successfulHealth))
    const successfulHealthDigest = yield* digestText(successfulHealthJson)
    const committedAt = encodeTimestamp(page.committedAt)
    const payloadDigests = yield* Effect.forEach(
      page.events,
      (event) => event._tag === "upsert" ? digestText(event.payloadJson) : Effect.succeed(null)
    )
    const eventDigests = yield* Effect.forEach(page.events, (event) => digestText(event.eventJson))
    const acceptedEventIds: Array<string> = []
    let pageCommitted = false

    const committed = yield* database.transaction(
      Effect.gen(function*() {
        yield* verifyProvider(workspaceId, pluginConnectionId, page.providerId)
        yield* sql`INSERT INTO plugin_sync_streams (
          workspace_id, plugin_connection_id, provider_id, stream_key, revision
        ) VALUES (${workspaceId}, ${pluginConnectionId}, ${page.providerId}, ${page.streamKey}, 0)
        ON CONFLICT (workspace_id, plugin_connection_id, stream_key) DO NOTHING`

        const duplicate = yield* sql<{ readonly checkpointDigest: string; readonly pageDigest: string }>`SELECT
          page_digest AS pageDigest, checkpoint_digest AS checkpointDigest
          FROM plugin_sync_pages
          WHERE workspace_id = ${workspaceId} AND plugin_connection_id = ${pluginConnectionId}
            AND stream_key = ${page.streamKey} AND page_id = ${page.pageId}`
        if (duplicate.length > 0) {
          if (duplicate[0]?.pageDigest === pageDigest && duplicate[0]?.checkpointDigest === checkpointDigest) return
          return yield* new SourceIdentityMismatchError({
            workspaceId,
            recordKind: "plugin-sync-page",
            recordKey: pluginConnectionId
          })
        }

        const heads = yield* sql<{ readonly revision: number }>`SELECT revision FROM plugin_sync_streams
          WHERE workspace_id = ${workspaceId} AND plugin_connection_id = ${pluginConnectionId}
            AND stream_key = ${page.streamKey}`
        const actualRevision = heads[0]?.revision ?? null
        if (actualRevision !== page.expectedRevision) {
          return yield* new RevisionConflictError({
            workspaceId,
            recordKind: "plugin-sync-stream",
            recordKey: pluginConnectionId,
            expectedRevision: page.expectedRevision,
            actualRevision
          })
        }

        yield* sql`INSERT INTO plugin_sync_pages (
          workspace_id, plugin_connection_id, stream_key, page_id, expected_revision,
          page_digest, checkpoint_digest, timeline_event_digest, event_count, committed_at, has_more,
          successful_health_json, successful_health_digest
        ) VALUES (
          ${workspaceId}, ${pluginConnectionId}, ${page.streamKey}, ${page.pageId}, ${page.expectedRevision},
          ${pageDigest}, ${checkpointDigest}, ${timelineEventDigest}, ${page.events.length}, ${committedAt}, ${page.hasMore},
          ${successfulHealthJson}, ${successfulHealthDigest}
        )`

        for (let ordinal = 0; ordinal < page.events.length; ordinal++) {
          const event = page.events[ordinal]
          if (event === undefined) continue
          const payloadDigest = payloadDigests[ordinal] ?? null
          const eventDigest = eventDigests[ordinal]
          if (eventDigest === undefined) continue
          const observedAtText = encodeTimestamp(event.observedAt)
          const existingEvent = yield* sql<{ readonly eventDigest: string }>`SELECT event_digest AS eventDigest
            FROM plugin_sync_evidence
            WHERE workspace_id = ${workspaceId} AND plugin_connection_id = ${pluginConnectionId}
              AND stream_key = ${page.streamKey} AND event_id = ${event.eventId}`
          if (existingEvent.length > 0) {
            if (existingEvent[0]?.eventDigest === eventDigest) continue
            return yield* new SourceIdentityMismatchError({
              workspaceId,
              recordKind: "plugin-sync-event",
              recordKey: pluginConnectionId
            })
          }
          yield* sql`INSERT INTO plugin_sync_evidence (
            workspace_id, plugin_connection_id, stream_key, page_id, ordinal,
            event_id, event_digest, event_kind, record_key, source_revision, payload_json, observed_at
          ) VALUES (
            ${workspaceId}, ${pluginConnectionId}, ${page.streamKey}, ${page.pageId}, ${ordinal},
            ${event.eventId}, ${eventDigest}, ${event._tag}, ${event.recordKey}, ${event.sourceRevision},
            ${event.eventJson}, ${observedAtText}
          )`
          acceptedEventIds.push(event.eventId)
          if (event._tag === "upsert") {
            yield* sql`INSERT INTO plugin_cache_entries (
              workspace_id, plugin_connection_id, stream_key, record_key, state,
              payload_json, payload_digest, source_revision, last_page_id, cached_at, tombstoned_at
            ) VALUES (
              ${workspaceId}, ${pluginConnectionId}, ${page.streamKey}, ${event.recordKey}, 'present',
              ${event.payloadJson}, ${payloadDigest}, ${event.sourceRevision}, ${page.pageId}, ${committedAt}, NULL
            ) ON CONFLICT (workspace_id, plugin_connection_id, stream_key, record_key) DO UPDATE SET
              state = 'present', payload_json = excluded.payload_json, payload_digest = excluded.payload_digest,
              source_revision = excluded.source_revision, last_page_id = excluded.last_page_id,
              cached_at = excluded.cached_at, tombstoned_at = NULL`
          } else {
            yield* sql`INSERT INTO plugin_cache_entries (
              workspace_id, plugin_connection_id, stream_key, record_key, state,
              source_revision, last_page_id, cached_at, tombstoned_at
            ) VALUES (
              ${workspaceId}, ${pluginConnectionId}, ${page.streamKey}, ${event.recordKey}, 'tombstoned',
              ${event.sourceRevision}, ${page.pageId}, ${committedAt}, ${observedAtText}
            ) ON CONFLICT (workspace_id, plugin_connection_id, stream_key, record_key) DO UPDATE SET
              state = 'tombstoned', source_revision = excluded.source_revision,
              last_page_id = excluded.last_page_id, cached_at = excluded.cached_at,
              tombstoned_at = excluded.tombstoned_at`
          }
        }

        yield* sql`UPDATE plugin_sync_streams SET revision = revision + 1,
          checkpoint_json = ${page.checkpointJson}, checkpoint_digest = ${checkpointDigest},
          last_page_id = ${page.pageId}, synchronized_at = ${committedAt}
          WHERE workspace_id = ${workspaceId} AND plugin_connection_id = ${pluginConnectionId}
            AND stream_key = ${page.streamKey} AND revision = ${page.expectedRevision}`
        if ((yield* readChanges(sql)) === 0) {
          return yield* new RevisionConflictError({
            workspaceId,
            recordKind: "plugin-sync-stream",
            recordKey: pluginConnectionId,
            expectedRevision: page.expectedRevision,
            actualRevision: null
          })
        }
        pageCommitted = true
      })
    ).pipe(mapPersistenceOperation("plugin-runtime.commit-page"), Effect.result)
    if (Result.isFailure(committed)) {
      const failure = committed.failure
      if (
        Predicate.hasProperty(failure, "_tag") &&
        failure._tag === "SourceIdentityMismatchError" &&
        Predicate.hasProperty(failure, "recordKind") &&
        (failure.recordKind === "plugin-sync-event" || failure.recordKind === "plugin-sync-page")
      ) {
        yield* quarantine.recordMalformed(workspaceId, {
          recordKind: "plugin-sync-page",
          recordKey: pluginConnectionId,
          schemaVersion: 1,
          payloadDigest: pageDigest,
          diagnosticCode: "plugin-sync-page-schema-invalid",
          diagnosticSummary: "Plugin sync page failed schema validation.",
          observedAt
        })
      }
      return yield* Effect.fail(failure)
    }
    return {
      acceptedEventIds,
      pageCommitted,
      stream: yield* getStream(workspaceId, pluginConnectionId, page.streamKey)
    }
  })

  const commitPage = Effect.fn("PluginRuntimeRepository.commitPage")(function*(
    workspaceId: WorkspaceId,
    pluginConnectionId: PluginConnectionId,
    input: unknown
  ) {
    return (yield* commitPageReceipt(workspaceId, pluginConnectionId, input)).stream
  })

  const commitNormalizedPageReceipt = Effect.fn(
    "PluginRuntimeRepository.commitNormalizedPageReceipt"
  )(function*(
    workspaceId: WorkspaceId,
    pluginConnectionId: PluginConnectionId,
    providerId: typeof ProviderId.Type,
    streamKey: PluginStreamKey,
    expectedRevision: number,
    page: PluginSyncPageV1,
    committedAt: UtcTimestamp,
    successfulHealth: PluginHealth
  ) {
    const pageId = yield* digestText(
      yield* serialize({
        checkpointAfterPage: page.checkpointAfterPage,
        eventIds: page.events.map(({ eventId }) => eventId)
      })
    )
    const checkpointJson = yield* serialize(page.checkpointAfterPage)
    const events = yield* Effect.forEach(page.events, (event) =>
      Effect.gen(function*() {
        const payloadJson = yield* serialize(yield* Schema.encodeEffect(NormalizedPluginEventV1)(event))
        const observedAt = encodeTimestamp(event.observedAt)
        switch (event._tag) {
          case "UpsertEntity": {
            const identityDigest = yield* digestText(
              yield* serialize([event.entityType, event.vendorImmutableId])
            )
            return {
              _tag: "upsert",
              eventId: event.eventId,
              eventJson: payloadJson,
              recordKey: `entity/${identityDigest}`,
              sourceRevision: event.revision,
              observedAt,
              payloadJson
            }
          }
          case "TombstoneEntity": {
            const identityDigest = yield* digestText(
              yield* serialize([event.entityType, event.vendorImmutableId])
            )
            return {
              _tag: "tombstone",
              eventId: event.eventId,
              eventJson: payloadJson,
              recordKey: `entity/${identityDigest}`,
              sourceRevision: event.revision,
              observedAt
            }
          }
          case "AppendEvidence": {
            const identityDigest = yield* digestText(yield* serialize(event.evidenceId))
            return {
              _tag: "upsert",
              eventId: event.eventId,
              eventJson: payloadJson,
              recordKey: `evidence/${identityDigest}`,
              sourceRevision: event.revision,
              observedAt,
              payloadJson
            }
          }
          case "UpsertPerson": {
            const identityDigest = yield* digestText(yield* serialize(event.vendorPersonId))
            return {
              _tag: "upsert",
              eventId: event.eventId,
              eventJson: payloadJson,
              recordKey: `person/${identityDigest}`,
              sourceRevision: event.revision,
              observedAt,
              payloadJson
            }
          }
          case "ProposeRelationship": {
            const identityDigest = yield* digestText(yield* serialize(event.relationshipId))
            return {
              _tag: "upsert",
              eventId: event.eventId,
              eventJson: payloadJson,
              recordKey: `relationship/${identityDigest}`,
              sourceRevision: event.revision,
              observedAt,
              payloadJson
            }
          }
        }
      }))
    return yield* commitPageReceipt(workspaceId, pluginConnectionId, {
      providerId,
      streamKey,
      pageId,
      expectedRevision,
      checkpointJson,
      hasMore: page.hasMore,
      successfulHealth: yield* Schema.encodeEffect(PluginHealth)(successfulHealth),
      committedAt: encodeTimestamp(committedAt),
      events
    })
  })

  const commitNormalizedPage = Effect.fn("PluginRuntimeRepository.commitNormalizedPage")(function*(
    workspaceId: WorkspaceId,
    pluginConnectionId: PluginConnectionId,
    providerId: typeof ProviderId.Type,
    streamKey: PluginStreamKey,
    expectedRevision: number,
    page: PluginSyncPageV1,
    committedAt: UtcTimestamp,
    successfulHealth: PluginHealth
  ) {
    return (yield* commitNormalizedPageReceipt(
      workspaceId,
      pluginConnectionId,
      providerId,
      streamKey,
      expectedRevision,
      page,
      committedAt,
      successfulHealth
    )).stream
  })

  const getLastSuccessfulHealth = Effect.fn("PluginRuntimeRepository.getLastSuccessfulHealth")(function*(
    workspaceId: WorkspaceId,
    pluginConnectionId: PluginConnectionId,
    streamKey: PluginStreamKey
  ) {
    const rows = yield* sql<Record<string, unknown>>`SELECT
      page.successful_health_json AS successfulHealthJson,
      page.successful_health_digest AS successfulHealthDigest,
      page.expected_revision AS pageExpectedRevision,
      page.checkpoint_digest AS pageCheckpointDigest,
      page.committed_at AS pageCommittedAt,
      stream.revision AS streamRevision,
      stream.last_page_id AS streamLastPageId,
      stream.checkpoint_digest AS streamCheckpointDigest,
      stream.synchronized_at AS streamSynchronizedAt
      FROM plugin_sync_streams AS stream
      LEFT JOIN plugin_sync_pages AS page
        ON page.workspace_id = stream.workspace_id
        AND page.plugin_connection_id = stream.plugin_connection_id
        AND page.stream_key = stream.stream_key
        AND page.page_id = stream.last_page_id
      WHERE stream.workspace_id = ${workspaceId}
        AND stream.plugin_connection_id = ${pluginConnectionId}
        AND stream.stream_key = ${streamKey}`
    if (rows.length === 0) return null
    const row = rows[0]
    if (
      row?.streamRevision === 0 &&
      row.streamLastPageId === null &&
      row.streamCheckpointDigest === null &&
      row.streamSynchronizedAt === null
    ) return null
    const healthJson = row?.successfulHealthJson
    const healthDigest = row?.successfulHealthDigest
    const exactHead = typeof row?.pageExpectedRevision === "number" &&
      typeof row.streamRevision === "number" &&
      row.pageExpectedRevision + 1 === row.streamRevision &&
      typeof row.pageCheckpointDigest === "string" &&
      row.pageCheckpointDigest === row.streamCheckpointDigest &&
      typeof row.pageCommittedAt === "string" &&
      row.pageCommittedAt === row.streamSynchronizedAt
    if (!exactHead) {
      const observedAt = yield* DateTime.now
      yield* quarantine.recordMalformed(workspaceId, {
        recordKind: "plugin-sync-page",
        recordKey: pluginConnectionId,
        schemaVersion: 1,
        payloadDigest: yield* digestUnknown(row),
        diagnosticCode: "plugin-sync-page-schema-invalid",
        diagnosticSummary: "Plugin sync page failed schema validation.",
        observedAt
      })
      return yield* new PersistedRecordError({
        workspaceId,
        recordKind: "plugin-sync-page",
        recordKey: pluginConnectionId,
        diagnosticCode: "plugin-sync-page-schema-invalid"
      })
    }
    if (healthJson === null && healthDigest === null) return null
    const parsed = typeof healthJson === "string"
      ? Schema.decodeUnknownResult(Schema.fromJsonString(PluginHealth))(healthJson)
      : null
    const actualDigest = typeof healthJson === "string" ? yield* digestText(healthJson) : null
    if (
      parsed === null ||
      Result.isFailure(parsed) ||
      (parsed.success._tag !== "healthy" && parsed.success._tag !== "degraded") ||
      typeof healthDigest !== "string" ||
      actualDigest !== healthDigest
    ) {
      const observedAt = yield* DateTime.now
      yield* quarantine.recordMalformed(workspaceId, {
        recordKind: "plugin-sync-page",
        recordKey: pluginConnectionId,
        schemaVersion: 1,
        payloadDigest: yield* digestUnknown(row),
        diagnosticCode: "plugin-sync-page-schema-invalid",
        diagnosticSummary: "Plugin sync page failed schema validation.",
        observedAt
      })
      return yield* new PersistedRecordError({
        workspaceId,
        recordKind: "plugin-sync-page",
        recordKey: pluginConnectionId,
        diagnosticCode: "plugin-sync-page-schema-invalid"
      })
    }
    return parsed.success
  })

  const decodeCacheRows = Effect.fn("PluginRuntimeRepository.decodeCacheRows")(function*(
    workspaceId: WorkspaceId,
    pluginConnectionId: PluginConnectionId,
    rows: ReadonlyArray<Record<string, unknown>>
  ) {
    const records: Array<typeof PluginCacheRecord.Type> = []
    for (const row of rows) {
      const decoded = Schema.decodeUnknownResult(PluginCacheRecord)(row)
      const payloadText = row.payloadJson
      const payloadDigest = row.payloadDigest
      const payload = typeof payloadText === "string"
        ? Schema.decodeUnknownResult(Schema.UnknownFromJsonString)(payloadText)
        : null
      const normalized = payload !== null && Result.isSuccess(payload)
        ? Schema.decodeUnknownResult(NormalizedPluginEventV1)(payload.success)
        : null
      const latestEventText = row.latestEventJson
      const latestEventPayload = typeof latestEventText === "string"
        ? Schema.decodeUnknownResult(Schema.UnknownFromJsonString)(latestEventText)
        : null
      const latestEvent = latestEventPayload !== null && Result.isSuccess(latestEventPayload)
        ? Schema.decodeUnknownResult(NormalizedPluginEventV1)(latestEventPayload.success)
        : null
      const actualDigest = typeof payloadText === "string" ? yield* digestText(payloadText) : null
      const expectedRecordKey = latestEvent !== null && Result.isSuccess(latestEvent)
        ? yield* normalizedRecordKey(latestEvent.success)
        : null
      const expectedState = latestEvent !== null && Result.isSuccess(latestEvent) &&
          latestEvent.success._tag === "TombstoneEntity"
        ? "tombstoned"
        : "present"
      const payloadValid = payloadText === null
        ? payloadDigest === null
        : normalized !== null &&
          Result.isSuccess(normalized) &&
          actualDigest === payloadDigest &&
          (row.state === "tombstoned" || normalized.success.revision === row.sourceRevision)
      if (
        Result.isFailure(decoded) ||
        !payloadValid ||
        latestEvent === null ||
        Result.isFailure(latestEvent) ||
        expectedRecordKey !== row.recordKey ||
        latestEvent.success.revision !== row.sourceRevision ||
        expectedState !== row.state
      ) {
        const observedAt = yield* DateTime.now
        yield* quarantine.recordMalformed(workspaceId, {
          recordKind: "plugin-sync-page",
          recordKey: pluginConnectionId,
          schemaVersion: 1,
          payloadDigest: yield* digestUnknown(row),
          diagnosticCode: "plugin-sync-page-schema-invalid",
          diagnosticSummary: "Plugin sync page failed schema validation.",
          observedAt
        })
        return yield* new PersistedRecordError({
          workspaceId,
          recordKind: "plugin-sync-page",
          recordKey: pluginConnectionId,
          diagnosticCode: "plugin-sync-page-schema-invalid"
        })
      }
      records.push(decoded.success)
    }
    return records
  })

  const getCache = Effect.fn("PluginRuntimeRepository.getCache")(function*(
    workspaceId: WorkspaceId,
    pluginConnectionId: PluginConnectionId,
    streamKey: PluginStreamKey
  ) {
    const rows = yield* sql<Record<string, unknown>>`SELECT cache.workspace_id AS workspaceId,
      cache.plugin_connection_id AS pluginConnectionId, cache.stream_key AS streamKey,
      cache.record_key AS recordKey, cache.state, cache.payload_json AS payloadJson,
      cache.payload_digest AS payloadDigest, cache.source_revision AS sourceRevision,
      cache.last_page_id AS lastPageId, cache.cached_at AS cachedAt, cache.tombstoned_at AS tombstonedAt,
      (SELECT evidence.payload_json FROM plugin_sync_evidence AS evidence
        WHERE evidence.workspace_id = cache.workspace_id
          AND evidence.plugin_connection_id = cache.plugin_connection_id
          AND evidence.stream_key = cache.stream_key
          AND evidence.page_id = cache.last_page_id
          AND evidence.record_key = cache.record_key
        ORDER BY evidence.ordinal DESC LIMIT 1) AS latestEventJson
      FROM plugin_cache_entries AS cache WHERE cache.workspace_id = ${workspaceId}
        AND cache.plugin_connection_id = ${pluginConnectionId} AND cache.stream_key = ${streamKey}
      ORDER BY cache.record_key`
    return yield* decodeCacheRows(workspaceId, pluginConnectionId, rows)
  })

  const getCodePipelineCache = Effect.fn("PluginRuntimeRepository.getCodePipelineCache")(function*(
    workspaceId: WorkspaceId,
    pluginConnectionId: PluginConnectionId,
    streamKey: PluginStreamKey,
    selectors: ReadonlyArray<CodePipelineCacheSelector>
  ) {
    const maximumExecutions = MaximumCodePipelineCorrelationExecutions
    const executionSelectors = new Map<string, CodePipelineCacheSelector>()
    const declarations = new Map<string, CodePipelineCacheSelector>()
    for (const selector of selectors) {
      if (selector.executionId === null) {
        const key = `${selector.pipelineName}\u0000${String(selector.pipelineVersion ?? "")}`
        if (declarations.size < maximumExecutions) declarations.set(key, selector)
      } else if (executionSelectors.size < maximumExecutions) {
        const key = `${selector.pipelineName}\u0000${selector.executionId}`
        executionSelectors.set(key, selector)
      }
    }

    for (const selector of declarations.values()) {
      if (executionSelectors.size >= maximumExecutions) break
      const executionRows = selector.pipelineVersion === null
        ? yield* sql<{ readonly executionId: unknown }>`SELECT
          CASE WHEN json_valid(payload_json)
            THEN json_extract(payload_json, '$.attributes.executionId') END AS executionId
          FROM plugin_cache_entries
          WHERE workspace_id = ${workspaceId}
            AND plugin_connection_id = ${pluginConnectionId}
            AND stream_key = ${streamKey}
            AND state = 'present'
            AND CASE WHEN json_valid(payload_json)
              THEN json_extract(payload_json, '$.attributes.pipelineName') END = ${selector.pipelineName}
            AND CASE WHEN json_valid(payload_json)
              THEN json_extract(payload_json, '$.entityType') END = 'aws.codepipeline.execution'
          ORDER BY cached_at DESC, record_key
          LIMIT ${maximumExecutions}`
        : yield* sql<{ readonly executionId: unknown }>`SELECT
          CASE WHEN json_valid(payload_json)
            THEN json_extract(payload_json, '$.attributes.executionId') END AS executionId
          FROM plugin_cache_entries
          WHERE workspace_id = ${workspaceId}
            AND plugin_connection_id = ${pluginConnectionId}
            AND stream_key = ${streamKey}
            AND state = 'present'
            AND CASE WHEN json_valid(payload_json)
              THEN json_extract(payload_json, '$.attributes.pipelineName') END = ${selector.pipelineName}
            AND CASE WHEN json_valid(payload_json)
              THEN json_extract(payload_json, '$.entityType') END = 'aws.codepipeline.execution'
            AND (
              CASE WHEN json_valid(payload_json)
                THEN json_extract(payload_json, '$.attributes.pipelineVersion') END = ${selector.pipelineVersion}
              OR CASE WHEN json_valid(payload_json)
                THEN json_extract(payload_json, '$.attributes.pipelineVersion') END IS NULL
            )
          ORDER BY cached_at DESC, record_key
          LIMIT ${maximumExecutions}`
      for (const row of executionRows) {
        if (executionSelectors.size >= maximumExecutions || typeof row.executionId !== "string") break
        const executionId = row.executionId.trim()
        if (executionId.length === 0 || executionId.length > 512) continue
        const executionSelector = { ...selector, executionId }
        executionSelectors.set(`${selector.pipelineName}\u0000${executionId}`, executionSelector)
      }
    }

    const records = new Map<string, typeof PluginCacheRecord.Type>()
    for (const selector of executionSelectors.values()) {
      const rows = yield* sql<Record<string, unknown>>`SELECT cache.workspace_id AS workspaceId,
        cache.plugin_connection_id AS pluginConnectionId, cache.stream_key AS streamKey,
        cache.record_key AS recordKey, cache.state, cache.payload_json AS payloadJson,
        cache.payload_digest AS payloadDigest, cache.source_revision AS sourceRevision,
        cache.last_page_id AS lastPageId, cache.cached_at AS cachedAt, cache.tombstoned_at AS tombstonedAt,
        (SELECT evidence.payload_json FROM plugin_sync_evidence AS evidence
          WHERE evidence.workspace_id = cache.workspace_id
            AND evidence.plugin_connection_id = cache.plugin_connection_id
            AND evidence.stream_key = cache.stream_key
            AND evidence.page_id = cache.last_page_id
            AND evidence.record_key = cache.record_key
          ORDER BY evidence.ordinal DESC LIMIT 1) AS latestEventJson
        FROM plugin_cache_entries AS cache
        WHERE cache.workspace_id = ${workspaceId}
          AND cache.plugin_connection_id = ${pluginConnectionId}
          AND cache.stream_key = ${streamKey}
          AND cache.state = 'present'
          AND CASE WHEN json_valid(cache.payload_json)
            THEN json_extract(cache.payload_json, '$.attributes.pipelineName') END = ${selector.pipelineName}
          AND CASE WHEN json_valid(cache.payload_json)
            THEN json_extract(cache.payload_json, '$.entityType') END IN (
              'aws.codepipeline.pipeline',
              'aws.codepipeline.execution',
              'aws.codepipeline.stage',
              'aws.codepipeline.action'
            )
          AND (
            CASE WHEN json_valid(cache.payload_json)
              THEN json_extract(cache.payload_json, '$.entityType') END = 'aws.codepipeline.pipeline'
            OR CASE WHEN json_valid(cache.payload_json)
              THEN json_extract(cache.payload_json, '$.attributes.executionId') END = ${selector.executionId}
          )
        ORDER BY CASE WHEN json_valid(cache.payload_json) THEN
          CASE json_extract(cache.payload_json, '$.entityType')
            WHEN 'aws.codepipeline.execution' THEN 0
            WHEN 'aws.codepipeline.pipeline' THEN 1
            WHEN 'aws.codepipeline.stage' THEN 2
            ELSE 3
          END ELSE 4 END, cache.cached_at DESC, cache.record_key
        LIMIT 503`
      for (const record of yield* decodeCacheRows(workspaceId, pluginConnectionId, rows)) {
        records.set(record.recordKey, record)
      }
    }
    return [...records.values()]
  })

  const listEvidence = Effect.fn("PluginRuntimeRepository.listEvidence")(function*(
    workspaceId: WorkspaceId,
    pluginConnectionId: PluginConnectionId,
    streamKey: PluginStreamKey
  ) {
    const rows = yield* sql<Record<string, unknown>>`SELECT evidence.workspace_id AS workspaceId,
      evidence.plugin_connection_id AS pluginConnectionId, evidence.stream_key AS streamKey,
      evidence.page_id AS pageId, evidence.ordinal, evidence.event_kind AS eventKind,
      evidence.event_id AS eventId, evidence.event_digest AS eventDigest,
      evidence.record_key AS recordKey, evidence.source_revision AS sourceRevision,
      evidence.payload_json AS payloadJson,
      evidence.observed_at AS observedAt
      FROM plugin_sync_evidence AS evidence
      INNER JOIN plugin_sync_pages AS page
        ON page.workspace_id = evidence.workspace_id
        AND page.plugin_connection_id = evidence.plugin_connection_id
        AND page.stream_key = evidence.stream_key
        AND page.page_id = evidence.page_id
      WHERE evidence.workspace_id = ${workspaceId}
        AND evidence.plugin_connection_id = ${pluginConnectionId} AND evidence.stream_key = ${streamKey}
      ORDER BY page.expected_revision, evidence.ordinal`
    const records: Array<typeof PluginEvidenceRecord.Type> = []
    for (const row of rows) {
      const decoded = Schema.decodeUnknownResult(PluginEvidenceRecord)(row)
      const payloadText = row.payloadJson
      const payload = typeof payloadText === "string"
        ? Schema.decodeUnknownResult(Schema.UnknownFromJsonString)(payloadText)
        : null
      const normalized = payload !== null && Result.isSuccess(payload)
        ? Schema.decodeUnknownResult(NormalizedPluginEventV1)(payload.success)
        : null
      const actualDigest = typeof payloadText === "string" ? yield* digestText(payloadText) : null
      const expectedRecordKey = normalized !== null && Result.isSuccess(normalized)
        ? yield* normalizedRecordKey(normalized.success)
        : null
      const eventKind =
        normalized !== null && Result.isSuccess(normalized) && normalized.success._tag === "TombstoneEntity"
          ? "tombstone"
          : "upsert"
      if (
        Result.isFailure(decoded) ||
        normalized === null ||
        Result.isFailure(normalized) ||
        actualDigest !== row.eventDigest ||
        normalized.success.eventId !== row.eventId ||
        normalized.success.revision !== row.sourceRevision ||
        encodeTimestamp(normalized.success.observedAt) !== row.observedAt ||
        expectedRecordKey !== row.recordKey ||
        eventKind !== row.eventKind
      ) {
        const observedAt = yield* DateTime.now
        yield* quarantine.recordMalformed(workspaceId, {
          recordKind: "plugin-sync-page",
          recordKey: pluginConnectionId,
          schemaVersion: 1,
          payloadDigest: yield* digestUnknown(row),
          diagnosticCode: "plugin-sync-page-schema-invalid",
          diagnosticSummary: "Plugin sync page failed schema validation.",
          observedAt
        })
        return yield* new PersistedRecordError({
          workspaceId,
          recordKind: "plugin-sync-page",
          recordKey: pluginConnectionId,
          diagnosticCode: "plugin-sync-page-schema-invalid"
        })
      }
      records.push(decoded.success)
    }
    return records
  })

  return {
    acceptPluginDescriptor,
    beginSyncAttempt,
    claimSync,
    commitNormalizedPage,
    commitNormalizedPageReceipt,
    commitPage,
    completeSyncAttempt,
    getCache,
    getCodePipelineCache,
    getLastSuccessfulHealth,
    getRuntime,
    getSyncAttemptState,
    getStream,
    listEvidence,
    listSyncAttempts,
    reconcileSyncAttempts,
    releaseSyncClaim,
    recordHealth
  }
})

/** Durable descriptor, health, checkpoint, last-valid cache, and evidence repository. */
export interface PluginRuntimeRepositoryService extends Success<typeof makePluginRuntimeRepository> {}

export class PluginRuntimeRepository extends Context.Service<
  PluginRuntimeRepository,
  PluginRuntimeRepositoryService
>()("@knpkv/control-center/PluginRuntimeRepository") {
  static readonly layer = Layer.effect(PluginRuntimeRepository, makePluginRuntimeRepository)
}
