import { Effect, FileSystem, Path, Schema } from "effect"
import { DatabaseSync } from "node:sqlite"
import { TerminalTransportError } from "./errors.js"

const ActivityRow = Schema.Struct({ last_activity_at: Schema.Number })
const TableColumn = Schema.Struct({ name: Schema.String })

const storeError = (operation: string) => (cause: unknown) =>
  new TerminalTransportError({ cause, detail: String(cause), operation })

export class AgentActivityStore {
  readonly #database: DatabaseSync
  readonly path: string

  private constructor(path: string) {
    this.path = path
    this.#database = new DatabaseSync(path)
    try {
      this.#database.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS agent_activity (
          host TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          last_activity_at INTEGER NOT NULL,
          observed_at INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (host, agent_id)
        );
      `)
      const columns = Schema.decodeUnknownSync(Schema.Array(TableColumn))(
        this.#database.prepare("PRAGMA table_info(agent_activity)").all()
      )
      if (!columns.some(({ name }) => name === "observed_at")) {
        this.#database.exec(
          "ALTER TABLE agent_activity ADD COLUMN observed_at INTEGER NOT NULL DEFAULT 0"
        )
      }
    } catch (error) {
      this.#database.close()
      throw error
    }
  }

  static readonly open = Effect.fn("AgentActivityStore.open")(function*(path: string) {
    const fileSystem = yield* FileSystem.FileSystem
    const paths = yield* Path.Path
    yield* fileSystem.makeDirectory(paths.dirname(path), { recursive: true }).pipe(
      Effect.mapError(storeError("activity.openDirectory"))
    )
    return yield* Effect.try({
      try: () => new AgentActivityStore(path),
      catch: storeError("activity.openDatabase")
    })
  })

  readonly observe = Effect.fn("AgentActivityStore.observe")(function*(
    this: AgentActivityStore,
    host: string,
    agentId: string,
    revision: number,
    observedAt: number
  ) {
    const row = yield* Effect.try({
      try: () =>
        this.#database
          .prepare(
            `INSERT INTO agent_activity (host, agent_id, revision, last_activity_at, observed_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(host, agent_id) DO UPDATE SET
               revision = CASE
                 WHEN excluded.observed_at >= agent_activity.observed_at
                 THEN excluded.revision
                 ELSE agent_activity.revision
               END,
               last_activity_at = CASE
                 WHEN excluded.observed_at < agent_activity.observed_at
                 THEN agent_activity.last_activity_at
                 WHEN agent_activity.revision = excluded.revision
                 THEN agent_activity.last_activity_at
                 ELSE excluded.last_activity_at
               END,
               observed_at = MAX(agent_activity.observed_at, excluded.observed_at)
             RETURNING last_activity_at`
          )
          .get(host, agentId, revision, observedAt, observedAt),
      catch: storeError("activity.observe")
    })
    return yield* Schema.decodeUnknownEffect(ActivityRow)(row).pipe(
      Effect.mapError(storeError("activity.decode")),
      Effect.map(({ last_activity_at }) => last_activity_at)
    )
  })

  close(): void {
    this.#database.close()
  }
}
