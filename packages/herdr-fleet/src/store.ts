import { Effect, FileSystem, Path, Schema } from "effect"
import { DatabaseSync, type SQLOutputValue } from "node:sqlite"
import { FleetJobConflictError, FleetStoreError, FleetTransitionConflictError } from "./errors.js"
import { JobRecord } from "./model.js"

const storeError = (operation: string) => (cause: unknown) =>
  new FleetStoreError({ operation, detail: String(cause), cause })

const decodeRecord = (text: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(JobRecord)(JSON.parse(text)),
    catch: storeError("decode")
  })

const encodeRecord = (record: JobRecord) => JSON.stringify(Schema.encodeSync(JobRecord)(record))

const decodeRows = (
  operation: "list" | "listPending" | "listRecoverable" | "listWorkers",
  rows: ReadonlyArray<Record<string, SQLOutputValue>>
) =>
  Effect.forEach(rows, (row) =>
    Schema.decodeUnknownEffect(Schema.Struct({ record: Schema.String }))(row).pipe(
      Effect.mapError(storeError(operation)),
      Effect.flatMap(({ record }) => decodeRecord(record))
    ))

export class JobStore {
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
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          record TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS jobs_record_status_idx ON jobs (
          CASE
            WHEN json_valid(record)
            THEN json_extract(record, '$.status')
          END
        );
      `)
    } catch (error) {
      this.#database.close()
      throw error
    }
  }

  static readonly open = Effect.fn("JobStore.open")(function*(path: string) {
    const fileSystem = yield* FileSystem.FileSystem
    const paths = yield* Path.Path
    const directory = paths.dirname(path)
    yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 }).pipe(
      Effect.mapError(storeError("open.makeDirectory"))
    )
    const store = yield* Effect.try({
      try: () => new JobStore(path, fileSystem),
      catch: storeError("open.database")
    })
    yield* store.secureFiles()
    return store
  })

  readonly put = Effect.fn("JobStore.put")(function*(
    this: JobStore,
    record: JobRecord
  ) {
    const database = this.#database
    const inserted = yield* Effect.try({
      try: () =>
        database
          .prepare("INSERT OR IGNORE INTO jobs (id, created_at, record) VALUES (?, ?, ?)")
          .run(record.id, record.createdAt, encodeRecord(record)).changes,
      catch: storeError("put")
    })
    if (inserted !== 1) {
      return yield* new FleetJobConflictError({ jobId: record.id })
    }
    yield* this.secureFiles()
    return record
  })

  readonly transition = Effect.fn("JobStore.transition")(function*(
    this: JobStore,
    current: JobRecord,
    next: JobRecord
  ) {
    const database = this.#database
    const changed = yield* Effect.try({
      try: () =>
        database
          .prepare(
            `
              UPDATE jobs
              SET record = ?
              WHERE id = ?
                AND record = ?
            `
          )
          .run(
            encodeRecord(next),
            current.id,
            encodeRecord(current)
          ).changes,
      catch: storeError("transition")
    })
    if (changed !== 1) {
      return yield* new FleetTransitionConflictError({ jobId: current.id })
    }
    yield* this.secureFiles()
    return next
  })

  readonly get = Effect.fn("JobStore.get")(function*(
    this: JobStore,
    id: string
  ) {
    const database = this.#database
    const row = yield* Effect.try({
      try: () => database.prepare("SELECT record FROM jobs WHERE id = ?").get(id),
      catch: storeError("get")
    })
    if (row === undefined) return undefined
    const stored = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ record: Schema.String })
    )(row).pipe(Effect.mapError(storeError("get")))
    return yield* decodeRecord(stored.record)
  })

  readonly list = Effect.fn("JobStore.list")(function*(
    this: JobStore,
    limit: number
  ) {
    const database = this.#database
    const rows = yield* Effect.try({
      try: () =>
        database
          .prepare("SELECT record FROM jobs ORDER BY created_at DESC LIMIT ?")
          .all(limit),
      catch: storeError("list")
    })
    return yield* decodeRows("list", rows)
  })

  readonly listPending = Effect.fn("JobStore.listPending")(function*(
    this: JobStore
  ) {
    const database = this.#database
    const rows = yield* Effect.try({
      try: () =>
        database
          .prepare(
            `
              SELECT record
              FROM jobs
              WHERE CASE
                WHEN json_valid(record)
                THEN json_extract(record, '$.status')
              END = ?
              ORDER BY created_at DESC
            `
          )
          .all("pending_approval"),
      catch: storeError("listPending")
    })
    return yield* decodeRows("listPending", rows)
  })

  readonly listRecoverable = Effect.fn("JobStore.listRecoverable")(function*(
    this: JobStore
  ) {
    const database = this.#database
    const rows = yield* Effect.try({
      try: () =>
        database
          .prepare(
            `
              SELECT record
              FROM jobs
              WHERE CASE
                WHEN json_valid(record)
                THEN json_extract(record, '$.status')
              END IN (?, ?, ?)
              ORDER BY created_at ASC
            `
          )
          .all("pending_approval", "queued", "running"),
      catch: storeError("listRecoverable")
    })
    return yield* decodeRows("listRecoverable", rows)
  })

  readonly listWorkers = Effect.fn("JobStore.listWorkers")(function*(
    this: JobStore,
    limit: number
  ) {
    const database = this.#database
    const rows = yield* Effect.try({
      try: () =>
        database
          .prepare(
            `
              SELECT record FROM (
                SELECT id, created_at, record
                FROM jobs
                WHERE CASE
                  WHEN json_valid(record)
                  THEN json_type(record, '$.worker')
                END = 'object'
                ORDER BY created_at DESC, id DESC
                LIMIT ?
              )
              ORDER BY created_at ASC, id ASC
            `
          )
          .all(limit),
      catch: storeError("listWorkers")
    })
    return yield* decodeRows("listWorkers", rows)
  })

  private secureFiles() {
    const fileSystem = this.#fileSystem
    const files = [this.path, `${this.path}-wal`, `${this.path}-shm`]
    return Effect.forEach(
      files,
      (path) =>
        fileSystem.exists(path).pipe(
          Effect.mapError(storeError("secure.exists")),
          Effect.flatMap((exists) =>
            exists
              ? fileSystem.chmod(path, 0o600).pipe(
                Effect.mapError(storeError("secure.chmod"))
              )
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
