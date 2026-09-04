import { Effect, Equal, Schema } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"
import {
  WorkDecisionHandoffConflictError,
  WorkDispatchHandoffConflictError,
  WorkProjectionError,
  WorkStoreError
} from "./errors.js"
import {
  WorkDecisionHandoff,
  type WorkDecisionHandoff as WorkDecisionHandoffType,
  WorkDispatchHandoff,
  type WorkDispatchHandoff as WorkDispatchHandoffType
} from "./model.js"

const DecisionRow = Schema.Struct({
  handoffId: Schema.String,
  laneId: Schema.String,
  occurredAt: Schema.Number,
  record: Schema.String
})
const DispatchHandoffRow = Schema.Struct({
  dispatchRequestId: Schema.String,
  handoffId: Schema.String,
  laneId: Schema.String,
  occurredAt: Schema.Number,
  lineage: Schema.String,
  record: Schema.String
})
const DecisionLedgerTotalsRow = Schema.Struct({
  decisionBytes: Schema.Number,
  decisionCount: Schema.Number
})

const workDecisionMaxRecords = 16_384
const workDecisionMaxBytes = 2 * 1024 * 1024
const utf8 = new TextEncoder()
const storeError = (operation: string) => (cause: unknown) => new WorkStoreError({ cause, operation })

const encodedBytes = (value: string): number => utf8.encode(value).byteLength

const decodeHandoff = (row: typeof DecisionRow.Type) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(WorkDecisionHandoff)(JSON.parse(row.record)),
    catch: storeError("sql-work.decode-handoff")
  }).pipe(
    Effect.flatMap((handoff) =>
      row.handoffId !== handoff.id || row.laneId !== handoff.laneId || row.occurredAt !== handoff.occurredAt
        ? Effect.fail(
          new WorkStoreError({
            cause: { handoff, row },
            operation: "sql-work.decode-handoff.identity-mismatch"
          })
        )
        : Effect.succeed(handoff)
    )
  )

const decodeDispatchHandoff = (row: typeof DispatchHandoffRow.Type) =>
  Effect.try({
    try: () =>
      Schema.decodeUnknownSync(WorkDispatchHandoff)({
        dispatchRequestId: row.dispatchRequestId,
        handoff: JSON.parse(row.record),
        lineage: JSON.parse(row.lineage)
      }),
    catch: storeError("sql-work.decode-dispatch-handoff")
  }).pipe(
    Effect.flatMap((binding) =>
      row.handoffId !== binding.handoff.id ||
        row.laneId !== binding.handoff.laneId ||
        row.occurredAt !== binding.handoff.occurredAt
        ? Effect.fail(
          new WorkStoreError({
            cause: { binding, row },
            operation: "sql-work.decode-dispatch-handoff.identity-mismatch"
          })
        )
        : Effect.succeed(binding)
    )
  )

export interface WorkSqlBridge {
  /** Creates the Work decision and dispatch-link tables in the caller's SQL database. */
  readonly initialize: Effect.Effect<void, WorkStoreError | SqlError>
  /** Inserts or replays one binding; the caller owns the surrounding transaction. */
  readonly acceptDispatchHandoff: (
    binding: WorkDispatchHandoffType
  ) => Effect.Effect<
    WorkDispatchHandoffType,
    | WorkDecisionHandoffConflictError
    | WorkDispatchHandoffConflictError
    | WorkProjectionError
    | WorkStoreError
    | SqlError
  >
  /** Verifies a replayed binding without repairing a previously incomplete dispatch. */
  readonly requireDispatchHandoff: (
    binding: WorkDispatchHandoffType
  ) => Effect.Effect<WorkDispatchHandoffType, WorkDispatchHandoffConflictError | WorkStoreError | SqlError>
}

/**
 * SQL-backed Work operations designed to run inside a coordinator transaction.
 * It does not begin or commit a transaction itself, so dispatch acceptance and
 * Work lineage either commit together or roll back together.
 */
export const makeWorkSqlBridge = (sql: SqlClientService): WorkSqlBridge => {
  const initialize = Effect.gen(function*() {
    yield* sql`
      CREATE TABLE IF NOT EXISTS work_decision_handoffs (
        handoff_id TEXT PRIMARY KEY,
        lane_id TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        record TEXT NOT NULL
      )
    `.pipe(Effect.mapError(storeError("sql-work.initialize.handoffs")))
    yield* sql`
      CREATE TABLE IF NOT EXISTS work_decision_totals (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        decision_count INTEGER NOT NULL CHECK (decision_count >= 0),
        decision_bytes INTEGER NOT NULL CHECK (decision_bytes >= 0)
      )
    `.pipe(Effect.mapError(storeError("sql-work.initialize.totals")))
    yield* sql`
      CREATE TRIGGER IF NOT EXISTS work_decision_handoffs_after_insert
      AFTER INSERT ON work_decision_handoffs
      BEGIN
        UPDATE work_decision_totals
        SET decision_count = decision_count + 1,
            decision_bytes = decision_bytes +
              length(CAST(NEW.handoff_id AS BLOB)) + length(CAST(NEW.record AS BLOB))
        WHERE singleton = 1;
      END
    `.pipe(Effect.mapError(storeError("sql-work.initialize.trigger")))
    yield* sql`
      CREATE TABLE IF NOT EXISTS work_dispatch_handoffs (
        dispatch_request_id TEXT PRIMARY KEY,
        handoff_id TEXT NOT NULL UNIQUE,
        lane_id TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        lineage TEXT NOT NULL,
        record TEXT NOT NULL,
        FOREIGN KEY (handoff_id) REFERENCES work_decision_handoffs(handoff_id)
      )
    `.pipe(Effect.mapError(storeError("sql-work.initialize.dispatch-links")))
    yield* sql`
      CREATE INDEX IF NOT EXISTS work_dispatch_handoffs_lane
        ON work_dispatch_handoffs (lane_id, occurred_at, dispatch_request_id)
    `.pipe(Effect.mapError(storeError("sql-work.initialize.dispatch-index")))
    yield* sql`
      INSERT OR IGNORE INTO work_decision_totals
        (singleton, decision_count, decision_bytes)
      SELECT 1, COUNT(*), COALESCE(SUM(
        length(CAST(handoff_id AS BLOB)) + length(CAST(record AS BLOB))
      ), 0)
      FROM work_decision_handoffs
    `.pipe(Effect.mapError(storeError("sql-work.initialize.totals-row")))
  })

  const readDecision = (handoff: WorkDecisionHandoffType) =>
    sql`
      SELECT handoff_id AS "handoffId", lane_id AS "laneId", occurred_at AS "occurredAt", record
      FROM work_decision_handoffs WHERE handoff_id = ${handoff.id}
    `.pipe(
      Effect.mapError(storeError("sql-work.read-handoff")),
      Effect.flatMap((rows) =>
        Schema.decodeUnknownEffect(Schema.Array(DecisionRow))(rows).pipe(
          Effect.mapError(storeError("sql-work.decode-handoff-row")),
          Effect.flatMap((decoded) => {
            const row = decoded[0]
            return row === undefined
              ? Effect.succeed(null)
              : decodeHandoff(row).pipe(Effect.map((value) => ({ row, value })))
          })
        )
      )
    )

  const readBinding = (dispatchRequestId: string) =>
    sql`
      SELECT dispatch_request_id AS "dispatchRequestId", handoff_id AS "handoffId",
        lane_id AS "laneId", occurred_at AS "occurredAt", lineage, record
      FROM work_dispatch_handoffs WHERE dispatch_request_id = ${dispatchRequestId}
    `.pipe(
      Effect.mapError(storeError("sql-work.read-dispatch-handoff")),
      Effect.flatMap((rows) =>
        Schema.decodeUnknownEffect(Schema.Array(DispatchHandoffRow))(rows).pipe(
          Effect.mapError(storeError("sql-work.decode-dispatch-handoff-row")),
          Effect.flatMap((decoded) => {
            const row = decoded[0]
            return row === undefined
              ? Effect.succeed(null)
              : decodeDispatchHandoff(row).pipe(Effect.map((value) => ({ row, value })))
          })
        )
      )
    )

  const conflict = (binding: WorkDispatchHandoffType) =>
    new WorkDispatchHandoffConflictError({
      dispatchRequestId: binding.dispatchRequestId,
      handoffId: binding.handoff.id
    })

  const acceptDispatchHandoff: WorkSqlBridge["acceptDispatchHandoff"] = Effect.fn(
    "WorkSqlBridge.acceptDispatchHandoff"
  )(function*(binding) {
    const decoded = yield* Schema.decodeUnknownEffect(WorkDispatchHandoff)(binding).pipe(
      Effect.mapError(storeError("sql-work.accept.decode"))
    )
    const existingBinding = yield* readBinding(decoded.dispatchRequestId)
    if (existingBinding !== null) {
      return Equal.equals(existingBinding.value, decoded)
        ? existingBinding.value
        : yield* conflict(decoded)
    }

    const existingHandoff = yield* readDecision(decoded.handoff)
    if (existingHandoff !== null && !Equal.equals(existingHandoff.value, decoded.handoff)) {
      return yield* new WorkDecisionHandoffConflictError({ handoffId: decoded.handoff.id })
    }
    if (existingHandoff === null) {
      const encodedHandoff = JSON.stringify(decoded.handoff)
      const totals = yield* sql`
        SELECT decision_count AS "decisionCount", decision_bytes AS "decisionBytes"
        FROM work_decision_totals WHERE singleton = 1
      `.pipe(
        Effect.mapError(storeError("sql-work.read-totals")),
        Effect.flatMap((rows) =>
          Schema.decodeUnknownEffect(Schema.Array(DecisionLedgerTotalsRow))(rows).pipe(
            Effect.mapError(storeError("sql-work.decode-totals")),
            Effect.flatMap((decodedRows) => {
              const row = decodedRows[0]
              return row === undefined
                ? Effect.fail(new WorkStoreError({ cause: decodedRows, operation: "sql-work.missing-totals" }))
                : Effect.succeed(row)
            })
          )
        )
      )
      const handoffBytes = encodedBytes(decoded.handoff.id) + encodedBytes(encodedHandoff)
      if (totals.decisionCount >= workDecisionMaxRecords) {
        return yield* new WorkProjectionError({
          cause: decoded,
          detail: `work decision history cannot exceed ${workDecisionMaxRecords} handoffs`,
          reason: "capacity_exceeded"
        })
      }
      if (totals.decisionBytes + handoffBytes > workDecisionMaxBytes) {
        return yield* new WorkProjectionError({
          cause: decoded,
          detail: `work decision history cannot exceed ${workDecisionMaxBytes} encoded bytes`,
          reason: "capacity_exceeded"
        })
      }
      yield* sql`
        INSERT INTO work_decision_handoffs (handoff_id, lane_id, occurred_at, record)
        VALUES (${decoded.handoff.id}, ${decoded.handoff.laneId}, ${decoded.handoff.occurredAt}, ${encodedHandoff})
      `.pipe(Effect.mapError(storeError("sql-work.insert-handoff")))
    }

    const encodedLineage = JSON.stringify(decoded.lineage)
    const encodedRecord = JSON.stringify(decoded.handoff)
    const inserted = yield* sql`
      INSERT INTO work_dispatch_handoffs
        (dispatch_request_id, handoff_id, lane_id, occurred_at, lineage, record)
      VALUES (${decoded.dispatchRequestId}, ${decoded.handoff.id}, ${decoded.handoff.laneId},
        ${decoded.handoff.occurredAt}, ${encodedLineage}, ${encodedRecord})
      ON CONFLICT DO NOTHING
      RETURNING dispatch_request_id AS "dispatchRequestId", handoff_id AS "handoffId",
        lane_id AS "laneId", occurred_at AS "occurredAt", lineage, record
    `.pipe(Effect.mapError(storeError("sql-work.insert-dispatch-handoff")))
    if (inserted.length > 0) return decoded
    const winner = yield* readBinding(decoded.dispatchRequestId)
    return winner !== null && Equal.equals(winner.value, decoded)
      ? winner.value
      : yield* conflict(decoded)
  })

  const requireDispatchHandoff: WorkSqlBridge["requireDispatchHandoff"] = Effect.fn(
    "WorkSqlBridge.requireDispatchHandoff"
  )(function*(binding) {
    const decoded = yield* Schema.decodeUnknownEffect(WorkDispatchHandoff)(binding).pipe(
      Effect.mapError(storeError("sql-work.require.decode"))
    )
    const existing = yield* readBinding(decoded.dispatchRequestId)
    return existing === null
      ? yield* new WorkStoreError({ cause: decoded, operation: "sql-work.require.missing" })
      : Equal.equals(existing.value, decoded)
      ? existing.value
      : yield* conflict(decoded)
  })

  return { acceptDispatchHandoff, initialize, requireDispatchHandoff }
}
