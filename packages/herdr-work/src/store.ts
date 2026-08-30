import { Effect, FileSystem, Path, Schema } from "effect"
import { DatabaseSync, type SQLOutputValue } from "node:sqlite"
import { WorkCheckpointConflictError, WorkStoreError } from "./errors.js"
import { WorkGoalCheckpoint, type WorkGoalCheckpoint as WorkGoalCheckpointType } from "./model.js"

const StoredEventRow = Schema.Struct({ record: Schema.String })
const storeError = (operation: string) => (cause: unknown) => new WorkStoreError({ cause, operation })

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
  ) => Effect.Effect<WorkGoalCheckpointType, WorkCheckpointConflictError | WorkStoreError>
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
    yield* fileSystem.makeDirectory(paths.dirname(path), { recursive: true, mode: 0o700 }).pipe(
      Effect.mapError(storeError("open.directory"))
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
      try: () =>
        this.#database.prepare(
          "INSERT OR IGNORE INTO work_goal_events (event_id, goal_id, occurred_at, record) VALUES (?, ?, ?, ?)"
        ).run(decoded.eventId, decoded.goal.id, decoded.occurredAt, JSON.stringify(decoded)),
      catch: storeError("append.insert")
    })
    if (inserted.changes === 0) {
      return yield* new WorkCheckpointConflictError({
        eventId: decoded.eventId,
        goalId: decoded.goal.id,
        occurredAt: decoded.occurredAt
      })
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
