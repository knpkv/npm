import { Effect, FileSystem, Path, Schema } from "effect"
import { DatabaseSync, type SQLOutputValue } from "node:sqlite"
import { WorkCheckpointConflictError, WorkProjectionError, WorkStoreError } from "./errors.js"
import {
  WorkGoalCheckpoint,
  type WorkGoalCheckpoint as WorkGoalCheckpointType,
  workHistoryMaxEvents,
  workSnapshotMaxGoals
} from "./model.js"

const StoredEventRow = Schema.Struct({ record: Schema.String })
const CountRow = Schema.Struct({ count: Schema.Number })
const storeError = (operation: string) => (cause: unknown) => new WorkStoreError({ cause, operation })
type AppendRejection = WorkCheckpointConflictError | WorkProjectionError
type AppendDecision =
  | { readonly _tag: "inserted"; readonly changes: bigint | number }
  | { readonly _tag: "rejected"; readonly error: AppendRejection }

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
    const inserted = yield* Effect.try({
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
          const duplicate = this.#database.prepare(
            `SELECT 1 FROM work_goal_events
             WHERE event_id = ? OR (goal_id = ? AND occurred_at = ?)
             LIMIT 1`
          ).get(decoded.eventId, decoded.goal.id, decoded.occurredAt)
          if (duplicate !== undefined) {
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
    if (inserted._tag === "rejected") return yield* inserted.error
    if (inserted.changes !== 1 && inserted.changes !== 1n) {
      return yield* storeError("append.insert.count")(inserted.changes)
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
