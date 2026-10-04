import { openPrivateSqlite, type PrivateDatabaseError, type PrivateSqlite } from "@knpkv/herdr-fleet/sqlite"
import { Effect, Schema } from "effect"
import type { DatabaseSync, SQLOutputValue } from "node:sqlite"
import { ChatHistoryError } from "./errors.js"
import { chatHistoryMaxEntries, StoredChatTurn, type StoredChatTurn as StoredChatTurnType } from "./model.js"

const storeError = (operation: string) => (cause: unknown) =>
  new ChatHistoryError({ cause, detail: String(cause), operation })

const fromPrivateDatabaseError = (error: PrivateDatabaseError) =>
  new ChatHistoryError({ cause: error.cause, detail: String(error.cause), operation: `chat.${error.operation}` })

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
  readonly #secureFiles: Effect.Effect<void, ChatHistoryError>
  readonly path: string

  private constructor(path: string, opened: PrivateSqlite) {
    this.path = path
    this.#database = opened.database
    this.#secureFiles = opened.secureFiles.pipe(Effect.mapError(fromPrivateDatabaseError))
  }

  static readonly open = Effect.fn("ChatStore.open")(function*(path: string) {
    const opened = yield* openPrivateSqlite(path, {
      initialize: (database) =>
        database.exec(`
          CREATE TABLE IF NOT EXISTS chat_turns (
            id TEXT PRIMARY KEY,
            job_id TEXT NOT NULL UNIQUE,
            created_at INTEGER NOT NULL,
            record TEXT NOT NULL
          );
        `)
    }).pipe(Effect.mapError(fromPrivateDatabaseError))
    return new ChatStore(path, opened)
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
      try: () =>
        this.#database.prepare(
          `SELECT record FROM (
           SELECT id, created_at, record
           FROM chat_turns
           ORDER BY created_at DESC, id DESC
           LIMIT ?
         )
         ORDER BY created_at ASC, id ASC`
        ).all(chatHistoryMaxEntries),
      catch: storeError("chat.list")
    })
    return yield* Effect.forEach(rows, (row) => decodeRow("chat.list", row))
  })

  private secureFiles() {
    return this.#secureFiles
  }

  close(): void {
    this.#database.close()
  }
}
