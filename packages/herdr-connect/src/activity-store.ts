import { openPrivateSqlite, type PrivateDatabaseError, type PrivateSqlite } from "@knpkv/herdr-fleet/sqlite"
import { Effect, Schema } from "effect"
import type { DatabaseSync } from "node:sqlite"
import { TerminalTransportError } from "./errors.js"

const ActivityRow = Schema.Struct({ last_activity_at: Schema.Number })
const TableColumn = Schema.Struct({ name: Schema.String })

const fromPrivateDatabaseError = (error: PrivateDatabaseError) =>
  new TerminalTransportError({
    cause: error.cause,
    detail: String(error.cause),
    operation: `activity.${error.operation}`
  })

const storeError = (operation: string) => (cause: unknown) =>
  new TerminalTransportError({ cause, detail: String(cause), operation })

export class AgentActivityStore {
  readonly #database: DatabaseSync
  readonly path: string

  private constructor(path: string, opened: PrivateSqlite) {
    this.path = path
    this.#database = opened.database
  }

  static readonly open = Effect.fn("AgentActivityStore.open")(function*(path: string) {
    const opened = yield* openPrivateSqlite(path, {
      initialize: (database) => {
        database.exec(`
        CREATE TABLE IF NOT EXISTS agent_activity (
          host TEXT COLLATE NOCASE NOT NULL,
          agent_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          last_activity_at INTEGER NOT NULL,
          observed_at INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (host, agent_id)
        );
      `)
        const columns = Schema.decodeUnknownSync(Schema.Array(TableColumn))(
          database.prepare("PRAGMA table_info(agent_activity)").all()
        )
        if (!columns.some(({ name }) => name === "observed_at")) {
          database.exec(
            "ALTER TABLE agent_activity ADD COLUMN observed_at INTEGER NOT NULL DEFAULT 0"
          )
        }
      }
    }).pipe(Effect.mapError(fromPrivateDatabaseError))
    return new AgentActivityStore(path, opened)
  })

  readonly observe = Effect.fn("AgentActivityStore.observe")(function*(
    this: AgentActivityStore,
    host: string,
    agentId: string,
    revision: number,
    observedAt: number
  ) {
    const normalizedHost = host.toLowerCase()
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
          .get(normalizedHost, agentId, revision, observedAt, observedAt),
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
