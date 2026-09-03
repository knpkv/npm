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
  DispatchRequestId,
  OrchestratorCommand,
  type OrchestratorCommand as OrchestratorCommandType,
  OrchestratorEvent,
  type OrchestratorEvent as OrchestratorEventType,
  OrchestratorPendingDispatch,
  OrchestratorPendingDispatchStatus,
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

const storageError = (operation: string) => (cause: unknown) => new OrchestratorStorageError({ cause, operation })

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

export interface OrchestratorService {
  readonly submit: (
    command: OrchestratorCommandType,
    idempotencyKey: string
  ) => Effect.Effect<OrchestratorReceiptType, OrchestratorError>
  readonly events: (
    dispatchRequestId: string
  ) => Stream.Stream<OrchestratorEventType, OrchestratorError>
  /** Lists accepted and queued commands so a restarted worker can resume them explicitly. */
  readonly pending: () => Effect.Effect<ReadonlyArray<typeof OrchestratorPendingDispatch.Type>, OrchestratorError>
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
  readonly recover: () => Effect.Effect<ReadonlyArray<OrchestratorEventType>, OrchestratorError>
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
  fileSystem: FileSystem.FileSystem
) => {
  const files = [filename, `${filename}-wal`, `${filename}-shm`]
  return Effect.forEach(
    files,
    (path) =>
      fileSystem.exists(path).pipe(
        Effect.mapError((cause) => new OrchestratorStorageError({ cause, operation: "sqlite.secure.exists" })),
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
  yield* secureFiles

  const load = Effect.fn("Orchestrator.load")(function*(dispatchRequestId: string) {
    const rows = yield* sql`
      SELECT dispatch_request_id AS "dispatchRequestId", idempotency_key AS "idempotencyKey",
        activity_idempotency_key AS "activityIdempotencyKey", command,
        accepted_at AS "acceptedAt", status
      FROM orchestrator_dispatches WHERE dispatch_request_id = ${dispatchRequestId}
    `.pipe(Effect.mapError(storageError("load")))
    const row = yield* Schema.decodeUnknownEffect(Schema.Array(Row))(rows).pipe(
      Effect.mapError(storageError("decode.dispatch"))
    )
    const first = row[0]
    if (first === undefined) return yield* new OrchestratorNotFoundError({ dispatchRequestId })
    const status = yield* Schema.decodeUnknownEffect(currentStatus)(first.status).pipe(
      Effect.mapError(() =>
        new OrchestratorStorageError({
          cause: first.status,
          operation: "decode.dispatch.status"
        })
      )
    )
    return { ...first, status }
  })

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

  const listPending = Effect.fn("Orchestrator.listPending")(function*() {
    const rows = yield* sql`
      SELECT dispatch_request_id AS "dispatchRequestId", idempotency_key AS "idempotencyKey",
        activity_idempotency_key AS "activityIdempotencyKey", command,
        accepted_at AS "acceptedAt", status
      FROM orchestrator_dispatches
      WHERE status IN ('accepted', 'queued')
      ORDER BY accepted_at ASC, dispatch_request_id ASC
    `.pipe(Effect.mapError(storageError("pending.list")))
    const decodedRows = yield* Schema.decodeUnknownEffect(Schema.Array(Row))(rows).pipe(
      Effect.mapError(storageError("pending.decode-row"))
    )
    return yield* Effect.forEach(decodedRows, (row) =>
      Effect.gen(function*() {
        const status = yield* Schema.decodeUnknownEffect(OrchestratorPendingDispatchStatus)(row.status).pipe(
          Effect.mapError(() => new OrchestratorStorageError({ cause: row.status, operation: "pending.decode-status" }))
        )
        const command = yield* decodeCommand(row.command)
        return yield* Schema.decodeUnknownEffect(OrchestratorPendingDispatch)({ ...row, command, status }).pipe(
          Effect.mapError(storageError("pending.decode"))
        )
      }))
  })

  const appendTransition = Effect.fn("Orchestrator.transition")(function*(
    dispatchRequestId: string,
    target: TransitionTarget,
    detail: string | null,
    result: string | null
  ) {
    yield* secureFiles
    const decodedTarget = yield* Schema.decodeUnknownEffect(transitionTarget)(target).pipe(
      Effect.mapError(() => new OrchestratorValidationError({ detail: `invalid transition target ${target}` }))
    )
    const decodedDetail = yield* Schema.decodeUnknownEffect(Schema.NullOr(Schema.String))(detail).pipe(
      Effect.mapError(() => new OrchestratorValidationError({ detail: "invalid transition detail" }))
    )
    const decodedResult = yield* Schema.decodeUnknownEffect(Schema.NullOr(OrchestratorResult))(result).pipe(
      Effect.mapError(() => new OrchestratorValidationError({ detail: "invalid transition result" }))
    )
    const event = yield* sql.withTransaction(
      Effect.gen(function*() {
        const dispatch = yield* load(dispatchRequestId)
        if (!validTransition(dispatch.status, decodedTarget)) {
          return yield* new OrchestratorTransitionError({
            dispatchRequestId,
            from: dispatch.status,
            to: decodedTarget
          })
        }
        const events = yield* listEvents(dispatchRequestId)
        const last = events.at(-1)
        if (last === undefined) {
          return yield* new OrchestratorStorageError({
            cause: dispatchRequestId,
            operation: "transition.missing-event"
          })
        }
        const timestamp = yield* now
        const event = yield* Schema.decodeUnknownEffect(OrchestratorEvent)({
          activityIdempotencyKey: last.activityIdempotencyKey,
          dispatchRequestId,
          occurredAt: timestamp,
          sequence: last.sequence + 1,
          type: decodedTarget,
          ...(decodedTarget === "settled"
            ? { detail: null, result: decodedResult }
            : decodedTarget === "delivery_failed" || decodedTarget === "task_failed"
            ? { detail: decodedDetail, result: null }
            : { detail: null, result: null })
        }).pipe(Effect.mapError(() => new OrchestratorValidationError({ detail: "transition exceeds event bounds" })))
        yield* sql`
          INSERT INTO orchestrator_events
            (dispatch_request_id, sequence, type, activity_idempotency_key, occurred_at, detail, result)
          VALUES (${event.dispatchRequestId}, ${event.sequence}, ${event.type},
            ${event.activityIdempotencyKey}, ${event.occurredAt}, ${event.detail}, ${event.result})
        `.pipe(Effect.mapError(storageError("transition.insert-event")))
        yield* sql`
          UPDATE orchestrator_dispatches SET status = ${event.type}
          WHERE dispatch_request_id = ${dispatchRequestId}
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
      Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256))
    )(idempotencyKey).pipe(
      Effect.mapError(() => new OrchestratorValidationError({ detail: "idempotency key is invalid" }))
    )
    const encodedCommand = JSON.stringify(decodedCommand)
    yield* secureFiles
    const receipt = yield* sql.withTransaction(
      Effect.gen(function*() {
        const existingRows = yield* sql`
          SELECT dispatch_request_id AS "dispatchRequestId", idempotency_key AS "idempotencyKey",
            activity_idempotency_key AS "activityIdempotencyKey", command,
            accepted_at AS "acceptedAt", status
          FROM orchestrator_dispatches WHERE idempotency_key = ${decodedKey}
        `.pipe(Effect.mapError(storageError("submit.lookup")))
        const existing = yield* Schema.decodeUnknownEffect(Schema.Array(Row))(existingRows).pipe(
          Effect.mapError(storageError("submit.decode-existing"))
        )
        const first = existing[0]
        if (first !== undefined) {
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
          return {
            acceptedAt,
            dispatchRequestId: first.dispatchRequestId,
            idempotencyKey: decodedKey,
            status: "accepted"
          } satisfies OrchestratorReceiptType
        }
        const activityRows = yield* sql`
          SELECT dispatch_request_id AS "dispatchRequestId", idempotency_key AS "idempotencyKey",
            activity_idempotency_key AS "activityIdempotencyKey", command,
            accepted_at AS "acceptedAt", status
          FROM orchestrator_dispatches
          WHERE activity_idempotency_key = ${decodedCommand.activityIdempotencyKey}
        `.pipe(Effect.mapError(storageError("submit.lookup-activity")))
        const activity = yield* Schema.decodeUnknownEffect(Schema.Array(Row))(activityRows).pipe(
          Effect.mapError(storageError("submit.decode-activity"))
        )
        if (activity.length > 0) {
          return yield* new OrchestratorConflictError({
            detail: "activity idempotency key was already used",
            idempotencyKey: decodedKey
          })
        }
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
          INSERT INTO orchestrator_dispatches
            (dispatch_request_id, idempotency_key, activity_idempotency_key, command, accepted_at, status)
          VALUES (${dispatchRequestId}, ${decodedKey}, ${event.activityIdempotencyKey},
            ${encodedCommand}, ${acceptedAt}, ${event.type})
        `.pipe(Effect.mapError(storageError("submit.insert-dispatch")))
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
        load(dispatchRequestId).pipe(Effect.flatMap(() => listEvents(dispatchRequestId)))
      ),
    failDelivery: (dispatchRequestId, detail) => appendTransition(dispatchRequestId, "delivery_failed", detail, null),
    failTask: (dispatchRequestId, detail) => appendTransition(dispatchRequestId, "task_failed", detail, null),
    pending: listPending,
    queue: (dispatchRequestId) => appendTransition(dispatchRequestId, "queued", null, null),
    recover: Effect.fn("Orchestrator.recover")(function*() {
      const rows = yield* sql`
        SELECT dispatch_request_id AS "dispatchRequestId"
        FROM orchestrator_dispatches WHERE status = 'running'
        ORDER BY accepted_at ASC
      `.pipe(Effect.mapError(storageError("recover.lookup")))
      const ids = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ dispatchRequestId: DispatchRequestId }))
      )(rows).pipe(
        Effect.mapError(storageError("recover.decode"))
      )
      return yield* Effect.forEach(ids, ({ dispatchRequestId }) =>
        appendTransition(
          dispatchRequestId,
          "delivery_failed",
          "orchestrator restarted while the activity was running",
          null
        ))
    }),
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

/** Node SQLite and Crypto services used by the durable coordinator layers. */
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
        yield* fileSystem.makeDirectory(directory, { mode: 0o700 }).pipe(
          Effect.mapError((cause) =>
            new OrchestratorStorageError({ cause, operation: "sqlite.secure.directory.create" })
          )
        )
      }
      const directoryInfo = yield* fileSystem.stat(directory).pipe(
        Effect.mapError((cause) => new OrchestratorStorageError({ cause, operation: "sqlite.secure.directory.stat" }))
      )
      if (directoryInfo.type !== "Directory" || (directoryInfo.mode & 0o777) !== 0o700) {
        return yield* new OrchestratorStorageError({
          cause: { directory, mode: directoryInfo.mode, type: directoryInfo.type },
          operation: "sqlite.secure.directory.private"
        })
      }
      const security = secureSqliteFiles(filename, fileSystem)
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
