import { fleetResponseBodyMaxBytes } from "@knpkv/herdr-fleet"
import { Effect, Equal, FileSystem, Path, Schema } from "effect"
import { DatabaseSync, type SQLOutputValue } from "node:sqlite"
import { WorkCheckpointConflictError, WorkProjectionError, WorkStoreError } from "./errors.js"
import { validateGoalFamilyHistory } from "./goal-family.js"
import {
  WorkGoalCheckpoint,
  type WorkGoalCheckpoint as WorkGoalCheckpointType,
  workHistoryMaxEvents,
  workSnapshotMaxGoals
} from "./model.js"

const StoredEventRow = Schema.Struct({ record: Schema.String })
const StoredEventRows = Schema.Array(StoredEventRow)
const CountRow = Schema.Struct({ count: Schema.Number })
const storeError = (operation: string) => (cause: unknown) => new WorkStoreError({ cause, operation })
type AppendRejection = WorkCheckpointConflictError | WorkProjectionError
type AppendDecision =
  | { readonly _tag: "inserted"; readonly changes: bigint | number }
  | { readonly _tag: "replayed"; readonly event: WorkGoalCheckpointType }
  | { readonly _tag: "rejected"; readonly error: AppendRejection }

const utf8 = new TextEncoder()
const encodedBytes = (value: typeof Schema.Json.Type): number => utf8.encode(JSON.stringify(value)).byteLength
const maximumTimestamp = 8_640_000_000_000_000
const workSnapshotEnvelopeMaxBytes = encodedBytes({
  observedAt: maximumTimestamp,
  now: { window: "now", observedAt: maximumTimestamp, asOf: maximumTimestamp, goals: [], families: [] },
  day: { window: "day", observedAt: maximumTimestamp, asOf: maximumTimestamp, goals: [], families: [] },
  week: { window: "week", observedAt: maximumTimestamp, asOf: maximumTimestamp, goals: [], families: [] },
  month: { window: "month", observedAt: maximumTimestamp, asOf: maximumTimestamp, goals: [], families: [] }
})

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
  readonly list: () => Effect.Effect<ReadonlyArray<WorkGoalCheckpointType>, WorkStoreError>
}

export class WorkStore implements WorkStoreService {
  readonly #database: DatabaseSync
  readonly #fileSystem: FileSystem.FileSystem
  readonly path: string

  private constructor(path: string, fileSystem: FileSystem.FileSystem) {
    this.path = path
    this.#fileSystem = fileSystem
    this.#database = new DatabaseSync(path)
    try {
      this.#database.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS work_goal_events (
          event_id TEXT PRIMARY KEY,
          goal_id TEXT NOT NULL,
          occurred_at INTEGER NOT NULL,
          record TEXT NOT NULL,
          UNIQUE (goal_id, occurred_at)
        );
      `)
    } catch (error) {
      this.#database.close()
      throw error
    }
  }

  static readonly open = Effect.fn("WorkStore.open")(function*(path: string) {
    const fileSystem = yield* FileSystem.FileSystem
    const paths = yield* Path.Path
    const directory = paths.dirname(path)
    yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 }).pipe(
      Effect.mapError(storeError("open.directory"))
    )
    yield* fileSystem.chmod(directory, 0o700).pipe(
      Effect.mapError(storeError("open.secureDirectory"))
    )
    const store = yield* Effect.try({
      try: () => new WorkStore(path, fileSystem),
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
    yield* this.secureFiles()
    return decoded
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
