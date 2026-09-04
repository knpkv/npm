import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Clock, Context, Crypto, Effect, Equal, FileSystem, Layer, Option, Path, Schema, Stream } from "effect"
import { RunnerAddress, SingleRunner } from "effect/unstable/cluster"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import {
  OrchestratorConflictError,
  type OrchestratorError,
  OrchestratorNotFoundError,
  OrchestratorStorageError,
  OrchestratorTransitionError,
  OrchestratorValidationError
} from "./orchestrator-errors.js"
import {
  ActivityIdempotencyKey,
  DispatchRequestId,
  OrchestratorCommand,
  type OrchestratorCommand as OrchestratorCommandType,
  OrchestratorEvent,
  type OrchestratorEvent as OrchestratorEventType,
  OrchestratorEventDetail,
  OrchestratorIdempotencyKey,
  OrchestratorPendingDispatch,
  OrchestratorPendingQuery,
  OrchestratorReceipt,
  type OrchestratorReceipt as OrchestratorReceiptType,
  OrchestratorResult
} from "./orchestrator-model.js"

const Row = Schema.Struct({
  activityIdempotencyKey: Schema.String,
  dispatchRequestId: Schema.String,
  idempotencyKey: Schema.String,
  command: Schema.String,
  acceptedAt: Schema.Number,
  status: Schema.String
})
const EventRow = Schema.Struct({
  dispatchRequestId: Schema.String,
  sequence: Schema.Number,
  type: Schema.String,
  activityIdempotencyKey: Schema.String,
  occurredAt: Schema.Number,
  detail: Schema.NullOr(Schema.String),
  result: Schema.NullOr(Schema.String)
})
type EventRow = typeof EventRow.Type
const LifecycleRow = Schema.Struct({
  activityIdempotencyKey: Schema.String,
  dispatchRequestId: Schema.String,
  idempotencyKey: Schema.String,
  command: Schema.String,
  acceptedAt: Schema.Number,
  status: Schema.String,
  sequence: Schema.NullOr(Schema.Number),
  type: Schema.NullOr(Schema.String),
  eventActivityIdempotencyKey: Schema.NullOr(Schema.String),
  occurredAt: Schema.NullOr(Schema.Number),
  detail: Schema.NullOr(Schema.String),
  result: Schema.NullOr(Schema.String)
})
type LifecycleRow = typeof LifecycleRow.Type
const RecoveryRow = Schema.Struct({
  dispatchRequestId: DispatchRequestId,
  acceptedAt: Schema.Number
})
type RecoveryRow = typeof RecoveryRow.Type
const recoveryPageSize = 256

const storageError = (operation: string) => (cause: unknown) => new OrchestratorStorageError({ cause, operation })

const verifyPathIdentity = (
  path: string,
  fileSystem: FileSystem.FileSystem,
  paths: Path.Path,
  operation: string
): Effect.Effect<void, OrchestratorStorageError> =>
  fileSystem.exists(path).pipe(
    Effect.mapError((cause) => new OrchestratorStorageError({ cause, operation: `${operation}.exists` })),
    Effect.flatMap((exists) => {
      if (!exists) {
        const parent = paths.dirname(path)
        return parent === path ? Effect.void : verifyPathIdentity(parent, fileSystem, paths, operation)
      }
      const parent = paths.dirname(path)
      return Effect.all({
        realPath: fileSystem.realPath(path).pipe(
          Effect.mapError((cause) => new OrchestratorStorageError({ cause, operation: `${operation}.realpath` }))
        ),
        realParentPath: fileSystem.realPath(parent).pipe(
          Effect.mapError((cause) => new OrchestratorStorageError({ cause, operation: `${operation}.parent-realpath` }))
        )
      }).pipe(Effect.flatMap(({ realParentPath, realPath }) => {
        const expectedPath = paths.join(realParentPath, paths.basename(path))
        return realPath === expectedPath
          ? Effect.void
          : Effect.fail(new OrchestratorStorageError({ cause: { expectedPath, path, realPath }, operation }))
      }))
    })
  )

const decodeCommand = (text: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(OrchestratorCommand)(JSON.parse(text)),
    catch: storageError("decode.command")
  })

const decodeEvent = (row: EventRow) =>
  Schema.decodeUnknownEffect(OrchestratorEvent)({
    ...row,
    dispatchRequestId: row.dispatchRequestId,
    type: row.type
  }).pipe(Effect.mapError(storageError("decode.event")))

const currentStatus = Schema.Literals([
  "accepted",
  "queued",
  "running",
  "settled",
  "delivery_failed",
  "task_failed"
])
type CurrentStatus = typeof currentStatus.Type
type DispatchRow = Omit<typeof Row.Type, "status"> & { readonly status: CurrentStatus }

const transitionTarget = Schema.Literals([
  "queued",
  "running",
  "settled",
  "delivery_failed",
  "task_failed"
])
type TransitionTarget = typeof transitionTarget.Type

const validTransition = (from: CurrentStatus, to: TransitionTarget): boolean =>
  (from === "accepted" && to === "queued") ||
  (from === "queued" && to === "running") ||
  (from === "running" &&
    (to === "settled" || to === "delivery_failed" || to === "task_failed"))

const validEventTransition = (from: CurrentStatus, to: CurrentStatus): boolean =>
  to !== "accepted" && validTransition(from, to)

export interface OrchestratorService {
  readonly submit: (
    command: OrchestratorCommandType,
    idempotencyKey: string
  ) => Effect.Effect<OrchestratorReceiptType, OrchestratorError>
  readonly events: (
    dispatchRequestId: string
  ) => Stream.Stream<OrchestratorEventType, OrchestratorError>
  /** Lists one bounded page of accepted and queued commands for explicit restart resumption. */
  readonly pending: (
    query?: typeof OrchestratorPendingQuery.Type
  ) => Effect.Effect<ReadonlyArray<typeof OrchestratorPendingDispatch.Type>, OrchestratorError>
  readonly queue: (dispatchRequestId: string) => Effect.Effect<OrchestratorEventType, OrchestratorError>
  readonly run: (dispatchRequestId: string) => Effect.Effect<OrchestratorEventType, OrchestratorError>
  readonly settle: (
    dispatchRequestId: string,
    result: string
  ) => Effect.Effect<OrchestratorEventType, OrchestratorError>
  readonly failDelivery: (
    dispatchRequestId: string,
    detail: string
  ) => Effect.Effect<OrchestratorEventType, OrchestratorError>
  readonly failTask: (
    dispatchRequestId: string,
    detail: string
  ) => Effect.Effect<OrchestratorEventType, OrchestratorError>
  /** Marks in-flight work as delivery-failed after a restart; it never retries implicitly. */
  readonly recover: () => Stream.Stream<OrchestratorEventType, OrchestratorError>
}

export class Orchestrator extends Context.Service<Orchestrator, OrchestratorService>()(
  "herdr/Orchestrator"
) {}

interface SqliteFileSecurityService {
  readonly secure: Effect.Effect<void, OrchestratorStorageError>
}

class SqliteFileSecurity extends Context.Service<SqliteFileSecurity, SqliteFileSecurityService>()(
  "herdr/SqliteFileSecurity"
) {}

const secureSqliteFiles = (
  filename: string,
  fileSystem: FileSystem.FileSystem,
  paths: Path.Path
) => {
  const files = [filename, `${filename}-wal`, `${filename}-shm`]
  return Effect.forEach(
    files,
    (path) =>
      verifyPathIdentity(path, fileSystem, paths, "sqlite.secure.path-identity").pipe(
        Effect.flatMap(() =>
          fileSystem.exists(path).pipe(
            Effect.mapError((cause) => new OrchestratorStorageError({ cause, operation: "sqlite.secure.exists" }))
          )
        ),
        Effect.flatMap((exists) =>
          exists
            ? fileSystem.chmod(path, 0o600).pipe(
              Effect.mapError((cause) => new OrchestratorStorageError({ cause, operation: "sqlite.secure.chmod" }))
            )
            : Effect.void
        )
      ),
    { discard: true }
  )
}

const makeOrchestrator: Effect.Effect<
  OrchestratorService,
  OrchestratorError,
  SqlClientService | Crypto.Crypto
> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const cryptoService = yield* Crypto.Crypto
  const fileSecurity = yield* Effect.serviceOption(SqliteFileSecurity)
  const secureFiles = Option.match(fileSecurity, {
    onNone: () => Effect.void,
    onSome: ({ secure }) => secure
  })
  const now = Clock.currentTimeMillis

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestrator_dispatches (
      dispatch_request_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      activity_idempotency_key TEXT NOT NULL UNIQUE,
      command TEXT NOT NULL,
      accepted_at INTEGER NOT NULL,
      status TEXT NOT NULL
    )
  `.pipe(Effect.mapError(storageError("initialize.dispatches")))
  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestrator_events (
      dispatch_request_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      activity_idempotency_key TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      detail TEXT,
      result TEXT,
      PRIMARY KEY (dispatch_request_id, sequence),
      FOREIGN KEY (dispatch_request_id) REFERENCES orchestrator_dispatches(dispatch_request_id)
    )
  `.pipe(Effect.mapError(storageError("initialize.events")))
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestrator_pending_dispatches_order
    ON orchestrator_dispatches (accepted_at ASC, dispatch_request_id ASC)
    WHERE status IN ('accepted', 'queued')
  `.pipe(Effect.mapError(storageError("initialize.pending-index")))
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestrator_running_dispatches_order
    ON orchestrator_dispatches (accepted_at ASC, dispatch_request_id ASC)
    WHERE status = 'running'
  `.pipe(Effect.mapError(storageError("initialize.running-index")))
  yield* secureFiles

  const listEvents = Effect.fn("Orchestrator.listEvents")(function*(dispatchRequestId: string) {
    const rows = yield* sql`
      SELECT dispatch_request_id AS "dispatchRequestId", sequence, type,
        activity_idempotency_key AS "activityIdempotencyKey", occurred_at AS "occurredAt",
        detail, result
      FROM orchestrator_events
      WHERE dispatch_request_id = ${dispatchRequestId}
      ORDER BY sequence ASC
    `.pipe(Effect.mapError(storageError("events.list")))
    const decodedRows = yield* Schema.decodeUnknownEffect(Schema.Array(EventRow))(rows).pipe(
      Effect.mapError(storageError("decode.event.row"))
    )
    return yield* Effect.forEach(decodedRows, decodeEvent)
  })

  const validateLifecycleChain = Effect.fn("Orchestrator.validateLifecycleChain")(function*(
    dispatch: DispatchRow,
    events: ReadonlyArray<OrchestratorEventType>
  ) {
    const dispatchActivityIdempotencyKey = yield* Schema.decodeUnknownEffect(ActivityIdempotencyKey)(
      dispatch.activityIdempotencyKey
    ).pipe(
      Effect.mapError(() =>
        new OrchestratorStorageError({
          cause: dispatch.activityIdempotencyKey,
          operation: "transition.lifecycle-chain-mismatch"
        })
      )
    )
    const dispatchCommand = yield* decodeCommand(dispatch.command)
    const first = events[0]
    if (
      first === undefined ||
      first.sequence !== 0 ||
      first.type !== "accepted" ||
      first.occurredAt !== dispatch.acceptedAt
    ) {
      return yield* new OrchestratorStorageError({
        cause: { dispatch, event: first },
        operation: "transition.lifecycle-chain-mismatch"
      })
    }
    if (
      first.dispatchRequestId !== dispatch.dispatchRequestId ||
      first.activityIdempotencyKey !== dispatchActivityIdempotencyKey ||
      first.activityIdempotencyKey !== dispatchCommand.activityIdempotencyKey
    ) {
      return yield* new OrchestratorStorageError({
        cause: { dispatch, event: first },
        operation: "transition.activity-idempotency-mismatch"
      })
    }
    let previousType: CurrentStatus = first.type
    let previousOccurredAt = first.occurredAt
    for (const [index, event] of events.entries()) {
      if (
        event.dispatchRequestId !== dispatch.dispatchRequestId ||
        event.activityIdempotencyKey !== dispatchActivityIdempotencyKey ||
        event.activityIdempotencyKey !== dispatchCommand.activityIdempotencyKey
      ) {
        return yield* new OrchestratorStorageError({
          cause: { dispatchRequestId: dispatch.dispatchRequestId, event, index, previousType },
          operation: "transition.activity-idempotency-mismatch"
        })
      }
      if (
        event.sequence !== index ||
        event.occurredAt < previousOccurredAt ||
        (index > 0 && !validEventTransition(previousType, event.type))
      ) {
        return yield* new OrchestratorStorageError({
          cause: { dispatchRequestId: dispatch.dispatchRequestId, event, index, previousType },
          operation: "transition.lifecycle-chain-mismatch"
        })
      }
      previousType = event.type
      previousOccurredAt = event.occurredAt
    }
  })

  const loadValidatedEvents = Effect.fn("Orchestrator.loadValidatedEvents")(function*(dispatchRequestId: string) {
    const decodedDispatchRequestId = yield* Schema.decodeUnknownEffect(DispatchRequestId)(dispatchRequestId).pipe(
      Effect.mapError(() => new OrchestratorValidationError({ detail: "dispatch request ID is invalid" }))
    )
    const rows = yield* sql`
      SELECT d.dispatch_request_id AS "dispatchRequestId", d.idempotency_key AS "idempotencyKey",
        d.activity_idempotency_key AS "activityIdempotencyKey", d.command,
        d.accepted_at AS "acceptedAt", d.status,
        e.sequence, e.type, e.activity_idempotency_key AS "eventActivityIdempotencyKey",
        e.occurred_at AS "occurredAt", e.detail, e.result
      FROM orchestrator_dispatches d
      LEFT JOIN orchestrator_events e
        ON e.dispatch_request_id = d.dispatch_request_id
      WHERE d.dispatch_request_id = ${decodedDispatchRequestId}
      ORDER BY e.sequence ASC
    `.pipe(Effect.mapError(storageError("events.snapshot")))
    const decodedRows = yield* Schema.decodeUnknownEffect(Schema.Array(LifecycleRow))(rows).pipe(
      Effect.mapError(storageError("events.decode-snapshot"))
    )
    const first = decodedRows[0]
    if (first === undefined) {
      return yield* new OrchestratorNotFoundError({ dispatchRequestId: decodedDispatchRequestId })
    }
    const status = yield* Schema.decodeUnknownEffect(currentStatus)(first.status).pipe(
      Effect.mapError(() => new OrchestratorStorageError({ cause: first.status, operation: "decode.dispatch.status" }))
    )
    const dispatch: DispatchRow = {
      activityIdempotencyKey: first.activityIdempotencyKey,
      acceptedAt: first.acceptedAt,
      command: first.command,
      dispatchRequestId: first.dispatchRequestId,
      idempotencyKey: first.idempotencyKey,
      status
    }
    const events = yield* Effect.gen(function*() {
      const eventRows: Array<EventRow> = []
      for (const row of decodedRows) {
        const hasEvent = row.sequence !== null || row.type !== null || row.eventActivityIdempotencyKey !== null ||
          row.occurredAt !== null
        if (!hasEvent) continue
        if (
          row.sequence === null || row.type === null || row.eventActivityIdempotencyKey === null ||
          row.occurredAt === null
        ) {
          return yield* new OrchestratorStorageError({ cause: row, operation: "events.snapshot-row-mismatch" })
        }
        eventRows.push({
          activityIdempotencyKey: row.eventActivityIdempotencyKey,
          detail: row.detail,
          dispatchRequestId: row.dispatchRequestId,
          occurredAt: row.occurredAt,
          result: row.result,
          sequence: row.sequence,
          type: row.type
        })
      }
      return yield* Effect.forEach(eventRows, decodeEvent)
    })
    yield* validateLifecycleChain(dispatch, events)
    const last = events.at(-1)
    if (last === undefined || last.type !== dispatch.status) {
      return yield* new OrchestratorStorageError({
        cause: { dispatch, event: last },
        operation: "events.status-event-mismatch"
      })
    }
    return { dispatch, events }
  })

  const listPending = Effect.fn("Orchestrator.listPending")(
    function*(query: typeof OrchestratorPendingQuery.Type = {}) {
      const decodedQuery = yield* Schema.decodeUnknownEffect(OrchestratorPendingQuery)(query).pipe(
        Effect.mapError(() => new OrchestratorValidationError({ detail: "pending query is invalid" }))
      )
      const limit = decodedQuery.limit ?? 256
      const rows = decodedQuery.after === undefined
        ? yield* sql`
      SELECT dispatch_request_id AS "dispatchRequestId", idempotency_key AS "idempotencyKey",
        activity_idempotency_key AS "activityIdempotencyKey", command,
        accepted_at AS "acceptedAt", status
      FROM orchestrator_dispatches
      WHERE status IN ('accepted', 'queued')
      ORDER BY accepted_at ASC, dispatch_request_id ASC
      LIMIT ${limit}
    `.pipe(Effect.mapError(storageError("pending.list")))
        : yield* sql`
      SELECT dispatch_request_id AS "dispatchRequestId", idempotency_key AS "idempotencyKey",
        activity_idempotency_key AS "activityIdempotencyKey", command,
        accepted_at AS "acceptedAt", status
      FROM orchestrator_dispatches
      WHERE status IN ('accepted', 'queued')
        AND (accepted_at > ${decodedQuery.after.acceptedAt}
          OR (accepted_at = ${decodedQuery.after.acceptedAt}
            AND dispatch_request_id > ${decodedQuery.after.dispatchRequestId}))
      ORDER BY accepted_at ASC, dispatch_request_id ASC
      LIMIT ${limit}
    `.pipe(Effect.mapError(storageError("pending.list")))
      const decodedRows = yield* Schema.decodeUnknownEffect(Schema.Array(Row))(rows).pipe(
        Effect.mapError(storageError("pending.decode-row"))
      )
      const pending = yield* Effect.forEach(decodedRows, (row) =>
        Effect.gen(function*() {
          const snapshot = yield* loadValidatedEvents(row.dispatchRequestId)
          if (snapshot.dispatch.status !== "accepted" && snapshot.dispatch.status !== "queued") return Option.none()
          const command = yield* decodeCommand(snapshot.dispatch.command)
          const pendingDispatch = yield* Schema.decodeUnknownEffect(OrchestratorPendingDispatch)({
            ...snapshot.dispatch,
            command
          }).pipe(
            Effect.mapError(storageError("pending.decode"))
          )
          return Option.some(pendingDispatch)
        }))
      return pending.flatMap((value) =>
        Option.match(value, {
          onNone: () => [],
          onSome: (pendingDispatch) => [pendingDispatch]
        })
      )
    }
  )

  const appendTransition = Effect.fn("Orchestrator.transition")(function*(
    dispatchRequestId: string,
    target: TransitionTarget,
    detail: string | null,
    result: string | null
  ) {
    const decodedDispatchRequestId = yield* Schema.decodeUnknownEffect(DispatchRequestId)(dispatchRequestId).pipe(
      Effect.mapError(() => new OrchestratorValidationError({ detail: "dispatch request ID is invalid" }))
    )
    yield* secureFiles
    const decodedTarget = yield* Schema.decodeUnknownEffect(transitionTarget)(target).pipe(
      Effect.mapError(() => new OrchestratorValidationError({ detail: `invalid transition target ${target}` }))
    )
    const decodedDetail = yield* Schema.decodeUnknownEffect(Schema.NullOr(OrchestratorEventDetail))(detail).pipe(
      Effect.mapError(() => new OrchestratorValidationError({ detail: "invalid transition detail" }))
    )
    const decodedResult = yield* Schema.decodeUnknownEffect(Schema.NullOr(OrchestratorResult))(result).pipe(
      Effect.mapError(() => new OrchestratorValidationError({ detail: "invalid transition result" }))
    )
    const event = yield* sql.withTransaction(
      Effect.gen(function*() {
        const snapshot = yield* loadValidatedEvents(decodedDispatchRequestId).pipe(
          Effect.catchTag("OrchestratorStorageError", (error) =>
            error.operation === "events.status-event-mismatch"
              ? Effect.fail(
                new OrchestratorStorageError({ cause: error.cause, operation: "transition.status-event-mismatch" })
              )
              : Effect.fail(error))
        )
        const dispatch = snapshot.dispatch
        if (!validTransition(dispatch.status, decodedTarget)) {
          return yield* new OrchestratorTransitionError({
            dispatchRequestId: decodedDispatchRequestId,
            from: dispatch.status,
            to: decodedTarget
          })
        }
        const last = snapshot.events.at(-1)
        if (last === undefined) {
          return yield* new OrchestratorStorageError({
            cause: decodedDispatchRequestId,
            operation: "transition.missing-event"
          })
        }
        const timestamp = yield* now
        if (timestamp < last.occurredAt) {
          return yield* new OrchestratorStorageError({
            cause: { dispatchRequestId: decodedDispatchRequestId, previous: last.occurredAt, timestamp },
            operation: "transition.timestamp-regression"
          })
        }
        const event = yield* Schema.decodeUnknownEffect(OrchestratorEvent)({
          activityIdempotencyKey: last.activityIdempotencyKey,
          dispatchRequestId: decodedDispatchRequestId,
          occurredAt: timestamp,
          sequence: last.sequence + 1,
          type: decodedTarget,
          ...(decodedTarget === "settled"
            ? { detail: null, result: decodedResult }
            : decodedTarget === "delivery_failed" || decodedTarget === "task_failed"
            ? { detail: decodedDetail, result: null }
            : { detail: null, result: null })
        }).pipe(Effect.mapError(() => new OrchestratorValidationError({ detail: "transition exceeds event bounds" })))
        const insertedRows = yield* sql`
          INSERT INTO orchestrator_events
            (dispatch_request_id, sequence, type, activity_idempotency_key, occurred_at, detail, result)
          VALUES (${event.dispatchRequestId}, ${event.sequence}, ${event.type},
            ${event.activityIdempotencyKey}, ${event.occurredAt}, ${event.detail}, ${event.result})
          ON CONFLICT (dispatch_request_id, sequence) DO NOTHING
          RETURNING dispatch_request_id AS "dispatchRequestId", sequence, type,
            activity_idempotency_key AS "activityIdempotencyKey", occurred_at AS "occurredAt", detail, result
        `.pipe(Effect.mapError(storageError("transition.insert-event")))
        if (insertedRows.length === 0) {
          const winnerRows = yield* sql`
            SELECT dispatch_request_id AS "dispatchRequestId", sequence, type,
              activity_idempotency_key AS "activityIdempotencyKey", occurred_at AS "occurredAt", detail, result
            FROM orchestrator_events
            WHERE dispatch_request_id = ${event.dispatchRequestId} AND sequence = ${event.sequence}
          `.pipe(Effect.mapError(storageError("transition.reload-event")))
          const winner = yield* Schema.decodeUnknownEffect(Schema.Array(EventRow))(winnerRows).pipe(
            Effect.mapError(storageError("transition.decode-winner")),
            Effect.flatMap((rows) => {
              const first = rows[0]
              return first === undefined
                ? Effect.fail(new OrchestratorStorageError({ cause: event, operation: "transition.missing-winner" }))
                : decodeEvent(first)
            })
          )
          if (winner.dispatchRequestId === event.dispatchRequestId && winner.type !== "accepted") {
            return yield* new OrchestratorTransitionError({
              dispatchRequestId: decodedDispatchRequestId,
              from: winner.type,
              to: decodedTarget
            })
          }
          return yield* new OrchestratorStorageError({
            cause: { event, winner },
            operation: "transition.concurrent-event-mismatch"
          })
        }
        yield* sql`
          UPDATE orchestrator_dispatches SET status = ${event.type}
          WHERE dispatch_request_id = ${decodedDispatchRequestId}
        `.pipe(Effect.mapError(storageError("transition.update-dispatch")))
        return event
      })
    ).pipe(
      Effect.catchTag("SqlError", (cause) => Effect.fail(storageError("transition.transaction")(cause)))
    )
    return event
  })

  const submit: OrchestratorService["submit"] = Effect.fn("Orchestrator.submit")(function*(
    command: OrchestratorCommandType,
    idempotencyKey: string
  ) {
    const decodedCommand = yield* Schema.decodeUnknownEffect(OrchestratorCommand)(command).pipe(
      Effect.mapError(() => new OrchestratorValidationError({ detail: "command is not a typed fleet job" }))
    )
    const decodedKey = yield* Schema.decodeUnknownEffect(
      OrchestratorIdempotencyKey
    )(idempotencyKey).pipe(
      Effect.mapError(() => new OrchestratorValidationError({ detail: "idempotency key is invalid" }))
    )
    const encodedCommand = JSON.stringify(decodedCommand)
    yield* secureFiles
    const receipt = yield* sql.withTransaction(
      Effect.gen(function*() {
        const dispatchRequestId = yield* cryptoService.randomUUIDv4.pipe(
          Effect.mapError(storageError("submit.request-id")),
          Effect.flatMap((value) =>
            Schema.decodeUnknownEffect(DispatchRequestId)(value).pipe(
              Effect.mapError(() =>
                new OrchestratorStorageError({ cause: value, operation: "submit.request-id-schema" })
              )
            )
          )
        )
        const acceptedAt = yield* now
        const insertedRows = yield* sql`
          INSERT INTO orchestrator_dispatches
            (dispatch_request_id, idempotency_key, activity_idempotency_key, command, accepted_at, status)
          VALUES (${dispatchRequestId}, ${decodedKey}, ${decodedCommand.activityIdempotencyKey},
            ${encodedCommand}, ${acceptedAt}, 'accepted')
          ON CONFLICT DO NOTHING
          RETURNING dispatch_request_id AS "dispatchRequestId", idempotency_key AS "idempotencyKey",
            activity_idempotency_key AS "activityIdempotencyKey", command,
            accepted_at AS "acceptedAt", status
        `.pipe(Effect.mapError(storageError("submit.insert-or-reload")))
        const wasInserted = insertedRows.length !== 0
        const persistedRows = !wasInserted
          ? yield* sql`
            SELECT dispatch_request_id AS "dispatchRequestId", idempotency_key AS "idempotencyKey",
              activity_idempotency_key AS "activityIdempotencyKey", command,
              accepted_at AS "acceptedAt", status
            FROM orchestrator_dispatches
            WHERE idempotency_key = ${decodedKey}
              OR activity_idempotency_key = ${decodedCommand.activityIdempotencyKey}
          `.pipe(Effect.mapError(storageError("submit.reload")))
          : insertedRows
        const persisted = yield* Schema.decodeUnknownEffect(Schema.Array(Row))(persistedRows).pipe(
          Effect.mapError(storageError("submit.decode-persisted"))
        )
        const first = persisted[0]
        if (first === undefined) {
          return yield* new OrchestratorStorageError({
            cause: { dispatchRequestId, idempotencyKey: decodedKey },
            operation: "submit.insert-or-reload-empty"
          })
        }
        if (!wasInserted && first.dispatchRequestId !== dispatchRequestId && first.idempotencyKey !== decodedKey) {
          return yield* new OrchestratorConflictError({
            detail: "activity idempotency key was already used",
            idempotencyKey: decodedKey
          })
        }
        if (!wasInserted) {
          const oldCommand = yield* decodeCommand(first.command)
          if (!Equal.equals(oldCommand, decodedCommand)) {
            return yield* new OrchestratorConflictError({
              detail: "idempotency key was already used for a different command",
              idempotencyKey: decodedKey
            })
          }
          const acceptedAt = yield* Schema.decodeUnknownEffect(Schema.Number)(first.acceptedAt).pipe(
            Effect.mapError(storageError("submit.decode-accepted-at"))
          )
          const events = yield* listEvents(first.dispatchRequestId)
          const acceptedEvents = events.filter(({ sequence }) => sequence === 0)
          const accepted = acceptedEvents[0]
          if (
            acceptedEvents.length !== 1 ||
            accepted === undefined ||
            accepted.type !== "accepted" ||
            accepted.dispatchRequestId !== first.dispatchRequestId ||
            accepted.activityIdempotencyKey !== first.activityIdempotencyKey ||
            accepted.activityIdempotencyKey !== decodedCommand.activityIdempotencyKey ||
            accepted.occurredAt !== acceptedAt
          ) {
            return yield* new OrchestratorStorageError({
              cause: {
                acceptedAt,
                acceptedEvent: accepted,
                dispatchActivityIdempotencyKey: first.activityIdempotencyKey,
                dispatchRequestId: first.dispatchRequestId
              },
              operation: "submit.accepted-event-mismatch"
            })
          }
          return yield* Schema.decodeUnknownEffect(OrchestratorReceipt)({
            acceptedAt,
            dispatchRequestId: first.dispatchRequestId,
            idempotencyKey: decodedKey,
            status: "accepted"
          }).pipe(Effect.mapError(storageError("submit.decode-receipt")))
        }
        const event = {
          activityIdempotencyKey: decodedCommand.activityIdempotencyKey,
          detail: null,
          dispatchRequestId,
          occurredAt: acceptedAt,
          result: null,
          sequence: 0,
          type: "accepted"
        } satisfies OrchestratorEventType
        yield* sql`
          INSERT INTO orchestrator_events
            (dispatch_request_id, sequence, type, activity_idempotency_key, occurred_at, detail, result)
          VALUES (${dispatchRequestId}, 0, 'accepted', ${event.activityIdempotencyKey}, ${acceptedAt}, NULL, NULL)
        `.pipe(Effect.mapError(storageError("submit.insert-event")))
        return {
          acceptedAt,
          dispatchRequestId,
          idempotencyKey: decodedKey,
          status: "accepted"
        } satisfies OrchestratorReceiptType
      })
    ).pipe(
      Effect.catchTag("SqlError", (cause) => Effect.fail(storageError("submit.transaction")(cause)))
    )
    return receipt
  })

  const service: OrchestratorService = {
    events: (dispatchRequestId) =>
      Stream.fromIterableEffect(
        Schema.decodeUnknownEffect(DispatchRequestId)(dispatchRequestId).pipe(
          Effect.mapError(() => new OrchestratorValidationError({ detail: "dispatch request ID is invalid" })),
          Effect.flatMap(loadValidatedEvents),
          Effect.map(({ events }) => events)
        )
      ),
    failDelivery: (dispatchRequestId, detail) => appendTransition(dispatchRequestId, "delivery_failed", detail, null),
    failTask: (dispatchRequestId, detail) => appendTransition(dispatchRequestId, "task_failed", detail, null),
    pending: listPending,
    queue: (dispatchRequestId) => appendTransition(dispatchRequestId, "queued", null, null),
    recover: () =>
      Stream.paginate<void, OrchestratorEventType, OrchestratorError>(
        undefined,
        Effect.fn("Orchestrator.recoverPage")(function*(state) {
          void state
          const rows = yield* sql`
              SELECT dispatch_request_id AS "dispatchRequestId", accepted_at AS "acceptedAt"
              FROM orchestrator_dispatches
              WHERE status = 'running'
              ORDER BY accepted_at ASC, dispatch_request_id ASC
              LIMIT ${recoveryPageSize}
            `.pipe(Effect.mapError(storageError("recover.lookup")))
          const ids = yield* Schema.decodeUnknownEffect(Schema.Array(RecoveryRow))(rows).pipe(
            Effect.mapError(storageError("recover.decode"))
          )
          const recovered = yield* Effect.forEach(ids, ({ dispatchRequestId }) =>
            appendTransition(
              dispatchRequestId,
              "delivery_failed",
              "orchestrator restarted while the activity was running",
              null
            ).pipe(
              Effect.map(Option.some),
              Effect.catchTag("OrchestratorTransitionError", (error) =>
                error.from === "settled" || error.from === "delivery_failed" || error.from === "task_failed"
                  ? Effect.succeed(Option.none<OrchestratorEventType>())
                  : Effect.fail(error))
            ))
          const events = recovered.flatMap((event) =>
            Option.match(event, {
              onNone: () => [],
              onSome: (value) => [value]
            })
          )
          const next = ids.length === 0 ? Option.none<void>() : Option.some(undefined)
          const page: readonly [ReadonlyArray<OrchestratorEventType>, Option.Option<void>] = [events, next]
          return page
        })
      ),
    run: (dispatchRequestId) => appendTransition(dispatchRequestId, "running", null, null),
    settle: (dispatchRequestId, result) => appendTransition(dispatchRequestId, "settled", null, result),
    submit
  }
  return service
})

/** Durable dispatch/event service. Requires a SQL client and Effect Crypto. */
export const layer: Layer.Layer<Orchestrator, OrchestratorError, SqlClientService | Crypto.Crypto> = Layer.effect(
  Orchestrator,
  makeOrchestrator
)

/** Single-process cluster runner with SQL-backed MessageStorage and runner state. */
export const singleRunnerLayer = SingleRunner.layer({
  runnerStorage: "sql",
  shardingConfig: {
    runnerAddress: Option.some(RunnerAddress.make("localhost", 34_431)),
    runnerListenAddress: Option.none()
  }
})

/**
 * Node SQLite and Crypto services used by the durable coordinator layers.
 * Fails closed on non-POSIX paths until an ACL-backed private-directory check exists.
 */
export const sqliteLayer = (filename: string) =>
  Layer.unwrap(
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const paths = yield* Path.Path
      const directory = paths.dirname(filename)
      const directoryExists = yield* fileSystem.exists(directory).pipe(
        Effect.mapError((cause) => new OrchestratorStorageError({ cause, operation: "sqlite.secure.directory.exists" }))
      )
      if (!directoryExists) {
        yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 }).pipe(
          Effect.mapError((cause) =>
            new OrchestratorStorageError({ cause, operation: "sqlite.secure.directory.create" })
          )
        )
      }
      const directoryInfo = yield* fileSystem.stat(directory).pipe(
        Effect.mapError((cause) => new OrchestratorStorageError({ cause, operation: "sqlite.secure.directory.stat" }))
      )
      const privateMode = paths.sep === "/" && (directoryInfo.mode & 0o777) === 0o700
      if (directoryInfo.type !== "Directory" || !privateMode) {
        return yield* new OrchestratorStorageError({
          cause: { directory, mode: directoryInfo.mode, type: directoryInfo.type },
          operation: "sqlite.secure.directory.private"
        })
      }
      yield* verifyPathIdentity(directory, fileSystem, paths, "sqlite.secure.directory.path-identity")
      yield* Effect.forEach(
        [filename, `${filename}-wal`, `${filename}-shm`],
        (path) => verifyPathIdentity(path, fileSystem, paths, "sqlite.secure.path-identity"),
        { discard: true }
      )
      const security = secureSqliteFiles(filename, fileSystem, paths)
      return Layer.mergeAll(
        SqliteClient.layer({ filename }),
        NodeCrypto.layer,
        Layer.succeed(SqliteFileSecurity, { secure: security })
      ).pipe(Layer.tap(() => security))
    })
  ).pipe(Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)))

export const make = Effect.fn("Orchestrator.make")(function*() {
  return yield* makeOrchestrator
})
