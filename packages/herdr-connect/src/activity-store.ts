import { openPrivateSqlite, type PrivateDatabaseError, type PrivateSqlite } from "@knpkv/herdr-fleet/sqlite"
import { Effect, Schema, Semaphore } from "effect"
import type { DatabaseSync } from "node:sqlite"
import { TerminalTransportError } from "./errors.js"
import { assignHues, initializeHues } from "./internal/hue-database.js"
import { connectPeerDirectoryTimeoutMillis } from "./internal/peer-deadline.js"
import { connectBusyTimeoutMillis, connectSqliteWrite } from "./internal/sqlite-write.js"
import { ConnectAgent, LocalConnectAgents } from "./model.js"

const ActivityRow = Schema.Struct({ last_activity_at: Schema.Number })
const TableColumn = Schema.Struct({ name: Schema.String })
const optionalHueTimeoutMillis = connectPeerDirectoryTimeoutMillis / 2

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
  readonly #transactions: Semaphore.Semaphore
  readonly #secureFiles: PrivateSqlite["secureFiles"]
  readonly path: string

  private constructor(path: string, transactions: Semaphore.Semaphore, opened: PrivateSqlite) {
    this.path = path
    this.#database = opened.database
    this.#transactions = transactions
    this.#secureFiles = opened.secureFiles
  }

  static readonly open = Effect.fn("AgentActivityStore.open")(function*(path: string) {
    const opened = yield* openPrivateSqlite(path, {
      busyTimeoutMillis: connectBusyTimeoutMillis,
      initialize: (database) => {
        initializeHues(database)
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
    return new AgentActivityStore(path, yield* Semaphore.make(1), opened)
  })

  readonly observe = Effect.fn("AgentActivityStore.observe")(function*(
    this: AgentActivityStore,
    host: string,
    agentId: string,
    revision: number,
    observedAt: number
  ) {
    const normalizedHost = host.toLowerCase()
    const row = yield* connectSqliteWrite(
      "activity.observe",
      () =>
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
      storeError("activity.observe"),
      true,
      this.#transactions,
      () => this.#secureFiles.pipe(Effect.mapError(fromPrivateDatabaseError))
    )
    return yield* Schema.decodeUnknownEffect(ActivityRow)(row).pipe(
      Effect.mapError(storeError("activity.decode")),
      Effect.map(({ last_activity_at }) => last_activity_at)
    )
  })

  /** Complete local inventories release absent reservations; partial reads only enrich positive sightings. */
  readonly assignHues = Effect.fn("AgentActivityStore.assignHues")(
    function*(
      this: AgentActivityStore,
      host: string,
      agents: ReadonlyArray<ConnectAgent>,
      observedAt: number,
      complete = false
    ) {
      const input = yield* Schema.decodeUnknownEffect(Schema.Struct({
        directory: LocalConnectAgents,
        observedAt: ConnectAgent.fields.lastActivityAt
      }))({ directory: { host, agents, complete }, observedAt }).pipe(
        Effect.mapError(storeError("activity.hues.decode"))
      )
      if (input.directory.agents.some((agent) => agent.host.toLowerCase() !== input.directory.host.toLowerCase())) {
        return yield* new TerminalTransportError({
          cause: input.directory.host,
          detail: "Hue allocation requires agents from the requested host",
          operation: "activity.hues.decode"
        })
      }
      const assigned = yield* connectSqliteWrite(
        "activity.hues.assign",
        () => {
          this.#database.exec("BEGIN IMMEDIATE")
          try {
            const result = assignHues(
              this.#database,
              input.directory.host,
              input.directory.agents,
              input.observedAt,
              input.directory.complete === true
            )
            this.#database.exec("COMMIT")
            return result
          } catch (cause) {
            this.#database.exec("ROLLBACK")
            throw cause
          }
        },
        storeError("activity.hues.assign"),
        true,
        this.#transactions,
        () => this.#secureFiles.pipe(Effect.mapError(fromPrivateDatabaseError)),
        optionalHueTimeoutMillis
      )
      return assigned
    }
  )

  close(): void {
    this.#database.close()
  }
}
