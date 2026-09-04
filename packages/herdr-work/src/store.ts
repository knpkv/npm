import { fleetResponseBodyMaxBytes } from "@knpkv/herdr-fleet"
import { Crypto, Effect, Encoding, Equal, FileSystem, Option, Path, Schema } from "effect"
import { DatabaseSync, type SQLOutputValue } from "node:sqlite"
import {
  WorkCheckpointConflictError,
  WorkDecisionHandoffConflictError,
  WorkLaneClaimConflictError,
  WorkProjectionError,
  WorkStoreError,
  WorkTransactionConflictError
} from "./errors.js"
import { validateGoalFamilyHistory } from "./goal-family.js"
import {
  WorkDecisionHandoff,
  WorkGoalCheckpoint,
  WorkGoalId,
  workHistoryMaxEvents,
  WorkLaneClaim,
  WorkLaneClaimed,
  workSnapshotMaxGoals
} from "./model.js"
import type {
  WorkDecisionHandoff as WorkDecisionHandoffType,
  WorkGoalCheckpoint as WorkGoalCheckpointType
} from "./model.js"

const StoredEventRow = Schema.Struct({ record: Schema.String })
const StoredEventRows = Schema.Array(StoredEventRow)
const StoredEventWithTransactionRow = Schema.Struct({
  eventId: Schema.String,
  goalId: Schema.String,
  occurredAt: Schema.Number,
  record: Schema.String,
  transactionId: Schema.NullOr(Schema.String)
})
const StoredEventWithTransactionRows = Schema.Array(StoredEventWithTransactionRow)
const TransactionRow = Schema.Struct({ record: Schema.String })
const TransactionEventIdentity = Schema.Struct({
  eventId: Schema.String,
  goalId: Schema.String,
  occurredAt: Schema.Number
})
const LegacyCompactTransactionRecord = Schema.Struct({
  events: Schema.Array(TransactionEventIdentity),
  version: Schema.Literal("herdr.work.transaction.v1")
})
const CompactTransactionRecord = Schema.Struct({
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  version: Schema.Literal("herdr.work.transaction.v3")
})
const PreviousCompactTransactionRecord = Schema.Struct({
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  version: Schema.Literal("herdr.work.transaction.v2")
})
const LaneRow = Schema.Struct({ record: Schema.String, revision: Schema.Number })
const DecisionRow = Schema.Struct({
  handoffId: Schema.String,
  laneId: Schema.String,
  occurredAt: Schema.Number,
  record: Schema.String
})
const CountRow = Schema.Struct({ count: Schema.Number })
const DecisionLedgerTotalsRow = Schema.Struct({
  decisionBytes: Schema.Number,
  decisionCount: Schema.Number
})
const LedgerBytesRow = Schema.Struct({ bytes: Schema.Number })
const TransactionLedgerTotalsRow = Schema.Struct({
  transactionBytes: Schema.Number,
  transactionCount: Schema.Number
})
const TransactionId = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(256),
  Schema.isPattern(/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/)
)
const storeError = (operation: string) => (cause: unknown) => new WorkStoreError({ cause, operation })
const readTransactionLedgerTotals = (database: DatabaseSync) =>
  Schema.decodeUnknownSync(TransactionLedgerTotalsRow)(
    database.prepare(
      `SELECT transaction_count AS transactionCount, transaction_bytes AS transactionBytes
       FROM work_goal_transaction_totals WHERE singleton = 1`
    ).get()
  )
const readDecisionLedgerTotals = (database: DatabaseSync) =>
  Schema.decodeUnknownSync(DecisionLedgerTotalsRow)(
    database.prepare(
      `SELECT decision_count AS decisionCount, decision_bytes AS decisionBytes
       FROM work_decision_totals WHERE singleton = 1`
    ).get()
  )
type AppendRejection = WorkCheckpointConflictError | WorkProjectionError
type AppendDecision =
  | { readonly _tag: "inserted"; readonly changes: bigint | number }
  | { readonly _tag: "replayed"; readonly event: WorkGoalCheckpointType }
  | { readonly _tag: "rejected"; readonly error: AppendRejection }

type AppendManyDecision =
  | { readonly _tag: "inserted"; readonly events: ReadonlyArray<WorkGoalCheckpointType> }
  | { readonly _tag: "replayed"; readonly events: ReadonlyArray<WorkGoalCheckpointType> }
  | {
    readonly _tag: "rejected"
    readonly error: AppendRejection | WorkTransactionConflictError | WorkStoreError
  }

type ClaimDecision =
  | { readonly _tag: "conflict"; readonly error: WorkLaneClaimConflictError }
  | { readonly _tag: "rejected"; readonly error: WorkProjectionError | WorkStoreError }
  | { readonly _tag: "claimed"; readonly value: WorkLaneClaimed }

type HandoffDecision =
  | { readonly _tag: "conflict"; readonly error: WorkDecisionHandoffConflictError }
  | { readonly _tag: "replayed"; readonly value: WorkDecisionHandoffType }
  | { readonly _tag: "inserted"; readonly value: WorkDecisionHandoffType }
  | { readonly _tag: "rejected"; readonly error: WorkProjectionError | WorkStoreError }

const utf8 = new TextEncoder()
const encodedBytes = (value: typeof Schema.Json.Type): number => utf8.encode(JSON.stringify(value)).byteLength
const maximumTimestamp = 8_640_000_000_000_000
const workTransactionMaxRecords = 16_384
const workTransactionMaxBytes = 2 * 1024 * 1024
const workLaneMaxRecords = workSnapshotMaxGoals
const workLaneMaxBytes = 2 * 1024 * 1024
const workDecisionMaxRecords = 16_384
const workDecisionMaxBytes = 2 * 1024 * 1024
const workStoreBusyTimeoutMillis = 5_000
const workSnapshotEnvelopeMaxBytes = encodedBytes({
  observedAt: maximumTimestamp,
  now: { window: "now", observedAt: maximumTimestamp, asOf: maximumTimestamp, goals: [], families: [] },
  day: { window: "day", observedAt: maximumTimestamp, asOf: maximumTimestamp, goals: [], families: [] },
  week: { window: "week", observedAt: maximumTimestamp, asOf: maximumTimestamp, goals: [], families: [] },
  month: { window: "month", observedAt: maximumTimestamp, asOf: maximumTimestamp, goals: [], families: [] }
})

const makeSnapshotByteAccumulator = (history: ReadonlyArray<WorkGoalCheckpointType>) => {
  const maximumGoalBytes = new Map<string, number>()
  let encodedGoals = 0
  for (const { goal } of history) {
    const bytes = encodedBytes(goal)
    const previous = maximumGoalBytes.get(goal.id)
    if (previous === undefined) {
      maximumGoalBytes.set(goal.id, bytes)
      encodedGoals += bytes
    } else if (bytes > previous) {
      maximumGoalBytes.set(goal.id, bytes)
      encodedGoals += bytes - previous
    }
  }
  return {
    add: (candidate: WorkGoalCheckpointType): number => {
      const bytes = encodedBytes(candidate.goal)
      const previous = maximumGoalBytes.get(candidate.goal.id)
      if (previous === undefined) {
        maximumGoalBytes.set(candidate.goal.id, bytes)
        encodedGoals += bytes
      } else if (bytes > previous) {
        maximumGoalBytes.set(candidate.goal.id, bytes)
        encodedGoals += bytes - previous
      }
      const separators = Math.max(0, maximumGoalBytes.size - 1)
      return workSnapshotEnvelopeMaxBytes + 4 * (encodedGoals + separators)
    }
  }
}

const maximumSnapshotBytes = (
  history: ReadonlyArray<WorkGoalCheckpointType>,
  candidate: WorkGoalCheckpointType
): number => {
  const maximumGoalBytes = new Map<string, number>()
  for (const { goal } of [...history, candidate]) {
    const bytes = encodedBytes(goal)
    maximumGoalBytes.set(
      goal.id,
      Math.max(maximumGoalBytes.get(goal.id) ?? 0, bytes)
    )
  }
  const encodedGoals = [...maximumGoalBytes.values()].reduce(
    (total, bytes) => total + bytes,
    0
  )
  const separators = Math.max(0, maximumGoalBytes.size - 1)
  // Derive the typed family overhead from actual projected family groups rather than
  // charging the maximum encoded canonicalGoalId for every distinct goal. The projection
  // keeps a latest durable goal per id; only canonical goals with superseded members
  // form a family group and repeat the canonicalGoalId outside the canonical payload.
  const latest = new Map<string, WorkGoalCheckpointType["goal"]>()
  for (
    const event of [...history, candidate].toSorted(
      (left, right) => left.occurredAt - right.occurredAt
    )
  ) {
    latest.set(event.goal.id, event.goal)
  }
  const canonicalById = new Map<string, WorkGoalCheckpointType["goal"]>()
  for (const goal of latest.values()) {
    if (goal.goalFamily?.role === "canonical") canonicalById.set(goal.id, goal)
  }
  let canonicalBytesSum = 0
  let familyGroupsOverheadSum = 0
  for (const [canonicalGoalId] of canonicalById) {
    const supersededCount = [...latest.values()].filter(
      (goal) =>
        goal.goalFamily?.role === "superseded" &&
        goal.goalFamily.canonicalGoalId === canonicalGoalId
    ).length
    if (supersededCount === 0) continue
    canonicalBytesSum += maximumGoalBytes.get(canonicalGoalId) ?? 0
    // Structural bytes for {"canonicalGoalId":"","canonical":<goal>,"superseded":[]} beyond the
    // encoded goal and id values is 49 (measured via JSON.stringify), 64 reserves it safely.
    familyGroupsOverheadSum += encodedBytes(canonicalGoalId) + 64
  }
  const familiesPerWindowBytes = encodedGoals + canonicalBytesSum + familyGroupsOverheadSum + separators
  return workSnapshotEnvelopeMaxBytes + 4 * Math.max(encodedGoals + separators, familiesPerWindowBytes)
}

const transactionContent = (events: ReadonlyArray<WorkGoalCheckpointType>) => JSON.stringify(events)

export const __herdrWorkMaximumSnapshotBytesForTest = maximumSnapshotBytes
export const __herdrWorkEncodedBytesForTest = encodedBytes
export const __herdrWorkSnapshotEnvelopeMaxBytesForTest = workSnapshotEnvelopeMaxBytes

const decodeRow = (row: Readonly<Record<string, SQLOutputValue>>) =>
  Schema.decodeUnknownEffect(StoredEventRow)(row).pipe(
    Effect.mapError(storeError("decode.row")),
    Effect.flatMap(({ record }) =>
      Effect.try({
        try: () => Schema.decodeUnknownSync(WorkGoalCheckpoint)(JSON.parse(record)),
        catch: storeError("decode.event")
      })
    )
  )

export interface WorkStoreService {
  readonly append: (
    event: WorkGoalCheckpointType
  ) => Effect.Effect<
    WorkGoalCheckpointType,
    WorkCheckpointConflictError | WorkProjectionError | WorkStoreError
  >
  readonly appendMany: (
    transactionId: string,
    events: ReadonlyArray<WorkGoalCheckpointType>
  ) => Effect.Effect<
    ReadonlyArray<WorkGoalCheckpointType>,
    | WorkCheckpointConflictError
    | WorkProjectionError
    | WorkTransactionConflictError
    | WorkStoreError
  >
  readonly claim: (
    claim: WorkLaneClaim
  ) => Effect.Effect<WorkLaneClaimed, WorkLaneClaimConflictError | WorkProjectionError | WorkStoreError>
  readonly currentClaim: (
    laneId: string
  ) => Effect.Effect<Option.Option<WorkLaneClaimed>, WorkStoreError>
  readonly decision: (
    handoff: WorkDecisionHandoff
  ) => Effect.Effect<
    WorkDecisionHandoff,
    WorkDecisionHandoffConflictError | WorkProjectionError | WorkStoreError
  >
  readonly decisions: (
    laneId: string
  ) => Effect.Effect<ReadonlyArray<WorkDecisionHandoff>, WorkStoreError>
  readonly list: () => Effect.Effect<ReadonlyArray<WorkGoalCheckpointType>, WorkStoreError>
}

export class WorkStore implements WorkStoreService {
  readonly #database: DatabaseSync
  readonly #cryptoService: Crypto.Crypto
  readonly #fileSystem: FileSystem.FileSystem
  readonly path: string

  private constructor(path: string, fileSystem: FileSystem.FileSystem, cryptoService: Crypto.Crypto) {
    this.path = path
    this.#fileSystem = fileSystem
    this.#cryptoService = cryptoService
    this.#database = new DatabaseSync(path)
    try {
      this.#database.exec(`
        PRAGMA busy_timeout = ${workStoreBusyTimeoutMillis};
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS work_goal_events (
          event_id TEXT PRIMARY KEY,
          goal_id TEXT NOT NULL,
          occurred_at INTEGER NOT NULL,
          record TEXT NOT NULL,
          UNIQUE (goal_id, occurred_at)
        );
        CREATE TABLE IF NOT EXISTS work_goal_transactions (
          transaction_id TEXT PRIMARY KEY,
          record TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS work_goal_transaction_totals (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          transaction_count INTEGER NOT NULL CHECK (transaction_count >= 0),
          transaction_bytes INTEGER NOT NULL CHECK (transaction_bytes >= 0)
        );
        CREATE TRIGGER IF NOT EXISTS work_goal_transactions_after_insert
        AFTER INSERT ON work_goal_transactions
        BEGIN
          UPDATE work_goal_transaction_totals
          SET transaction_count = transaction_count + 1,
              transaction_bytes = transaction_bytes +
                length(CAST(NEW.transaction_id AS BLOB)) + length(CAST(NEW.record AS BLOB))
          WHERE singleton = 1;
        END;
        CREATE TABLE IF NOT EXISTS work_lane_claims (
          lane_id TEXT PRIMARY KEY,
          revision INTEGER NOT NULL,
          record TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS work_decision_handoffs (
          handoff_id TEXT PRIMARY KEY,
          lane_id TEXT NOT NULL,
          occurred_at INTEGER NOT NULL,
          record TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS work_decision_totals (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          decision_count INTEGER NOT NULL CHECK (decision_count >= 0),
          decision_bytes INTEGER NOT NULL CHECK (decision_bytes >= 0)
        );
        CREATE TRIGGER IF NOT EXISTS work_decision_handoffs_after_insert
        AFTER INSERT ON work_decision_handoffs
        BEGIN
          UPDATE work_decision_totals
          SET decision_count = decision_count + 1,
              decision_bytes = decision_bytes +
                length(CAST(NEW.handoff_id AS BLOB)) + length(CAST(NEW.record AS BLOB))
          WHERE singleton = 1;
        END;
        CREATE INDEX IF NOT EXISTS work_decision_handoffs_lane_time
          ON work_decision_handoffs (lane_id, occurred_at, handoff_id);
      `)
      const columns = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ name: Schema.String })))(
        this.#database.prepare("PRAGMA table_info(work_goal_events)").all()
      )
      if (!columns.some(({ name }) => name === "transaction_id")) {
        this.#database.exec("ALTER TABLE work_goal_events ADD COLUMN transaction_id TEXT")
      }
      this.#database.exec(`
        INSERT OR IGNORE INTO work_goal_transaction_totals
          (singleton, transaction_count, transaction_bytes)
        SELECT 1, COUNT(*), COALESCE(SUM(
          length(CAST(transaction_id AS BLOB)) + length(CAST(record AS BLOB))
        ), 0)
        FROM work_goal_transactions
      `)
      this.#database.exec(`
        INSERT OR IGNORE INTO work_decision_totals
          (singleton, decision_count, decision_bytes)
        SELECT 1, COUNT(*), COALESCE(SUM(
          length(CAST(handoff_id AS BLOB)) + length(CAST(record AS BLOB))
        ), 0)
        FROM work_decision_handoffs
      `)
    } catch (error) {
      this.#database.close()
      throw error
    }
  }

  static readonly open = Effect.fn("WorkStore.open")(function*(path: string) {
    const cryptoService = yield* Crypto.Crypto
    const fileSystem = yield* FileSystem.FileSystem
    const paths = yield* Path.Path
    const directory = paths.dirname(path)
    const directoryExists = yield* fileSystem.exists(directory).pipe(
      Effect.mapError(storeError("open.directory.exists"))
    )
    yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 }).pipe(
      Effect.mapError(storeError("open.directory"))
    )
    if (!directoryExists) {
      yield* fileSystem.chmod(directory, 0o700).pipe(
        Effect.mapError(storeError("open.secureDirectory"))
      )
    }
    const store = yield* Effect.try({
      try: () => new WorkStore(path, fileSystem, cryptoService),
      catch: storeError("open.database")
    })
    yield* store.secureFiles()
    return store
  })

  readonly append = Effect.fn("WorkStore.append")(function*(
    this: WorkStore,
    event: WorkGoalCheckpointType
  ) {
    const decoded = yield* Schema.decodeUnknownEffect(WorkGoalCheckpoint)(event).pipe(
      Effect.mapError(storeError("append.decode"))
    )
    yield* this.secureFiles()
    const decision = yield* Effect.try({
      try: () => {
        let transaction = false
        try {
          this.#database.exec("BEGIN IMMEDIATE")
          transaction = true
          const reject = (error: AppendRejection): AppendDecision => {
            this.#database.exec("ROLLBACK")
            transaction = false
            return { _tag: "rejected", error }
          }
          const collisions = Schema.decodeUnknownSync(StoredEventRows)(
            this.#database
              .prepare(
                `SELECT record FROM work_goal_events
                 WHERE event_id = ? OR (goal_id = ? AND occurred_at = ?)`
              )
              .all(decoded.eventId, decoded.goal.id, decoded.occurredAt)
          ).map(({ record }) => Schema.decodeUnknownSync(WorkGoalCheckpoint)(JSON.parse(record)))
          if (collisions.length > 0) {
            if (collisions.every((existing) => Equal.equals(existing, decoded))) {
              this.#database.exec("ROLLBACK")
              transaction = false
              return { _tag: "replayed", event: decoded } satisfies AppendDecision
            }
            return reject(
              new WorkCheckpointConflictError({
                eventId: decoded.eventId,
                goalId: decoded.goal.id,
                occurredAt: decoded.occurredAt
              })
            )
          }
          const eventCount = Schema.decodeUnknownSync(CountRow)(
            this.#database.prepare("SELECT COUNT(*) AS count FROM work_goal_events").get()
          ).count
          if (eventCount >= workHistoryMaxEvents) {
            return reject(
              new WorkProjectionError({
                cause: decoded,
                detail: `work history cannot exceed ${workHistoryMaxEvents} checkpoints`,
                reason: "capacity_exceeded"
              })
            )
          }
          const history = Schema.decodeUnknownSync(StoredEventRows)(
            this.#database.prepare("SELECT record FROM work_goal_events").all()
          ).map(({ record }) => Schema.decodeUnknownSync(WorkGoalCheckpoint)(JSON.parse(record)))
          const familyError = validateGoalFamilyHistory([...history, decoded])
          if (familyError !== undefined) return reject(familyError)
          if (maximumSnapshotBytes(history, decoded) > fleetResponseBodyMaxBytes) {
            return reject(
              new WorkProjectionError({
                cause: decoded,
                detail: `work snapshots cannot exceed ${fleetResponseBodyMaxBytes} encoded bytes`,
                reason: "capacity_exceeded"
              })
            )
          }
          const firstGoalRow = this.#database.prepare(
            "SELECT record FROM work_goal_events WHERE goal_id = ? ORDER BY occurred_at ASC, event_id ASC LIMIT 1"
          ).get(decoded.goal.id)
          if (firstGoalRow === undefined) {
            if (decoded.occurredAt !== decoded.goal.createdAt) {
              return reject(
                new WorkProjectionError({
                  cause: decoded,
                  detail: `goal ${decoded.goal.id} must begin at its creation timestamp`,
                  reason: "inconsistent_history"
                })
              )
            }
            const goalCount = Schema.decodeUnknownSync(CountRow)(
              this.#database.prepare("SELECT COUNT(DISTINCT goal_id) AS count FROM work_goal_events").get()
            ).count
            if (goalCount >= workSnapshotMaxGoals) {
              return reject(
                new WorkProjectionError({
                  cause: decoded,
                  detail: `work snapshots cannot exceed ${workSnapshotMaxGoals} goals`,
                  reason: "capacity_exceeded"
                })
              )
            }
          } else {
            const firstGoal = Schema.decodeUnknownSync(WorkGoalCheckpoint)(
              JSON.parse(Schema.decodeUnknownSync(StoredEventRow)(firstGoalRow).record)
            )
            if (firstGoal.goal.createdAt !== decoded.goal.createdAt) {
              return reject(
                new WorkProjectionError({
                  cause: decoded,
                  detail: `goal ${decoded.goal.id} changed its creation timestamp`,
                  reason: "inconsistent_history"
                })
              )
            }
          }
          const result = this.#database.prepare(
            "INSERT INTO work_goal_events (event_id, goal_id, occurred_at, record) VALUES (?, ?, ?, ?)"
          ).run(decoded.eventId, decoded.goal.id, decoded.occurredAt, JSON.stringify(decoded))
          this.#database.exec("COMMIT")
          transaction = false
          return { _tag: "inserted", changes: result.changes } satisfies AppendDecision
        } catch (error) {
          if (transaction) this.#database.exec("ROLLBACK")
          throw error
        }
      },
      catch: storeError("append.insert")
    })
    if (decision._tag === "rejected") return yield* decision.error
    if (decision._tag === "replayed") return decision.event
    if (decision.changes !== 1 && decision.changes !== 1n) {
      return yield* storeError("append.insert.count")(decision.changes)
    }
    return decoded
  })

  readonly appendMany = Effect.fn("WorkStore.appendMany")(function*(
    this: WorkStore,
    transactionId: string,
    events: ReadonlyArray<WorkGoalCheckpointType>
  ) {
    if (events.length > workHistoryMaxEvents) {
      return yield* new WorkProjectionError({
        cause: events.length,
        detail: `work history cannot exceed ${workHistoryMaxEvents} checkpoints`,
        reason: "capacity_exceeded"
      })
    }
    const transaction = yield* Schema.decodeUnknownEffect(TransactionId)(transactionId).pipe(
      Effect.mapError(storeError("appendMany.decode.transaction"))
    )
    const decoded = yield* Effect.forEach(events, (event) =>
      Schema.decodeUnknownEffect(WorkGoalCheckpoint)(event).pipe(
        Effect.mapError(storeError("appendMany.decode.event"))
      ))
    if (decoded.length === 0) {
      return yield* new WorkProjectionError({
        cause: events,
        detail: "a checkpoint transaction must contain at least one event",
        reason: "malformed"
      })
    }
    const digest = yield* this.#cryptoService.digest(
      "SHA-256",
      new TextEncoder().encode(transactionContent(decoded))
    ).pipe(
      Effect.mapError(storeError("appendMany.digest")),
      Effect.map(Encoding.encodeHex)
    )
    const transactionRecord = JSON.stringify({ digest, version: "herdr.work.transaction.v3" })
    const transactionEntryBytes = utf8.encode(transaction).byteLength + utf8.encode(transactionRecord).byteLength
    yield* this.secureFiles()
    const decision = yield* Effect.try({
      try: () => {
        let inTransaction = false
        try {
          this.#database.exec("BEGIN IMMEDIATE")
          inTransaction = true
          const storedTransaction = this.#database.prepare(
            "SELECT record FROM work_goal_transactions WHERE transaction_id = ?"
          ).get(transaction)
          let compactTransaction: typeof CompactTransactionRecord.Type | undefined
          let legacyCompactTransaction: typeof LegacyCompactTransactionRecord.Type | undefined
          let unsupportedCompactTransaction = false
          let legacyTransaction: ReadonlyArray<WorkGoalCheckpointType> | undefined
          if (storedTransaction !== undefined) {
            const stored = Schema.decodeUnknownSync(TransactionRow)(storedTransaction)
            const previous = JSON.parse(stored.record)
            const compact = Schema.decodeUnknownResult(CompactTransactionRecord)(previous)
            if (compact._tag === "Success") {
              compactTransaction = compact.success
            } else {
              const legacyCompact = Schema.decodeUnknownResult(LegacyCompactTransactionRecord)(previous)
              if (legacyCompact._tag === "Success") {
                legacyCompactTransaction = legacyCompact.success
                unsupportedCompactTransaction = true
              } else {
                const previousCompact = Schema.decodeUnknownResult(PreviousCompactTransactionRecord)(previous)
                if (previousCompact._tag === "Success") {
                  unsupportedCompactTransaction = true
                } else {
                  legacyTransaction = Schema.decodeUnknownSync(Schema.Array(WorkGoalCheckpoint))(previous)
                }
              }
            }
          }

          const duplicateEventIds = new Set<string>()
          const duplicateGoalTimes = new Set<string>()
          for (const event of decoded) {
            const goalTime = `${event.goal.id}\u0000${event.occurredAt}`
            if (duplicateEventIds.has(event.eventId) || duplicateGoalTimes.has(goalTime)) {
              this.#database.exec("ROLLBACK")
              inTransaction = false
              return {
                _tag: "rejected",
                error: new WorkProjectionError({
                  cause: event,
                  detail: "a checkpoint transaction contains a duplicate event identity",
                  reason: "duplicate_event"
                })
              } satisfies AppendManyDecision
            }
            duplicateEventIds.add(event.eventId)
            duplicateGoalTimes.add(goalTime)
          }

          const rows = Schema.decodeUnknownSync(StoredEventWithTransactionRows)(
            this.#database.prepare(
              `SELECT event_id AS eventId, goal_id AS goalId, occurred_at AS occurredAt,
                record, transaction_id AS transactionId
               FROM work_goal_events`
            ).all()
          )
          const rowsByEventId = new Map(rows.map((row) => [row.eventId, row]))
          const rowsByGoalTime = new Map(rows.map((row) => [
            JSON.stringify([row.goalId, row.occurredAt]),
            row
          ]))
          const decodedRows = rows.map((row) => ({
            event: Schema.decodeUnknownSync(WorkGoalCheckpoint)(JSON.parse(row.record)),
            row
          }))
          const decodedEventsByEventId = new Map(decodedRows.map(({ event, row }) => [row.eventId, event]))
          if (legacyTransaction !== undefined) {
            const legacyRows = legacyTransaction.map((event) => rowsByEventId.get(event.eventId))
            if (
              legacyRows.some((row, index) => {
                const event = legacyTransaction[index]
                return row === undefined ||
                  event === undefined ||
                  row.goalId !== event.goal.id ||
                  row.occurredAt !== event.occurredAt
              })
            ) {
              this.#database.exec("ROLLBACK")
              inTransaction = false
              return {
                _tag: "rejected",
                error: new WorkTransactionConflictError({ transactionId: transaction })
              } satisfies AppendManyDecision
            }
            const legacyEvents = legacyRows.map((row) =>
              row === undefined
                ? undefined
                : Schema.decodeUnknownSync(WorkGoalCheckpoint)(JSON.parse(row.record))
            )
            if (
              legacyEvents.some((event) => event === undefined) ||
              legacyEvents.some((event, index) => event !== undefined && !Equal.equals(event, legacyTransaction[index]))
            ) {
              this.#database.exec("ROLLBACK")
              inTransaction = false
              return {
                _tag: "rejected",
                error: new WorkTransactionConflictError({ transactionId: transaction })
              } satisfies AppendManyDecision
            }
          }
          const existing = decoded.map((event) => {
            const row = rowsByEventId.get(event.eventId) ??
              rowsByGoalTime.get(JSON.stringify([event.goal.id, event.occurredAt]))
            return row === undefined
              ? undefined
              : decodedEventsByEventId.get(row.eventId)
          })
          const conflicting = existing.find(
            (candidate, index) => candidate !== undefined && !Equal.equals(candidate, decoded[index])
          )
          if (conflicting !== undefined) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            const index = existing.findIndex((candidate) => candidate === conflicting)
            const event = decoded[index]
            if (event === undefined) {
              return {
                _tag: "rejected",
                error: new WorkStoreError({
                  cause: decoded,
                  operation: "appendMany.collision-candidate"
                })
              } satisfies AppendManyDecision
            }
            return {
              _tag: "rejected",
              error: new WorkCheckpointConflictError({
                eventId: event.eventId,
                goalId: event.goal.id,
                occurredAt: event.occurredAt
              })
            } satisfies AppendManyDecision
          }
          if (compactTransaction !== undefined) {
            const denormalizedMismatch = decoded.some((event) => {
              const row = rowsByEventId.get(event.eventId) ??
                rowsByGoalTime.get(JSON.stringify([event.goal.id, event.occurredAt]))
              return row === undefined ||
                row.eventId !== event.eventId ||
                row.goalId !== event.goal.id ||
                row.occurredAt !== event.occurredAt
            })
            if (denormalizedMismatch) {
              this.#database.exec("ROLLBACK")
              inTransaction = false
              return {
                _tag: "rejected",
                error: new WorkTransactionConflictError({ transactionId: transaction })
              } satisfies AppendManyDecision
            }
          }
          if (legacyCompactTransaction !== undefined) {
            const denormalizedMismatch = legacyCompactTransaction.events.some((identity, index) => {
              const event = decoded[index]
              const row = rowsByEventId.get(identity.eventId)
              return row === undefined ||
                event === undefined ||
                row.goalId !== event.goal.id ||
                row.occurredAt !== event.occurredAt
            })
            if (denormalizedMismatch) {
              this.#database.exec("ROLLBACK")
              inTransaction = false
              return {
                _tag: "rejected",
                error: new WorkTransactionConflictError({ transactionId: transaction })
              } satisfies AppendManyDecision
            }
          }
          const corruptedRow = decodedRows.find(({ event, row }) =>
            row.eventId !== event.eventId || row.goalId !== event.goal.id || row.occurredAt !== event.occurredAt
          )
          if (corruptedRow !== undefined) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "rejected",
              error: new WorkTransactionConflictError({ transactionId: transaction })
            } satisfies AppendManyDecision
          }
          if (unsupportedCompactTransaction) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "rejected",
              error: new WorkTransactionConflictError({ transactionId: transaction })
            } satisfies AppendManyDecision
          }
          if (legacyTransaction !== undefined && !Equal.equals(legacyTransaction, decoded)) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "rejected",
              error: new WorkTransactionConflictError({ transactionId: transaction })
            } satisfies AppendManyDecision
          }
          const newEvents = decoded.filter((_, index) => existing[index] === undefined)
          if (
            compactTransaction !== undefined &&
            newEvents.length !== 0
          ) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "rejected",
              error: new WorkTransactionConflictError({ transactionId: transaction })
            } satisfies AppendManyDecision
          }
          if (newEvents.length !== 0 && existing.some((candidate) => candidate !== undefined)) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            const event = decoded.find((candidate, index) => existing[index] !== undefined)
            if (event === undefined) {
              return {
                _tag: "rejected",
                error: new WorkStoreError({
                  cause: decoded,
                  operation: "appendMany.partial-replay-candidate"
                })
              } satisfies AppendManyDecision
            }
            return {
              _tag: "rejected",
              error: new WorkCheckpointConflictError({
                eventId: event.eventId,
                goalId: event.goal.id,
                occurredAt: event.occurredAt
              })
            } satisfies AppendManyDecision
          }
          if (newEvents.length === 0) {
            if (compactTransaction !== undefined) {
              if (compactTransaction.digest !== digest) {
                this.#database.exec("ROLLBACK")
                inTransaction = false
                return {
                  _tag: "rejected",
                  error: new WorkTransactionConflictError({ transactionId: transaction })
                } satisfies AppendManyDecision
              }
              this.#database.exec("ROLLBACK")
              inTransaction = false
              return { _tag: "replayed", events: decoded } satisfies AppendManyDecision
            }
            if (legacyTransaction !== undefined) {
              this.#database.exec("ROLLBACK")
              inTransaction = false
              return { _tag: "replayed", events: decoded } satisfies AppendManyDecision
            }
            const transactionLedgerTotals = readTransactionLedgerTotals(this.#database)
            if (transactionLedgerTotals.transactionCount >= workTransactionMaxRecords) {
              this.#database.exec("ROLLBACK")
              inTransaction = false
              return {
                _tag: "rejected",
                error: new WorkProjectionError({
                  cause: decoded,
                  detail: `work transaction history cannot exceed ${workTransactionMaxRecords} transaction IDs`,
                  reason: "capacity_exceeded"
                })
              } satisfies AppendManyDecision
            }
            if (transactionLedgerTotals.transactionBytes + transactionEntryBytes > workTransactionMaxBytes) {
              this.#database.exec("ROLLBACK")
              inTransaction = false
              return {
                _tag: "rejected",
                error: new WorkProjectionError({
                  cause: decoded,
                  detail: `work transaction history cannot exceed ${workTransactionMaxBytes} encoded bytes`,
                  reason: "capacity_exceeded"
                })
              } satisfies AppendManyDecision
            }
            this.#database.prepare(
              "INSERT INTO work_goal_transactions (transaction_id, record) VALUES (?, ?)"
            ).run(
              transaction,
              transactionRecord
            )
            this.#database.exec("COMMIT")
            inTransaction = false
            return { _tag: "replayed", events: decoded } satisfies AppendManyDecision
          }
          const eventCount = Schema.decodeUnknownSync(CountRow)(
            this.#database.prepare("SELECT COUNT(*) AS count FROM work_goal_events").get()
          ).count
          if (eventCount + newEvents.length > workHistoryMaxEvents) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "rejected",
              error: new WorkProjectionError({
                cause: decoded,
                detail: `work history cannot exceed ${workHistoryMaxEvents} checkpoints`,
                reason: "capacity_exceeded"
              })
            } satisfies AppendManyDecision
          }
          const history = decodedRows.map(({ event }) => event)
          const prospective = [...history, ...newEvents].toSorted((left, right) =>
            left.occurredAt - right.occurredAt || left.eventId.localeCompare(right.eventId)
          )
          const familyError = validateGoalFamilyHistory(prospective)
          if (familyError !== undefined) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return { _tag: "rejected", error: familyError } satisfies AppendManyDecision
          }
          const snapshotBytes = makeSnapshotByteAccumulator(history)
          for (const event of newEvents) {
            if (snapshotBytes.add(event) > fleetResponseBodyMaxBytes) {
              this.#database.exec("ROLLBACK")
              inTransaction = false
              return {
                _tag: "rejected",
                error: new WorkProjectionError({
                  cause: event,
                  detail: `work snapshots cannot exceed ${fleetResponseBodyMaxBytes} encoded bytes`,
                  reason: "capacity_exceeded"
                })
              } satisfies AppendManyDecision
            }
          }
          const goalIds = new Set(history.map(({ goal }) => goal.id))
          for (const event of newEvents) goalIds.add(event.goal.id)
          if (goalIds.size > workSnapshotMaxGoals) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "rejected",
              error: new WorkProjectionError({
                cause: decoded,
                detail: `work snapshots cannot exceed ${workSnapshotMaxGoals} goals`,
                reason: "capacity_exceeded"
              })
            } satisfies AppendManyDecision
          }
          const creationTimes = new Map<string, number>()
          for (const event of prospective) {
            const creationTime = creationTimes.get(event.goal.id)
            if (creationTime === undefined) {
              if (event.occurredAt !== event.goal.createdAt) {
                this.#database.exec("ROLLBACK")
                inTransaction = false
                return {
                  _tag: "rejected",
                  error: new WorkProjectionError({
                    cause: event,
                    detail: `goal ${event.goal.id} must begin at its creation timestamp`,
                    reason: "inconsistent_history"
                  })
                } satisfies AppendManyDecision
              }
              creationTimes.set(event.goal.id, event.goal.createdAt)
            } else if (creationTime !== event.goal.createdAt) {
              this.#database.exec("ROLLBACK")
              inTransaction = false
              return {
                _tag: "rejected",
                error: new WorkProjectionError({
                  cause: event,
                  detail: `goal ${event.goal.id} changed its creation timestamp`,
                  reason: "inconsistent_history"
                })
              } satisfies AppendManyDecision
            }
          }
          const transactionLedgerTotals = readTransactionLedgerTotals(this.#database)
          if (transactionLedgerTotals.transactionCount >= workTransactionMaxRecords) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "rejected",
              error: new WorkProjectionError({
                cause: decoded,
                detail: `work transaction history cannot exceed ${workTransactionMaxRecords} transaction IDs`,
                reason: "capacity_exceeded"
              })
            } satisfies AppendManyDecision
          }
          if (transactionLedgerTotals.transactionBytes + transactionEntryBytes > workTransactionMaxBytes) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "rejected",
              error: new WorkProjectionError({
                cause: decoded,
                detail: `work transaction history cannot exceed ${workTransactionMaxBytes} encoded bytes`,
                reason: "capacity_exceeded"
              })
            } satisfies AppendManyDecision
          }
          const insert = this.#database.prepare(
            `INSERT INTO work_goal_events
              (event_id, goal_id, occurred_at, record, transaction_id)
             VALUES (?, ?, ?, ?, ?)`
          )
          for (const event of newEvents) {
            insert.run(event.eventId, event.goal.id, event.occurredAt, JSON.stringify(event), transaction)
          }
          this.#database.prepare(
            "INSERT INTO work_goal_transactions (transaction_id, record) VALUES (?, ?)"
          ).run(transaction, transactionRecord)
          this.#database.exec("COMMIT")
          inTransaction = false
          return { _tag: "inserted", events: decoded } satisfies AppendManyDecision
        } catch (error) {
          if (inTransaction) this.#database.exec("ROLLBACK")
          throw error
        }
      },
      catch: storeError("appendMany.insert")
    })
    if (decision._tag === "rejected") return yield* decision.error
    return decision.events
  })

  readonly claim = Effect.fn("WorkStore.claim")(function*(
    this: WorkStore,
    claim: WorkLaneClaim
  ) {
    const decoded = yield* Schema.decodeUnknownEffect(WorkLaneClaim)(claim).pipe(
      Effect.mapError(storeError("claim.decode"))
    )
    yield* this.secureFiles()
    const decision = yield* Effect.try({
      try: () => {
        let inTransaction = false
        try {
          this.#database.exec("BEGIN IMMEDIATE")
          inTransaction = true
          const raw = this.#database.prepare(
            "SELECT revision, record FROM work_lane_claims WHERE lane_id = ?"
          ).get(decoded.laneId)
          const existing = raw === undefined ? undefined : Schema.decodeUnknownSync(LaneRow)(raw)
          const existingClaim = existing === undefined
            ? undefined
            : Schema.decodeUnknownSync(WorkLaneClaimed)(JSON.parse(existing.record))
          if (
            existing !== undefined &&
            (existingClaim === undefined ||
              existingClaim.laneId !== decoded.laneId ||
              existingClaim.revision !== existing.revision)
          ) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "rejected",
              error: new WorkStoreError({
                cause: { laneId: decoded.laneId, record: existing.record, revision: existing.revision },
                operation: "claim.write.inconsistent"
              })
            } satisfies ClaimDecision
          }
          const actualRevision = existing?.revision ?? 0
          if (actualRevision !== decoded.expectedRevision) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "conflict",
              error: new WorkLaneClaimConflictError({
                actualRevision,
                expectedRevision: decoded.expectedRevision,
                laneId: decoded.laneId
              })
            } satisfies ClaimDecision
          }
          if (actualRevision >= Number.MAX_SAFE_INTEGER) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "rejected",
              error: new WorkProjectionError({
                cause: decoded,
                detail: "work lane claim revision cannot exceed Number.MAX_SAFE_INTEGER",
                reason: "capacity_exceeded"
              })
            } satisfies ClaimDecision
          }
          const revision = actualRevision + 1
          const result: WorkLaneClaimed = { ...decoded, revision }
          const encodedRecord = JSON.stringify(result)
          const entryBytes = utf8.encode(decoded.laneId).byteLength + utf8.encode(encodedRecord).byteLength
          const existingEntryBytes = existing === undefined
            ? 0
            : utf8.encode(decoded.laneId).byteLength + utf8.encode(existing.record).byteLength
          const claimCount = Schema.decodeUnknownSync(CountRow)(
            this.#database.prepare("SELECT COUNT(*) AS count FROM work_lane_claims").get()
          ).count
          if (existing === undefined && claimCount >= workLaneMaxRecords) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "rejected",
              error: new WorkProjectionError({
                cause: decoded,
                detail: `work lane claims cannot exceed ${workLaneMaxRecords} lanes`,
                reason: "capacity_exceeded"
              })
            } satisfies ClaimDecision
          }
          const claimBytes = Schema.decodeUnknownSync(LedgerBytesRow)(
            this.#database.prepare(
              `SELECT COALESCE(SUM(length(CAST(lane_id AS BLOB)) + length(CAST(record AS BLOB))), 0) AS bytes
               FROM work_lane_claims`
            ).get()
          ).bytes
          if (claimBytes - existingEntryBytes + entryBytes > workLaneMaxBytes) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "rejected",
              error: new WorkProjectionError({
                cause: decoded,
                detail: `work lane claims cannot exceed ${workLaneMaxBytes} encoded bytes`,
                reason: "capacity_exceeded"
              })
            } satisfies ClaimDecision
          }
          const changes = existing === undefined
            ? this.#database.prepare(
              "INSERT INTO work_lane_claims (lane_id, revision, record) VALUES (?, ?, ?)"
            ).run(decoded.laneId, revision, encodedRecord).changes
            : this.#database.prepare(
              "UPDATE work_lane_claims SET revision = ?, record = ? WHERE lane_id = ? AND revision = ?"
            ).run(revision, encodedRecord, decoded.laneId, decoded.expectedRevision).changes
          if (changes !== 1 && changes !== 1n) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "conflict",
              error: new WorkLaneClaimConflictError({
                actualRevision,
                expectedRevision: decoded.expectedRevision,
                laneId: decoded.laneId
              })
            } satisfies ClaimDecision
          }
          this.#database.exec("COMMIT")
          inTransaction = false
          return { _tag: "claimed", value: result } satisfies ClaimDecision
        } catch (error) {
          if (inTransaction) this.#database.exec("ROLLBACK")
          throw error
        }
      },
      catch: storeError("claim.write")
    })
    if (decision._tag === "conflict" || decision._tag === "rejected") return yield* decision.error
    return decision.value
  })

  readonly decision = Effect.fn("WorkStore.decision")(function*(
    this: WorkStore,
    handoff: WorkDecisionHandoff
  ) {
    const decoded = yield* Schema.decodeUnknownEffect(WorkDecisionHandoff)(handoff).pipe(
      Effect.mapError(storeError("decision.decode"))
    )
    yield* this.secureFiles()
    const encodedHandoff = JSON.stringify(decoded)
    const handoffEntryBytes = utf8.encode(decoded.id).byteLength + utf8.encode(encodedHandoff).byteLength
    const result = yield* Effect.try({
      try: () => {
        let inTransaction = false
        try {
          this.#database.exec("BEGIN IMMEDIATE")
          inTransaction = true
          const raw = this.#database.prepare(
            `SELECT handoff_id AS handoffId, lane_id AS laneId, occurred_at AS occurredAt, record
             FROM work_decision_handoffs WHERE handoff_id = ?`
          ).get(decoded.id)
          if (raw !== undefined) {
            const previous = Schema.decodeUnknownSync(DecisionRow)(raw)
            const prior = Schema.decodeUnknownSync(WorkDecisionHandoff)(JSON.parse(previous.record))
            this.#database.exec("ROLLBACK")
            inTransaction = false
            if (
              previous.handoffId !== prior.id ||
              previous.laneId !== prior.laneId ||
              previous.occurredAt !== prior.occurredAt
            ) {
              return {
                _tag: "rejected",
                error: new WorkStoreError({
                  cause: { row: previous, record: prior },
                  operation: "decision.decode.identity-mismatch"
                })
              } satisfies HandoffDecision
            }
            if (Equal.equals(prior, decoded)) return { _tag: "replayed", value: decoded } satisfies HandoffDecision
            return {
              _tag: "conflict",
              error: new WorkDecisionHandoffConflictError({ handoffId: decoded.id })
            } satisfies HandoffDecision
          }
          const decisionLedgerTotals = readDecisionLedgerTotals(this.#database)
          if (decisionLedgerTotals.decisionCount >= workDecisionMaxRecords) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "rejected",
              error: new WorkProjectionError({
                cause: decoded,
                detail: `work decision history cannot exceed ${workDecisionMaxRecords} handoffs`,
                reason: "capacity_exceeded"
              })
            } satisfies HandoffDecision
          }
          if (decisionLedgerTotals.decisionBytes + handoffEntryBytes > workDecisionMaxBytes) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "rejected",
              error: new WorkProjectionError({
                cause: decoded,
                detail: `work decision history cannot exceed ${workDecisionMaxBytes} encoded bytes`,
                reason: "capacity_exceeded"
              })
            } satisfies HandoffDecision
          }
          this.#database.prepare(
            "INSERT INTO work_decision_handoffs (handoff_id, lane_id, occurred_at, record) VALUES (?, ?, ?, ?)"
          ).run(decoded.id, decoded.laneId, decoded.occurredAt, encodedHandoff)
          this.#database.exec("COMMIT")
          inTransaction = false
          return { _tag: "inserted", value: decoded } satisfies HandoffDecision
        } catch (error) {
          if (inTransaction) this.#database.exec("ROLLBACK")
          throw error
        }
      },
      catch: storeError("decision.write")
    })
    if (result._tag === "conflict" || result._tag === "rejected") return yield* result.error
    return result.value
  })

  readonly currentClaim = Effect.fn("WorkStore.currentClaim")(function*(
    this: WorkStore,
    laneId: string
  ) {
    const decodedLaneId = yield* Schema.decodeUnknownEffect(WorkGoalId)(laneId).pipe(
      Effect.mapError(storeError("claim.read.decode-lane-id"))
    )
    const raw = yield* Effect.try({
      try: () =>
        this.#database.prepare(
          "SELECT revision, record FROM work_lane_claims WHERE lane_id = ?"
        ).get(decodedLaneId),
      catch: storeError("claim.read")
    })
    if (raw === undefined) return Option.none<WorkLaneClaimed>()
    const row = yield* Schema.decodeUnknownEffect(LaneRow)(raw).pipe(
      Effect.mapError(storeError("claim.read.decode-row"))
    )
    const claimed = yield* Effect.try({
      try: () => JSON.parse(row.record),
      catch: storeError("claim.read.parse")
    }).pipe(
      Effect.flatMap((value) => Schema.decodeUnknownEffect(WorkLaneClaimed)(value)),
      Effect.mapError(storeError("claim.read.decode"))
    )
    if (claimed.revision !== row.revision) {
      return yield* new WorkStoreError({
        cause: { laneId: decodedLaneId, rowRevision: row.revision, recordRevision: claimed.revision },
        operation: "claim.read.revision-mismatch"
      })
    }
    if (claimed.laneId !== decodedLaneId) {
      return yield* new WorkStoreError({
        cause: { requestedLaneId: decodedLaneId, recordLaneId: claimed.laneId },
        operation: "claim.read.lane-mismatch"
      })
    }
    return Option.some(claimed)
  })

  readonly decisions = Effect.fn("WorkStore.decisions")(function*(this: WorkStore, laneId: string) {
    const decodedLaneId = yield* Schema.decodeUnknownEffect(WorkGoalId)(laneId).pipe(
      Effect.mapError(storeError("decisions.list.decode-lane-id"))
    )
    const rows = yield* Effect.try({
      try: () =>
        this.#database.prepare(
          `SELECT handoff_id AS handoffId, lane_id AS laneId, occurred_at AS occurredAt, record
           FROM work_decision_handoffs
           WHERE lane_id = ? ORDER BY occurred_at ASC, handoff_id ASC`
        ).all(decodedLaneId),
      catch: storeError("decisions.list")
    })
    return yield* Effect.forEach(rows, (row) =>
      Schema.decodeUnknownEffect(DecisionRow)(row).pipe(
        Effect.mapError(storeError("decisions.decode-row")),
        Effect.flatMap((row) =>
          Effect.try({
            try: () => Schema.decodeUnknownSync(WorkDecisionHandoff)(JSON.parse(row.record)),
            catch: storeError("decisions.decode")
          })
            .pipe(
              Effect.flatMap((handoff) =>
                handoff.laneId !== decodedLaneId
                  ? Effect.fail(
                    new WorkStoreError({
                      cause: { requestedLaneId: decodedLaneId, recordLaneId: handoff.laneId },
                      operation: "decisions.decode.lane-mismatch"
                    })
                  )
                  : handoff.laneId !== row.laneId ||
                      handoff.id !== row.handoffId ||
                      handoff.occurredAt !== row.occurredAt
                  ? Effect.fail(
                    new WorkStoreError({
                      cause: {
                        record: handoff,
                        row: {
                          handoffId: row.handoffId,
                          laneId: row.laneId,
                          occurredAt: row.occurredAt
                        }
                      },
                      operation: "decisions.decode.identity-mismatch"
                    })
                  )
                  : Effect.succeed(handoff)
              )
            )
        )
      ))
  })

  readonly list = Effect.fn("WorkStore.list")(function*(this: WorkStore) {
    const rows = yield* Effect.try({
      try: () =>
        this.#database.prepare(
          "SELECT record FROM work_goal_events ORDER BY occurred_at ASC, event_id ASC"
        ).all(),
      catch: storeError("list")
    })
    return yield* Effect.forEach(rows, decodeRow)
  })

  private secureFiles() {
    const files = [this.path, `${this.path}-wal`, `${this.path}-shm`]
    return Effect.forEach(
      files,
      (path) =>
        this.#fileSystem.exists(path).pipe(
          Effect.mapError(storeError("secure.exists")),
          Effect.flatMap((exists) =>
            exists
              ? this.#fileSystem.chmod(path, 0o600).pipe(Effect.mapError(storeError("secure.chmod")))
              : Effect.void
          )
        ),
      { discard: true }
    )
  }

  close(): void {
    this.#database.close()
  }
}
