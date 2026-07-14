import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import type { Success } from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import { PortfolioInvalidatedEventV1, PortfolioInvalidatedPayloadV1 } from "../../../domain/domainEvent.js"
import type { WorkspaceId } from "../../../domain/identifiers.js"
import { DomainEventId, EventCursor } from "../../../domain/identifiers.js"
import { UtcTimestamp } from "../../../domain/utcTimestamp.js"
import { Database } from "../Database.js"
import {
  PersistedRecordError,
  PersistenceOperationError,
  type QuarantineWriteError,
  SourceIdentityMismatchError
} from "../errors.js"
import {
  AppendDomainEventInput,
  type AppendDomainEventInput as AppendDomainEventInputType,
  type DomainEventPage,
  DomainEventPageSize,
  type DomainEventPruneResult,
  DomainEventPruneSize,
  DomainEventRow,
  type DomainEventRow as DomainEventRowType,
  DomainEventStreamState,
  PersistedEventCursor
} from "./domainEventModels.js"
import { mapPersistenceOperation } from "./internal.js"
import { ContentBlobDigest } from "./models.js"
import { makePersistedRowQuarantine } from "./persistedRowQuarantine.js"
import { QuarantineRepository } from "./quarantineRepository.js"

const AllocatedCursorRow = Schema.Struct({ eventCursor: PersistedEventCursor })
const EventIdentity = Schema.Struct({ eventId: DomainEventId })
const payloadJson = Schema.fromJsonString(PortfolioInvalidatedPayloadV1)

const DedupeSemantic = Schema.Struct({
  schemaVersion: AppendDomainEventInput.fields.schemaVersion,
  eventType: AppendDomainEventInput.fields.eventType,
  occurredAt: AppendDomainEventInput.fields.occurredAt,
  causationId: AppendDomainEventInput.fields.causationId,
  correlationId: AppendDomainEventInput.fields.correlationId,
  metadata: AppendDomainEventInput.fields.metadata,
  payload: AppendDomainEventInput.fields.payload
})
const semanticJson = Schema.fromJsonString(DedupeSemantic)
const NO_EVENT_ROWS: ReadonlyArray<unknown> = []

const encodeDigest = (bytes: Uint8Array): string => Encoding.encodeHex(bytes)

const metadataColumns = (metadata: AppendDomainEventInputType["metadata"]) => ({
  releaseId: metadata.releaseId ?? null,
  pluginConnectionId: metadata.pluginConnectionId ?? null,
  entityId: metadata.entityId ?? null,
  jobId: metadata.jobId ?? null
})

const makeMetadata = (row: DomainEventRowType): Record<string, string> => ({
  ...(row.releaseId === null ? {} : { releaseId: row.releaseId }),
  ...(row.pluginConnectionId === null ? {} : { pluginConnectionId: row.pluginConnectionId }),
  ...(row.entityId === null ? {} : { entityId: row.entityId }),
  ...(row.jobId === null ? {} : { jobId: row.jobId })
})

const makeDomainEventRepository = Effect.gen(function*() {
  const cryptoService = yield* Crypto.Crypto
  const database = yield* Database
  const quarantine = yield* QuarantineRepository
  const quarantineRow = makePersistedRowQuarantine(cryptoService, quarantine)
  const sql = database.sql

  const digestText = Effect.fn("DomainEventRepository.digestText")(function*(value: string) {
    const bytes = yield* Effect.fromResult(
      Encoding.decodeBase64(Encoding.encodeBase64(value))
    ).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "domain-event.encode" }))
    )
    const digest = yield* cryptoService.digest("SHA-256", bytes).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "domain-event.digest" }))
    )
    return ContentBlobDigest.make(encodeDigest(digest))
  })

  const findEventRowsByIdentity = (
    workspaceId: typeof WorkspaceId.Type,
    eventId: typeof DomainEventId.Type,
    eventType: AppendDomainEventInputType["eventType"],
    dedupeKey: AppendDomainEventInputType["dedupeKey"]
  ) =>
    sql<Record<string, unknown>>`SELECT
      workspace_id AS workspaceId,
      event_cursor AS eventCursor,
      event_id AS eventId,
      schema_version AS schemaVersion,
      event_type AS eventType,
      dedupe_key AS dedupeKey,
      release_id AS releaseId,
      plugin_connection_id AS pluginConnectionId,
      entity_id AS entityId,
      job_id AS jobId,
      occurred_at AS occurredAt,
      ingested_at AS ingestedAt,
      causation_id AS causationId,
      correlation_id AS correlationId,
      payload_json AS payloadJson,
      payload_digest AS payloadDigest
    FROM domain_events
    WHERE workspace_id = ${workspaceId}
      AND (
        event_id = ${eventId}
        OR (event_type = ${eventType} AND dedupe_key = ${dedupeKey})
      )
    ORDER BY event_cursor`

  const findEventRowsAfter = (
    workspaceId: typeof WorkspaceId.Type,
    after: typeof EventCursor.Type,
    limit: typeof DomainEventPageSize.Type
  ) =>
    sql<Record<string, unknown>>`SELECT
      workspace_id AS workspaceId,
      event_cursor AS eventCursor,
      event_id AS eventId,
      schema_version AS schemaVersion,
      event_type AS eventType,
      dedupe_key AS dedupeKey,
      release_id AS releaseId,
      plugin_connection_id AS pluginConnectionId,
      entity_id AS entityId,
      job_id AS jobId,
      occurred_at AS occurredAt,
      ingested_at AS ingestedAt,
      causation_id AS causationId,
      correlation_id AS correlationId,
      payload_json AS payloadJson,
      payload_digest AS payloadDigest
    FROM domain_events
    WHERE workspace_id = ${workspaceId}
      AND event_cursor > ${after}
    ORDER BY event_cursor
    LIMIT ${limit}`

  const quarantineMalformed = Effect.fn("DomainEventRepository.quarantineMalformed")(function*(
    workspaceId: typeof WorkspaceId.Type,
    rawRow: unknown,
    diagnosticCode: "domain-event-payload-digest-mismatch" | "domain-event-schema-invalid",
    diagnosticSummary:
      | "Stored domain event payload digest does not match its content."
      | "Stored domain event failed schema validation."
  ) {
    const identity = Schema.decodeUnknownResult(EventIdentity)(rawRow)
    yield* quarantineRow({
      workspaceId,
      recordKind: "domain-event",
      recordKey: Result.isSuccess(identity) ? identity.success.eventId : workspaceId,
      diagnosticCode,
      diagnosticSummary,
      observedAt: yield* DateTime.now,
      row: rawRow
    })
  })

  const decodeRow = Effect.fn("DomainEventRepository.decodeRow")(function*(
    workspaceId: typeof WorkspaceId.Type,
    rawRow: unknown
  ) {
    const decodedRow = Schema.decodeUnknownResult(DomainEventRow)(rawRow)
    if (Result.isFailure(decodedRow)) {
      yield* quarantineMalformed(
        workspaceId,
        rawRow,
        "domain-event-schema-invalid",
        "Stored domain event failed schema validation."
      )
      return yield* new PersistedRecordError({
        workspaceId,
        recordKind: "domain-event",
        recordKey: workspaceId,
        diagnosticCode: "domain-event-schema-invalid"
      })
    }
    const row = decodedRow.success
    const actualDigest = yield* digestText(row.payloadJson)
    if (actualDigest !== row.payloadDigest) {
      yield* quarantineMalformed(
        workspaceId,
        rawRow,
        "domain-event-payload-digest-mismatch",
        "Stored domain event payload digest does not match its content."
      )
      return yield* new PersistedRecordError({
        workspaceId,
        recordKind: "domain-event",
        recordKey: row.eventId,
        diagnosticCode: "domain-event-payload-digest-mismatch"
      })
    }
    const payload = yield* Schema.decodeUnknownEffect(payloadJson)(row.payloadJson).pipe(
      Effect.catchTag("SchemaError", () =>
        Effect.gen(function*() {
          yield* quarantineMalformed(
            workspaceId,
            rawRow,
            "domain-event-schema-invalid",
            "Stored domain event failed schema validation."
          )
          return yield* new PersistedRecordError({
            workspaceId,
            recordKind: "domain-event",
            recordKey: row.eventId,
            diagnosticCode: "domain-event-schema-invalid"
          })
        }))
    )
    const decodedEvent = Schema.decodeUnknownResult(Schema.toType(PortfolioInvalidatedEventV1))({
      schemaVersion: row.schemaVersion,
      eventId: row.eventId,
      eventCursor: row.eventCursor,
      workspaceId: row.workspaceId,
      eventType: row.eventType,
      occurredAt: row.occurredAt,
      ingestedAt: row.ingestedAt,
      causationId: row.causationId,
      correlationId: row.correlationId,
      metadata: makeMetadata(row),
      payload
    })
    if (Result.isFailure(decodedEvent)) {
      yield* quarantineMalformed(
        workspaceId,
        rawRow,
        "domain-event-schema-invalid",
        "Stored domain event failed schema validation."
      )
      return yield* new PersistedRecordError({
        workspaceId,
        recordKind: "domain-event",
        recordKey: row.eventId,
        diagnosticCode: "domain-event-schema-invalid"
      })
    }
    return { event: decodedEvent.success, row }
  })

  const readStreamState = Effect.fn("DomainEventRepository.readStreamState")(function*(
    workspaceId: typeof WorkspaceId.Type
  ) {
    const rows = yield* sql<Record<string, unknown>>`SELECT
      next_cursor - 1 AS headCursor,
      pruned_through_cursor AS prunedThroughCursor
    FROM domain_event_streams
    WHERE workspace_id = ${workspaceId}`.pipe(
      mapPersistenceOperation("domain-event.stream-state")
    )
    if (rows.length === 0) {
      return DomainEventStreamState.make({
        headCursor: EventCursor.make(0),
        prunedThroughCursor: EventCursor.make(0)
      })
    }
    return yield* Schema.decodeUnknownEffect(DomainEventStreamState)(rows[0]).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "domain-event.stream-state" }))
    )
  })

  const encodeSemantic = Effect.fn("DomainEventRepository.encodeSemantic")(function*(input: {
    readonly schemaVersion: AppendDomainEventInputType["schemaVersion"]
    readonly eventType: AppendDomainEventInputType["eventType"]
    readonly occurredAt: AppendDomainEventInputType["occurredAt"]
    readonly causationId: AppendDomainEventInputType["causationId"]
    readonly correlationId: AppendDomainEventInputType["correlationId"]
    readonly metadata: AppendDomainEventInputType["metadata"]
    readonly payload: AppendDomainEventInputType["payload"]
  }) {
    return yield* Schema.encodeEffect(semanticJson)(input).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "domain-event.encode-semantic" }))
    )
  })

  const append = Effect.fn("DomainEventRepository.append")(function*(
    workspaceId: typeof WorkspaceId.Type,
    input: AppendDomainEventInputType
  ) {
    const decodedInput = yield* Schema.decodeUnknownEffect(
      Schema.toType(AppendDomainEventInput)
    )(input).pipe(
      Effect.mapError(
        () => new PersistenceOperationError({ operation: "domain-event.append-input" })
      )
    )
    const encodedPayload = yield* Schema.encodeEffect(payloadJson)(decodedInput.payload).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "domain-event.encode-payload" }))
    )
    const payloadDigest = yield* digestText(encodedPayload)
    const ingestedAt = yield* DateTime.now
    const encodedOccurredAt = yield* Schema.encodeEffect(UtcTimestamp)(
      decodedInput.occurredAt
    ).pipe(
      Effect.mapError(
        () => new PersistenceOperationError({ operation: "domain-event.encode-occurred-at" })
      )
    )
    const encodedIngestedAt = yield* Schema.encodeEffect(UtcTimestamp)(ingestedAt).pipe(
      Effect.mapError(
        () => new PersistenceOperationError({ operation: "domain-event.encode-ingested-at" })
      )
    )
    const metadata = metadataColumns(decodedInput.metadata)

    const rows = yield* database.transaction(
      Effect.gen(function*() {
        const existing = yield* findEventRowsByIdentity(
          workspaceId,
          decodedInput.eventId,
          decodedInput.eventType,
          decodedInput.dedupeKey
        )
        if (existing.length > 1) {
          return yield* new SourceIdentityMismatchError({
            workspaceId,
            recordKind: "domain-event",
            recordKey: decodedInput.eventId
          })
        }
        if (existing.length > 0) return existing

        yield* sql`INSERT INTO domain_event_streams (
          workspace_id, next_cursor, pruned_through_cursor, updated_at
        ) VALUES (${workspaceId}, 1, 0, ${encodedIngestedAt})
        ON CONFLICT (workspace_id) DO NOTHING`

        const allocatedRows = yield* sql`UPDATE domain_event_streams
          SET next_cursor = next_cursor + 1,
              updated_at = ${encodedIngestedAt}
          WHERE workspace_id = ${workspaceId}
            AND next_cursor < 9007199254740991
          RETURNING next_cursor - 1 AS eventCursor`
        const allocated = yield* Schema.decodeUnknownEffect(Schema.Array(AllocatedCursorRow))(allocatedRows).pipe(
          Effect.mapError(() => new PersistenceOperationError({ operation: "domain-event.allocate-cursor" }))
        )
        const eventCursor = allocated[0]?.eventCursor
        if (eventCursor === undefined) {
          return yield* new PersistenceOperationError({ operation: "domain-event.cursor-exhausted" })
        }

        yield* sql`INSERT INTO domain_events (
          workspace_id, event_cursor, event_id, schema_version, event_type,
          dedupe_key, release_id, plugin_connection_id, entity_id, job_id,
          occurred_at, ingested_at, causation_id, correlation_id,
          payload_json, payload_digest
        ) VALUES (
          ${workspaceId}, ${eventCursor}, ${decodedInput.eventId}, ${decodedInput.schemaVersion},
          ${decodedInput.eventType}, ${decodedInput.dedupeKey}, ${metadata.releaseId},
          ${metadata.pluginConnectionId}, ${metadata.entityId}, ${metadata.jobId},
          ${encodedOccurredAt}, ${encodedIngestedAt}, ${decodedInput.causationId},
          ${decodedInput.correlationId}, ${encodedPayload}, ${payloadDigest}
        )`
        return yield* findEventRowsByIdentity(
          workspaceId,
          decodedInput.eventId,
          decodedInput.eventType,
          decodedInput.dedupeKey
        )
      })
    ).pipe(mapPersistenceOperation("domain-event.append"))

    const rawRow = rows[0]
    if (rawRow === undefined) {
      return yield* new PersistenceOperationError({ operation: "domain-event.append-read" })
    }
    const persisted = yield* decodeRow(workspaceId, rawRow)
    const expectedSemantic = yield* encodeSemantic(decodedInput)
    const actualSemantic = yield* encodeSemantic(persisted.event)
    if (expectedSemantic !== actualSemantic || persisted.row.dedupeKey !== decodedInput.dedupeKey) {
      return yield* new SourceIdentityMismatchError({
        workspaceId,
        recordKind: "domain-event",
        recordKey: persisted.event.eventId
      })
    }
    return persisted.event
  })

  const pageAfter = Effect.fn("DomainEventRepository.pageAfter")(function*(
    workspaceId: typeof WorkspaceId.Type,
    after: typeof EventCursor.Type,
    requestedLimit: number
  ): Effect.fn.Return<
    DomainEventPage<typeof PortfolioInvalidatedEventV1.Type>,
    PersistenceOperationError | QuarantineWriteError,
    never
  > {
    const cursor = yield* Schema.decodeUnknownEffect(EventCursor)(after).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "domain-event.after-cursor" }))
    )
    const limit = yield* Schema.decodeUnknownEffect(DomainEventPageSize)(requestedLimit).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "domain-event.page-size" }))
    )
    const snapshot = yield* database.transaction(
      Effect.gen(function*() {
        const state = yield* readStreamState(workspaceId)
        if (cursor < state.prunedThroughCursor || cursor > state.headCursor) {
          return { state, rows: NO_EVENT_ROWS }
        }
        const rows = yield* findEventRowsAfter(workspaceId, cursor, limit)
        return { state, rows }
      })
    ).pipe(mapPersistenceOperation("domain-event.page"))

    if (cursor < snapshot.state.prunedThroughCursor) {
      return {
        _tag: "reset",
        reason: "retention",
        requestedCursor: cursor,
        ...snapshot.state
      }
    }
    if (cursor > snapshot.state.headCursor) {
      return {
        _tag: "reset",
        reason: "cursor-ahead",
        requestedCursor: cursor,
        ...snapshot.state
      }
    }

    const decodedResult = yield* Effect.forEach(
      snapshot.rows,
      (row) => decodeRow(workspaceId, row)
    ).pipe(Effect.result)
    if (Result.isFailure(decodedResult)) {
      if (decodedResult.failure._tag === "PersistedRecordError") {
        return {
          _tag: "reset",
          reason: "gap",
          requestedCursor: cursor,
          ...snapshot.state
        }
      }
      return yield* decodedResult.failure
    }
    const decoded = decodedResult.success
    let expectedCursor = cursor + 1
    for (const persisted of decoded) {
      if (persisted.event.eventCursor !== expectedCursor) {
        return {
          _tag: "reset",
          reason: "gap",
          requestedCursor: cursor,
          ...snapshot.state
        }
      }
      expectedCursor += 1
    }
    if (decoded.length === 0 && cursor < snapshot.state.headCursor) {
      return {
        _tag: "reset",
        reason: "gap",
        requestedCursor: cursor,
        ...snapshot.state
      }
    }
    const nextCursor = decoded.at(-1)?.event.eventCursor ?? cursor
    return {
      _tag: "page",
      events: decoded.map(({ event }) => event),
      headCursor: snapshot.state.headCursor,
      nextCursor
    }
  })

  const prune = Effect.fn("DomainEventRepository.prune")(function*(
    workspaceId: typeof WorkspaceId.Type,
    throughCursor: typeof EventCursor.Type,
    requestedLimit: number
  ): Effect.fn.Return<DomainEventPruneResult, PersistenceOperationError, never> {
    const cursor = yield* Schema.decodeUnknownEffect(EventCursor)(throughCursor).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "domain-event.prune-cursor" }))
    )
    const limit = yield* Schema.decodeUnknownEffect(DomainEventPruneSize)(requestedLimit).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "domain-event.prune-size" }))
    )
    return yield* database.transaction(
      Effect.gen(function*() {
        const state = yield* readStreamState(workspaceId)
        const deleted = yield* sql<{ readonly eventCursor: number }>`DELETE FROM domain_events
          WHERE workspace_id = ${workspaceId}
            AND event_cursor IN (
              SELECT event_cursor
              FROM domain_events
              WHERE workspace_id = ${workspaceId}
                AND event_cursor <= ${cursor}
              ORDER BY event_cursor
              LIMIT ${limit}
            )
          RETURNING event_cursor AS eventCursor`
        const prunedThrough = deleted.reduce<number>(
          (maximum, row) => Math.max(maximum, row.eventCursor),
          state.prunedThroughCursor
        )
        if (deleted.length > 0) {
          yield* sql`UPDATE domain_event_streams
            SET pruned_through_cursor = MAX(pruned_through_cursor, ${prunedThrough})
            WHERE workspace_id = ${workspaceId}`
        }
        return {
          deletedCount: deleted.length,
          prunedThroughCursor: EventCursor.make(prunedThrough)
        }
      })
    ).pipe(mapPersistenceOperation("domain-event.prune"))
  })

  return { append, pageAfter, prune, streamState: readStreamState }
})

/** Workspace-local durable event outbox with bounded replay and retention. */
export interface DomainEventRepositoryService extends Success<typeof makeDomainEventRepository> {}

/** Effect service for durable workspace event streams. */
export class DomainEventRepository extends Context.Service<
  DomainEventRepository,
  DomainEventRepositoryService
>()("@knpkv/control-center/DomainEventRepository") {
  /** Layer that binds event queries, integrity checks, and quarantine writes. */
  static readonly layer = Layer.effect(DomainEventRepository, makeDomainEventRepository)
}
