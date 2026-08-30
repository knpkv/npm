import { Effect, FileSystem, Path, Schema } from "effect"
import { DatabaseSync, type SQLOutputValue } from "node:sqlite"
import { ChatHistoryError } from "./errors.js"
import { StoredChatTurn, type StoredChatTurn as StoredChatTurnType } from "./model.js"

const storeError = (operation: string) => (cause: unknown) =>
  new ChatHistoryError({ cause, detail: String(cause), operation })

const StoredTurnRow = Schema.Struct({ record: Schema.String })

const decodeTurn = (encoded: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(StoredChatTurn)(JSON.parse(encoded)),
    catch: storeError("chat.parse")
  })

const decodeRow = (operation: string, row: Record<string, SQLOutputValue>) =>
  Schema.decodeUnknownEffect(StoredTurnRow)(row).pipe(
    Effect.mapError(storeError(operation)),
    Effect.flatMap(({ record }) => decodeTurn(record))
  )

export interface ChatStoreService {
  readonly getByJob: (
    jobId: string
  ) => Effect.Effect<StoredChatTurnType | undefined, ChatHistoryError>
  readonly list: () => Effect.Effect<ReadonlyArray<StoredChatTurnType>, ChatHistoryError>
  readonly put: (
    turn: StoredChatTurnType
  ) => Effect.Effect<StoredChatTurnType, ChatHistoryError>
}

export class ChatStore {
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
        CREATE TABLE IF NOT EXISTS chat_turns (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          record TEXT NOT NULL
        );
      `)
    } catch (error) {
      this.#database.close()
      throw error
    }
  }

  static readonly open = Effect.fn("ChatStore.open")(function*(path: string) {
    const fileSystem = yield* FileSystem.FileSystem
    const paths = yield* Path.Path
    const directory = paths.dirname(path)
    yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 }).pipe(
      Effect.mapError(storeError("chat.openDirectory"))
    )
    const store = yield* Effect.try({
      try: () => new ChatStore(path, fileSystem),
      catch: storeError("chat.openDatabase")
    })
    yield* store.secureFiles()
    return store
  })

  readonly put = Effect.fn("ChatStore.put")(function*(
    this: ChatStore,
    turn: StoredChatTurnType
  ) {
    const stored = yield* Effect.try({
      try: () => {
        this.#database
          .prepare("INSERT INTO chat_turns (id, job_id, created_at, record) VALUES (?, ?, ?, ?)")
          .run(turn.id, turn.jobId, turn.createdAt, JSON.stringify(turn))
        return turn
      },
      catch: storeError("chat.put")
    })
    yield* this.secureFiles()
    return stored
  })

  readonly getByJob = Effect.fn("ChatStore.getByJob")(function*(
    this: ChatStore,
    jobId: string
  ) {
    const row = yield* Effect.try({
      try: () => this.#database.prepare("SELECT record FROM chat_turns WHERE job_id = ?").get(jobId),
      catch: storeError("chat.getByJob")
    })
    return row === undefined ? undefined : yield* decodeRow("chat.getByJob", row)
  })

  readonly list = Effect.fn("ChatStore.list")(function*(this: ChatStore) {
    const rows = yield* Effect.try({
      try: () => this.#database.prepare("SELECT record FROM chat_turns ORDER BY created_at ASC").all(),
      catch: storeError("chat.list")
    })
    return yield* Effect.forEach(rows, (row) => decodeRow("chat.list", row))
  })

  private secureFiles() {
    const fileSystem = this.#fileSystem
    const files = [this.path, `${this.path}-wal`, `${this.path}-shm`]
    return Effect.forEach(
      files,
      (path) =>
        fileSystem.exists(path).pipe(
          Effect.mapError(storeError("chat.secureExists")),
          Effect.flatMap((exists) =>
            exists
              ? fileSystem.chmod(path, 0o600).pipe(
                Effect.mapError(storeError("chat.secureChmod"))
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
