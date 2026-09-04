import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { makeSqliteWorkBridge } from "@knpkv/herdr-work/sql"
import {
  Clock,
  Context,
  Crypto,
  Effect,
  Equal,
  FileSystem,
  Layer,
  Option,
  Path,
  Schedule,
  Schema,
  Stream
} from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import {
  OrchestratorConflictError,
  type OrchestratorError,
  OrchestratorNotFoundError,
  OrchestratorStorageError,
  OrchestratorTransitionError,
  OrchestratorValidationError,
  OrchestratorWorkerBindingConflictError,
  OrchestratorWorkerStartAuthorityError
} from "./orchestrator-errors.js"
import {
  ActivityIdempotencyKey,
  DispatchRequestId,
  OrchestratorCommand,
  type OrchestratorCommand as OrchestratorCommandType,
  OrchestratorDispatchActivated,
  type OrchestratorDispatchActivated as OrchestratorDispatchActivatedType,
  OrchestratorDispatchActivation,
  type OrchestratorDispatchActivation as OrchestratorDispatchActivationType,
  OrchestratorEvent,
  type OrchestratorEvent as OrchestratorEventType,
  OrchestratorEventDetail,
  OrchestratorIdempotencyKey,
  type OrchestratorIdempotencyKey as OrchestratorIdempotencyKeyType,
  OrchestratorPendingDispatch,
  OrchestratorPendingQuery,
  OrchestratorReceipt,
  type OrchestratorReceipt as OrchestratorReceiptType,
  OrchestratorRequest,
  type OrchestratorRequest as OrchestratorRequestType,
  OrchestratorResult,
  OrchestratorRoute,
  type OrchestratorRoute as OrchestratorRouteType,
  OrchestratorRoutedSubmission,
  type OrchestratorRoutedSubmission as OrchestratorRoutedSubmissionType,
  OrchestratorWorkLink,
  type OrchestratorWorkLink as OrchestratorWorkLinkType
} from "./orchestrator-model.js"

const Row = Schema.Struct({
  activityIdempotencyKey: Schema.String,
  dispatchRequestId: Schema.String,
  idempotencyKey: Schema.String,
  command: Schema.String,
  acceptedAt: Schema.Number,
  isRouted: Schema.Literals([0, 1]),
  status: Schema.String,
  route: Schema.NullOr(Schema.String),
  workLink: Schema.NullOr(Schema.String)
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
  isRouted: Schema.Literals([0, 1]),
  status: Schema.String,
  sequence: Schema.NullOr(Schema.Number),
  type: Schema.NullOr(Schema.String),
  eventActivityIdempotencyKey: Schema.NullOr(Schema.String),
  occurredAt: Schema.NullOr(Schema.Number),
  detail: Schema.NullOr(Schema.String),
  result: Schema.NullOr(Schema.String),
  route: Schema.NullOr(Schema.String),
  workLink: Schema.NullOr(Schema.String)
})
type LifecycleRow = typeof LifecycleRow.Type
const RecoveryRow = Schema.Struct({
  dispatchRequestId: DispatchRequestId,
  acceptedAt: Schema.Number
})
const SqliteColumnRow = Schema.Struct({ name: Schema.String })
type RecoveryRow = typeof RecoveryRow.Type
const recoveryPageSize = 256

const storageError = (operation: string) => (cause: unknown) => new OrchestratorStorageError({ cause, operation })

const verifyPathIdentity = (
  path: string,
  fileSystem: FileSystem.FileSystem,
  paths: Path.Path,
  operation: string
): Effect.Effect<void, OrchestratorStorageError> =>
  fileSystem.readLink(path).pipe(
    Effect.matchEffect({
      onFailure: (cause) =>
        cause.reason._tag === "NotFound" || cause.reason._tag === "Unknown"
          ? Effect.void
          : Effect.fail(new OrchestratorStorageError({ cause, operation: `${operation}.readlink` })),
      onSuccess: (target) => Effect.fail(new OrchestratorStorageError({ cause: { path, target }, operation }))
    }),
    Effect.andThen(
      fileSystem.exists(path).pipe(
        Effect.mapError((cause) => new OrchestratorStorageError({ cause, operation: `${operation}.exists` }))
      )
    ),
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

const decodeRoute = (text: string) =>
  Effect.try({
    try: () => JSON.parse(text),
    catch: storageError("decode.route.json")
  }).pipe(
    Effect.flatMap((value) => Schema.decodeUnknownEffect(OrchestratorRoute)(value)),
    Effect.mapError(storageError("decode.route"))
  )

const decodeWorkLink = (text: string) =>
  Effect.try({
    try: () => JSON.parse(text),
    catch: storageError("decode.work-link.json")
  }).pipe(
    Effect.flatMap((value) => Schema.decodeUnknownEffect(OrchestratorWorkLink)(value)),
    Effect.mapError(storageError("decode.work-link"))
  )

const decodeMetadata = Effect.fn("Orchestrator.decodeMetadata")(function*(
  routeText: string | null,
  workLinkText: string | null
) {
  const route = routeText === null ? null : yield* decodeRoute(routeText)
  const workLink = workLinkText === null ? null : yield* decodeWorkLink(workLinkText)
  if (route === null && workLink !== null) {
    return yield* new OrchestratorStorageError({
      cause: { route, workLink },
      operation: "decode.metadata-mismatch"
    })
  }
  if (route?.model === "gpt-5.6-luna" && workLink !== null) {
    return yield* new OrchestratorStorageError({
      cause: { route, workLink },
      operation: "decode.metadata-mismatch"
    })
  }
  if (route?.model === "gpt-5.6-sol") {
    if (workLink === null || (route.linkedRequestId !== null && !workLink.lineage.includes(route.linkedRequestId))) {
      return yield* new OrchestratorStorageError({
        cause: { route, workLink },
        operation: "decode.metadata-mismatch"
      })
    }
  }
  return { route, workLink }
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
type DispatchRow = Omit<typeof Row.Type, "status" | "route" | "workLink"> & {
  readonly status: CurrentStatus
  readonly route: OrchestratorRouteType | null
  readonly workLink: OrchestratorWorkLinkType | null
}

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

const isTerminalEvent = (event: OrchestratorEventType): boolean =>
  event.type === "settled" || event.type === "delivery_failed" || event.type === "task_failed"

export interface OrchestratorService {
  readonly submit: (
    command: OrchestratorCommandType,
    idempotencyKey: string
  ) => Effect.Effect<OrchestratorReceiptType, OrchestratorError>
  /** Submits with durable route metadata; Sol requires an atomic Work link. */
  readonly submitRouted: (
    input: OrchestratorRoutedSubmissionType
  ) => Effect.Effect<OrchestratorReceiptType, OrchestratorError>
  /** Loads and validates the complete durable request projection. */
  readonly request: (
    dispatchRequestId: string
  ) => Effect.Effect<OrchestratorRequestType, OrchestratorError>
  readonly events: (
    dispatchRequestId: string
  ) => Stream.Stream<OrchestratorEventType, OrchestratorError>
  /** Lists one bounded page of accepted and queued commands for explicit restart resumption. */
  readonly pending: (
    query?: typeof OrchestratorPendingQuery.Type
  ) => Effect.Effect<ReadonlyArray<typeof OrchestratorPendingDispatch.Type>, OrchestratorError>
  readonly queue: (dispatchRequestId: string) => Effect.Effect<OrchestratorEventType, OrchestratorError>
  /** Atomically records the running event and exact worker identity in Work. */
  readonly workerStarted: (
    activation: OrchestratorDispatchActivationType
  ) => Effect.Effect<OrchestratorDispatchActivatedType, OrchestratorError>
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
  const workSql = makeSqliteWorkBridge(sql)
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
      is_routed INTEGER NOT NULL DEFAULT 0 CHECK (is_routed IN (0, 1)),
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
    CREATE TABLE IF NOT EXISTS orchestrator_dispatch_metadata (
      dispatch_request_id TEXT PRIMARY KEY,
      route TEXT NOT NULL,
      work_link TEXT,
      FOREIGN KEY (dispatch_request_id) REFERENCES orchestrator_dispatches(dispatch_request_id)
    )
  `.pipe(Effect.mapError(storageError("initialize.dispatch-metadata")))
  yield* sql.withTransaction(
    Effect.gen(function*() {
      const columns = yield* sql`PRAGMA table_info(orchestrator_dispatches)`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SqliteColumnRow))),
        Effect.mapError(storageError("initialize.dispatch-columns"))
      )
      if (columns.some(({ name }) => name === "is_routed")) return
      yield* sql`
        ALTER TABLE orchestrator_dispatches
        ADD COLUMN is_routed INTEGER NOT NULL DEFAULT 0 CHECK (is_routed IN (0, 1))
      `.pipe(Effect.mapError(storageError("initialize.add-routed-discriminator")))
      yield* sql`
        UPDATE orchestrator_dispatches
        SET is_routed = 1
        WHERE EXISTS (
          SELECT 1 FROM orchestrator_dispatch_metadata metadata
          WHERE metadata.dispatch_request_id = orchestrator_dispatches.dispatch_request_id
        )
      `.pipe(Effect.mapError(storageError("initialize.backfill-routed-discriminator")))
    })
  ).pipe(Effect.catchTag("SqlError", (cause) => Effect.fail(storageError("initialize.route-migration")(cause))))
  yield* workSql.initialize.pipe(Effect.mapError(storageError("initialize.work")))
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
        d.accepted_at AS "acceptedAt", d.is_routed AS "isRouted", d.status,
        m.route, m.work_link AS "workLink",
        e.sequence, e.type, e.activity_idempotency_key AS "eventActivityIdempotencyKey",
        e.occurred_at AS "occurredAt", e.detail, e.result
      FROM orchestrator_dispatches d
      LEFT JOIN orchestrator_dispatch_metadata m
        ON m.dispatch_request_id = d.dispatch_request_id
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
    const metadata = yield* decodeMetadata(first.route, first.workLink)
    if ((first.isRouted === 1) !== (metadata.route !== null)) {
      return yield* new OrchestratorStorageError({
        cause: { isRouted: first.isRouted, route: metadata.route },
        operation: "decode.metadata-presence-mismatch"
      })
    }
    const dispatch: DispatchRow = {
      activityIdempotencyKey: first.activityIdempotencyKey,
      acceptedAt: first.acceptedAt,
      command: first.command,
      dispatchRequestId: first.dispatchRequestId,
      idempotencyKey: first.idempotencyKey,
      isRouted: first.isRouted,
      status,
      route: metadata.route,
      workLink: metadata.workLink
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

  const validateLinkedParent = Effect.fn("Orchestrator.validateLinkedParent")(function*(
    route: OrchestratorRouteType | null
  ) {
    if (route?.model !== "gpt-5.6-sol" || route.linkedRequestId === null) return
    const parent = yield* loadValidatedEvents(route.linkedRequestId)
    if (
      parent.dispatch.route?.model !== "gpt-5.6-luna" ||
      (parent.dispatch.status !== "delivery_failed" && parent.dispatch.status !== "task_failed")
    ) {
      return yield* new OrchestratorValidationError({
        detail: "linked Sol escalation must reference a failed Luna request"
      })
    }
  })

  const validateDurableReadback = Effect.fn("Orchestrator.validateDurableReadback")(function*(
    dispatch: DispatchRow,
    operation: string
  ) {
    yield* validateLinkedParent(dispatch.route)
    if (dispatch.route?.model !== "gpt-5.6-sol" || dispatch.workLink === null) return
    yield* workSql.requireDispatchHandoff({
      dispatchRequestId: dispatch.dispatchRequestId,
      handoff: dispatch.workLink.handoff,
      lineage: dispatch.workLink.lineage
    }).pipe(Effect.mapError(storageError(operation)))
  })

  const listPending = Effect.fn("Orchestrator.pending")(
    function*(query: typeof OrchestratorPendingQuery.Type = {}) {
      const decodedQuery = yield* Schema.decodeUnknownEffect(OrchestratorPendingQuery)(query).pipe(
        Effect.mapError(() => new OrchestratorValidationError({ detail: "pending query is invalid" }))
      )
      return yield* sql.withTransaction(
        Effect.gen(function*() {
          const limit = decodedQuery.limit ?? 256
          const rows = decodedQuery.after === undefined
            ? yield* sql`
      SELECT dispatch_request_id AS "dispatchRequestId", idempotency_key AS "idempotencyKey",
        activity_idempotency_key AS "activityIdempotencyKey", command,
        accepted_at AS "acceptedAt", is_routed AS "isRouted", status,
        m.route, m.work_link AS "workLink"
      FROM orchestrator_dispatches
      LEFT JOIN orchestrator_dispatch_metadata m USING (dispatch_request_id)
      WHERE status IN ('accepted', 'queued')
      ORDER BY accepted_at ASC, dispatch_request_id ASC
      LIMIT ${limit}
    `.pipe(Effect.mapError(storageError("pending.list")))
            : yield* sql`
      SELECT dispatch_request_id AS "dispatchRequestId", idempotency_key AS "idempotencyKey",
        activity_idempotency_key AS "activityIdempotencyKey", command,
        accepted_at AS "acceptedAt", is_routed AS "isRouted", status,
        m.route, m.work_link AS "workLink"
      FROM orchestrator_dispatches
      LEFT JOIN orchestrator_dispatch_metadata m USING (dispatch_request_id)
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
              if (snapshot.dispatch.status !== "accepted" && snapshot.dispatch.status !== "queued") {
                return Option.none()
              }
              yield* validateDurableReadback(snapshot.dispatch, "pending.work-link")
              const command = yield* decodeCommand(snapshot.dispatch.command)
              const pendingInput = {
                acceptedAt: snapshot.dispatch.acceptedAt,
                activityIdempotencyKey: snapshot.dispatch.activityIdempotencyKey,
                command,
                dispatchRequestId: snapshot.dispatch.dispatchRequestId,
                idempotencyKey: snapshot.dispatch.idempotencyKey,
                status: snapshot.dispatch.status
              }
              const pendingDispatch = yield* Schema.decodeUnknownEffect(OrchestratorPendingDispatch)(
                snapshot.dispatch.route === null
                  ? pendingInput
                  : { ...pendingInput, route: snapshot.dispatch.route, workLink: snapshot.dispatch.workLink }
              ).pipe(
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
        })
      ).pipe(
        Effect.catchTag(
          "SqlError",
          (cause) => Effect.fail(new OrchestratorStorageError({ cause, operation: "pending.transaction" }))
        )
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
        if (decodedTarget === "running" && dispatch.route?.model === "gpt-5.6-sol") {
          return yield* new OrchestratorValidationError({
            detail: "routed Sol dispatches require workerStarted with Work lane authority"
          })
        }
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

  const workerStarted: OrchestratorService["workerStarted"] = Effect.fn(
    "Orchestrator.workerStarted"
  )(function*(activation) {
    const decoded = yield* Schema.decodeUnknownEffect(OrchestratorDispatchActivation)(activation).pipe(
      Effect.mapError(() => new OrchestratorValidationError({ detail: "worker-start activation is invalid" }))
    )
    yield* secureFiles
    return yield* sql.withTransaction(
      Effect.gen(function*() {
        const snapshot = yield* loadValidatedEvents(decoded.dispatchRequestId)
        const dispatch = snapshot.dispatch
        if (
          dispatch.route?.model !== "gpt-5.6-sol" ||
          dispatch.workLink === null ||
          dispatch.workLink.handoff.laneId !== decoded.laneId
        ) {
          return yield* new OrchestratorValidationError({
            detail: "worker start must match the routed dispatch Work lane"
          })
        }
        yield* validateDurableReadback(dispatch, "worker-start.work-link")
        if (dispatch.status !== "queued") {
          if (
            dispatch.status !== "running" &&
            dispatch.status !== "settled" &&
            dispatch.status !== "delivery_failed" &&
            dispatch.status !== "task_failed"
          ) {
            return yield* new OrchestratorTransitionError({
              dispatchRequestId: decoded.dispatchRequestId,
              from: dispatch.status,
              to: "running"
            })
          }
          const binding = yield* workSql.requireAgentBinding(decoded).pipe(
            Effect.mapError((error): OrchestratorError =>
              error._tag === "WorkAgentBindingConflictError"
                ? new OrchestratorWorkerBindingConflictError({ dispatchRequestId: decoded.dispatchRequestId })
                : storageError("worker-start.work-binding")(error)
            )
          )
          const event = snapshot.events.find(({ type }) => type === "running")
          if (event === undefined || event.occurredAt !== binding.checkpoint.occurredAt) {
            return yield* new OrchestratorStorageError({
              cause: { binding, events: snapshot.events },
              operation: "worker-start.replay-boundary-mismatch"
            })
          }
          return yield* Schema.decodeUnknownEffect(OrchestratorDispatchActivated)({ binding, event }).pipe(
            Effect.mapError(storageError("worker-start.decode-replay"))
          )
        }
        const last = snapshot.events.at(-1)
        if (last === undefined) {
          return yield* new OrchestratorStorageError({
            cause: decoded.dispatchRequestId,
            operation: "worker-start.missing-event"
          })
        }
        const timestamp = yield* now
        if (timestamp < last.occurredAt) {
          return yield* new OrchestratorStorageError({
            cause: { dispatchRequestId: decoded.dispatchRequestId, previous: last.occurredAt, timestamp },
            operation: "worker-start.timestamp-regression"
          })
        }
        const bindingDecision = yield* workSql.acceptAgentBinding(decoded, timestamp).pipe(
          Effect.mapError((error): OrchestratorError => {
            if (error._tag === "WorkAgentBindingConflictError") {
              return new OrchestratorWorkerBindingConflictError({ dispatchRequestId: decoded.dispatchRequestId })
            }
            if (error._tag === "WorkAgentBindingAuthorityError") {
              return new OrchestratorWorkerStartAuthorityError({
                actualRevision: error.actualRevision,
                expectedRevision: error.expectedRevision,
                laneId: error.laneId,
                reason: error.reason
              })
            }
            return storageError("worker-start.work-binding")(error)
          })
        )
        if (bindingDecision._tag === "replayed") {
          return yield* new OrchestratorStorageError({
            cause: bindingDecision.binding,
            operation: "worker-start.partial-binding"
          })
        }
        const binding = bindingDecision.binding
        const event = yield* Schema.decodeUnknownEffect(OrchestratorEvent)({
          activityIdempotencyKey: last.activityIdempotencyKey,
          dispatchRequestId: decoded.dispatchRequestId,
          occurredAt: binding.checkpoint.occurredAt,
          sequence: last.sequence + 1,
          type: "running",
          detail: null,
          result: null
        }).pipe(
          Effect.mapError(() => new OrchestratorValidationError({ detail: "worker-start event exceeds bounds" }))
        )
        yield* sql`
          INSERT INTO orchestrator_events
            (dispatch_request_id, sequence, type, activity_idempotency_key, occurred_at, detail, result)
          VALUES (${event.dispatchRequestId}, ${event.sequence}, ${event.type},
            ${event.activityIdempotencyKey}, ${event.occurredAt}, NULL, NULL)
        `.pipe(Effect.mapError(storageError("worker-start.insert-event")))
        const updated = yield* sql`
          UPDATE orchestrator_dispatches SET status = 'running'
          WHERE dispatch_request_id = ${decoded.dispatchRequestId} AND status = 'queued'
          RETURNING dispatch_request_id
        `.pipe(Effect.mapError(storageError("worker-start.update-dispatch")))
        if (updated.length !== 1) {
          return yield* new OrchestratorTransitionError({
            dispatchRequestId: decoded.dispatchRequestId,
            from: dispatch.status,
            to: "running"
          })
        }
        return yield* Schema.decodeUnknownEffect(OrchestratorDispatchActivated)({ binding, event }).pipe(
          Effect.mapError(storageError("worker-start.decode"))
        )
      })
    ).pipe(
      Effect.catchTag("SqlError", (cause) => Effect.fail(storageError("worker-start.transaction")(cause)))
    )
  })

  const submitInternal = Effect.fn("Orchestrator.submitInternal")(function*(
    decodedCommand: OrchestratorCommandType,
    decodedKey: OrchestratorIdempotencyKeyType,
    route: OrchestratorRouteType | null,
    workLink: OrchestratorWorkLinkType | null
  ) {
    const encodedCommand = JSON.stringify(decodedCommand)
    const encodedRoute = route === null ? null : JSON.stringify(route)
    const encodedWorkLink = workLink === null ? null : JSON.stringify(workLink)
    yield* secureFiles
    return yield* sql.withTransaction(
      Effect.gen(function*() {
        const replayIds = yield* sql`
          SELECT dispatch_request_id AS "dispatchRequestId"
          FROM orchestrator_dispatches
          WHERE idempotency_key = ${decodedKey}
            OR activity_idempotency_key = ${decodedCommand.activityIdempotencyKey}
          ORDER BY dispatch_request_id ASC
          LIMIT 1
        `.pipe(
          Effect.mapError(storageError("submit.preload-replay")),
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({
            dispatchRequestId: DispatchRequestId
          })))),
          Effect.mapError(storageError("submit.decode-preloaded-replay"))
        )
        const replayId = replayIds[0]?.dispatchRequestId
        const dispatchRequestId = replayId ??
          (yield* cryptoService.randomUUIDv4.pipe(
            Effect.mapError(storageError("submit.request-id")),
            Effect.flatMap((value) =>
              Schema.decodeUnknownEffect(DispatchRequestId)(value).pipe(
                Effect.mapError(() =>
                  new OrchestratorStorageError({ cause: value, operation: "submit.request-id-schema" })
                )
              )
            )
          ))
        yield* validateLinkedParent(route)
        const acceptedAt = yield* now
        const insertedRows = yield* sql`
          INSERT INTO orchestrator_dispatches
            (dispatch_request_id, idempotency_key, activity_idempotency_key, command, accepted_at, is_routed, status)
          VALUES (${dispatchRequestId}, ${decodedKey}, ${decodedCommand.activityIdempotencyKey},
            ${encodedCommand}, ${acceptedAt}, ${route === null ? 0 : 1}, 'accepted')
          ON CONFLICT DO NOTHING
          RETURNING dispatch_request_id
        `.pipe(Effect.mapError(storageError("submit.insert-or-reload")))
        const wasInserted = insertedRows.length !== 0
        if (!wasInserted) {
          const persistedRows = yield* sql`
            SELECT d.dispatch_request_id AS "dispatchRequestId", d.idempotency_key AS "idempotencyKey",
              d.activity_idempotency_key AS "activityIdempotencyKey", d.command,
              d.accepted_at AS "acceptedAt", d.is_routed AS "isRouted", d.status,
              m.route, m.work_link AS "workLink"
            FROM orchestrator_dispatches d
            LEFT JOIN orchestrator_dispatch_metadata m USING (dispatch_request_id)
            WHERE d.idempotency_key = ${decodedKey}
              OR d.activity_idempotency_key = ${decodedCommand.activityIdempotencyKey}
          `.pipe(Effect.mapError(storageError("submit.reload")))
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
          if (first.idempotencyKey !== decodedKey) {
            return yield* new OrchestratorConflictError({
              detail: "activity idempotency key was already used",
              idempotencyKey: decodedKey
            })
          }
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
          const snapshot = yield* loadValidatedEvents(first.dispatchRequestId).pipe(
            Effect.catchTag("OrchestratorStorageError", (error) =>
              Effect.fail(
                new OrchestratorStorageError({
                  cause: error.cause,
                  operation: "submit.accepted-event-mismatch"
                })
              ))
          )
          if (!Equal.equals(snapshot.dispatch.route, route) || !Equal.equals(snapshot.dispatch.workLink, workLink)) {
            return yield* new OrchestratorConflictError({
              detail: "idempotency key was already used with different route or Work lineage",
              idempotencyKey: decodedKey
            })
          }
          const accepted = snapshot.events[0]
          if (
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
          if (route?.model === "gpt-5.6-sol" && workLink !== null) {
            yield* workSql.requireDispatchHandoff({
              dispatchRequestId: first.dispatchRequestId,
              handoff: workLink.handoff,
              lineage: workLink.lineage
            }).pipe(Effect.mapError(storageError("submit.work-link.replay")))
          }
          return yield* Schema.decodeUnknownEffect(OrchestratorReceipt)({
            acceptedAt,
            dispatchRequestId: first.dispatchRequestId,
            idempotencyKey: decodedKey,
            status: "accepted"
          }).pipe(Effect.mapError(storageError("submit.decode-receipt")))
        }
        if (route?.model === "gpt-5.6-sol" && workLink !== null) {
          yield* workSql.acceptDispatchHandoff({
            dispatchRequestId,
            handoff: workLink.handoff,
            lineage: workLink.lineage
          }).pipe(Effect.mapError(storageError("submit.work-link")))
        }
        if (route !== null) {
          yield* sql`
            INSERT INTO orchestrator_dispatch_metadata
              (dispatch_request_id, route, work_link)
            VALUES (${dispatchRequestId}, ${encodedRoute}, ${encodedWorkLink})
          `.pipe(Effect.mapError(storageError("submit.insert-dispatch-metadata")))
        }
        yield* sql`
          INSERT INTO orchestrator_events
            (dispatch_request_id, sequence, type, activity_idempotency_key, occurred_at, detail, result)
          VALUES (${dispatchRequestId}, 0, 'accepted', ${decodedCommand.activityIdempotencyKey}, ${acceptedAt}, NULL, NULL)
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
  })

  const submit: OrchestratorService["submit"] = Effect.fn("Orchestrator.submit")(function*(
    command: OrchestratorCommandType,
    idempotencyKey: string
  ) {
    const decodedCommand = yield* Schema.decodeUnknownEffect(OrchestratorCommand)(command).pipe(
      Effect.mapError(() => new OrchestratorValidationError({ detail: "command is not a typed fleet job" }))
    )
    const decodedKey = yield* Schema.decodeUnknownEffect(OrchestratorIdempotencyKey)(idempotencyKey).pipe(
      Effect.mapError(() => new OrchestratorValidationError({ detail: "idempotency key is invalid" }))
    )
    return yield* submitInternal(decodedCommand, decodedKey, null, null)
  })

  const submitRouted: OrchestratorService["submitRouted"] = Effect.fn("Orchestrator.submitRouted")(function*(input) {
    const decoded = yield* Schema.decodeUnknownEffect(OrchestratorRoutedSubmission)(input).pipe(
      Effect.mapError(() => new OrchestratorValidationError({ detail: "routed submission is invalid" }))
    )
    if (
      decoded.route.model === "gpt-5.6-sol" &&
      decoded.route.linkedRequestId !== null &&
      decoded.workLink !== null &&
      !decoded.workLink.lineage.includes(decoded.route.linkedRequestId)
    ) {
      return yield* new OrchestratorValidationError({
        detail: "Work lineage must include the linked Luna request"
      })
    }
    return yield* submitInternal(decoded.command, decoded.idempotencyKey, decoded.route, decoded.workLink)
  })

  const service: OrchestratorService = {
    events: (dispatchRequestId) =>
      Stream.unwrap(
        Schema.decodeUnknownEffect(DispatchRequestId)(dispatchRequestId).pipe(
          Effect.mapError(() => new OrchestratorValidationError({ detail: "dispatch request ID is invalid" })),
          Effect.map((decodedDispatchRequestId) =>
            Stream.succeed(undefined).pipe(
              Stream.concat(
                Stream.fromSchedule(Schedule.spaced("100 millis")).pipe(Stream.map(() => undefined))
              ),
              Stream.mapEffect(() => loadValidatedEvents(decodedDispatchRequestId)),
              Stream.mapAccum(
                () => -1,
                (lastSequence, snapshot): readonly [number, ReadonlyArray<OrchestratorEventType>] => {
                  const unseen = snapshot.events.filter(({ sequence }) => sequence > lastSequence)
                  const last = unseen.at(-1)
                  return [last?.sequence ?? lastSequence, unseen]
                }
              ),
              Stream.takeUntil(isTerminalEvent)
            )
          )
        )
      ),
    failDelivery: Effect.fn("Orchestrator.failDelivery")((dispatchRequestId, detail) =>
      appendTransition(dispatchRequestId, "delivery_failed", detail, null)
    ),
    failTask: Effect.fn("Orchestrator.failTask")((dispatchRequestId, detail) =>
      appendTransition(dispatchRequestId, "task_failed", detail, null)
    ),
    pending: listPending,
    queue: Effect.fn("Orchestrator.queue")((dispatchRequestId) =>
      appendTransition(dispatchRequestId, "queued", null, null)
    ),
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
    run: Effect.fn("Orchestrator.run")((dispatchRequestId) =>
      appendTransition(dispatchRequestId, "running", null, null)
    ),
    settle: Effect.fn("Orchestrator.settle")((dispatchRequestId, result) =>
      appendTransition(dispatchRequestId, "settled", null, result)
    ),
    submit,
    submitRouted,
    workerStarted,
    request: Effect.fn("Orchestrator.request")((dispatchRequestId) =>
      Schema.decodeUnknownEffect(DispatchRequestId)(dispatchRequestId).pipe(
        Effect.mapError(() => new OrchestratorValidationError({ detail: "dispatch request ID is invalid" })),
        Effect.flatMap(loadValidatedEvents),
        Effect.flatMap((snapshot) =>
          Effect.gen(function*() {
            yield* validateDurableReadback(snapshot.dispatch, "request.work-link")
            const command = yield* decodeCommand(snapshot.dispatch.command)
            return yield* Schema.decodeUnknownEffect(OrchestratorRequest)({
              ...snapshot.dispatch,
              command
            }).pipe(Effect.mapError(storageError("request.decode")))
          })
        )
      )
    )
  }
  return service
})

const orchestratorLayer: Layer.Layer<Orchestrator, OrchestratorError, SqlClientService | Crypto.Crypto> = Layer.effect(
  Orchestrator,
  makeOrchestrator
)

/**
 * Node SQLite and Crypto services used by the durable coordinator layers.
 * Fails closed on non-POSIX paths until an ACL-backed private-directory check exists.
 */
export const sqliteLayer = (filename: string): Layer.Layer<Orchestrator, OrchestratorError> =>
  orchestratorLayer.pipe(Layer.provide(
    Layer.unwrap(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const paths = yield* Path.Path
        const directory = paths.dirname(filename)
        const directoryExists = yield* fileSystem.exists(directory).pipe(
          Effect.mapError((cause) =>
            new OrchestratorStorageError({ cause, operation: "sqlite.secure.directory.exists" })
          )
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
  ))
