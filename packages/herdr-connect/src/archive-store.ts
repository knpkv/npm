import { openPrivateSqlite, type PrivateDatabaseError, type PrivateSqlite } from "@knpkv/herdr-fleet/sqlite"
import { Effect, Schema, Semaphore } from "effect"
import type { DatabaseSync, SQLOutputValue } from "node:sqlite"
import { ConnectArchiveStoreError } from "./errors.js"
import {
  ArchivedConnectAgent,
  ConnectAgent,
  ConnectArchiveCursor,
  ConnectArchivePage,
  connectArchivePageMaxRecords,
  LocalConnectAgents
} from "./model.js"

export const connectArchiveClosureDelayMillis = 5 * 60 * 1_000

/** Incomplete reads break this host's absence sequence; their positive sightings still count. */
export const ConnectArchiveObservation = Schema.Struct({
  host: ConnectAgent.fields.host,
  agents: LocalConnectAgents.fields.agents,
  observedAt: ArchivedConnectAgent.fields.closedAt,
  complete: Schema.Boolean
}).check(Schema.makeFilter(
  (observation) => observation.agents.every((agent) => agent.host.toLowerCase() === observation.host.toLowerCase()),
  { expected: "agents belonging to the observed host" }
))
export type ConnectArchiveObservation = typeof ConnectArchiveObservation.Type

const ArchiveRow = Schema.Struct({
  host: Schema.String,
  agent_id: Schema.String,
  name: Schema.String,
  kind: Schema.String,
  work: Schema.String,
  state: Schema.String,
  first_seen_at: Schema.Number,
  closed_at: Schema.Number,
  parent_agent_id: Schema.NullOr(Schema.String),
  relation: Schema.NullOr(Schema.String)
})
const HostRow = Schema.Struct({ observed_at: Schema.Number })
const failWith = (operation: string) => (cause: unknown) => new ConnectArchiveStoreError({ operation, cause })
const fromPrivateDatabaseError = (error: PrivateDatabaseError) =>
  new ConnectArchiveStoreError({ operation: error.operation, cause: error.cause })

const decodeArchiveRow = (row: Readonly<Record<string, SQLOutputValue>>): ArchivedConnectAgent => {
  const decoded = Schema.decodeUnknownSync(ArchiveRow)(row)
  const agent = {
    host: decoded.host,
    agentId: decoded.agent_id,
    name: decoded.name,
    kind: decoded.kind,
    work: decoded.work,
    state: decoded.state,
    firstSeenAt: decoded.first_seen_at,
    closedAt: decoded.closed_at
  }
  return Schema.decodeUnknownSync(ArchivedConnectAgent)(
    decoded.parent_agent_id === null && decoded.relation === null
      ? agent
      : { ...agent, relationship: { parentAgentId: decoded.parent_agent_id, relation: decoded.relation } }
  )
}

const recordSighting = (database: DatabaseSync, agent: ConnectAgent, observedAt: number): void => {
  database.prepare(
    `INSERT INTO connect_archive_observations
       (host, agent_id, name, kind, work, state, first_seen_at, parent_agent_id, relation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(host, agent_id) DO UPDATE SET
       name = excluded.name, kind = excluded.kind, work = excluded.work, state = excluded.state,
       parent_agent_id = excluded.parent_agent_id, relation = excluded.relation,
       missing_since = NULL, missing_reads = 0`
  ).run(
    agent.host.toLowerCase(),
    agent.id,
    agent.name,
    agent.kind,
    agent.work,
    agent.state,
    observedAt,
    agent.relationship?.parentAgentId ?? null,
    agent.relationship?.relation ?? null
  )
  database.prepare("DELETE FROM connect_agent_archive WHERE host = ? AND agent_id = ?")
    .run(agent.host.toLowerCase(), agent.id)
}

const recordObservation = (database: DatabaseSync, observation: ConnectArchiveObservation): void => {
  const host = observation.host.toLowerCase()
  const previous = database.prepare("SELECT observed_at FROM connect_archive_hosts WHERE host = ?").get(host)
  if (previous !== undefined && Schema.decodeUnknownSync(HostRow)(previous).observed_at >= observation.observedAt) {
    return
  }
  database.prepare(
    `INSERT INTO connect_archive_hosts (host, observed_at) VALUES (?, ?)
     ON CONFLICT(host) DO UPDATE SET observed_at = excluded.observed_at`
  ).run(host, observation.observedAt)
  if (!observation.complete) {
    database.prepare(
      "UPDATE connect_archive_observations SET missing_since = NULL, missing_reads = 0 WHERE host = ?"
    ).run(host)
  } else {
    database.prepare(
      `UPDATE connect_archive_observations SET
         missing_since = COALESCE(missing_since, ?), missing_reads = MIN(missing_reads + 1, 2)
       WHERE host = ?`
    ).run(observation.observedAt, host)
  }
  for (const agent of observation.agents) recordSighting(database, agent, observation.observedAt)
  if (!observation.complete) return
  database.prepare(
    `INSERT INTO connect_agent_archive
       (host, agent_id, name, kind, work, state, first_seen_at, closed_at, parent_agent_id, relation)
     SELECT host, agent_id, name, kind, work, state, first_seen_at, ?, parent_agent_id, relation
     FROM connect_archive_observations
     WHERE host = ? AND missing_reads >= 2 AND missing_since <= ?
     ON CONFLICT(host, agent_id) DO NOTHING`
  ).run(observation.observedAt, host, observation.observedAt - connectArchiveClosureDelayMillis)
}

/** Track host sightings and retain one compact record per confirmed closure until reappearance. */
export class AgentArchiveStore {
  readonly #database: DatabaseSync
  readonly #transactions: Semaphore.Semaphore
  readonly #secureFiles: PrivateSqlite["secureFiles"]
  readonly path: string

  private constructor(path: string, transactions: Semaphore.Semaphore, opened: PrivateSqlite) {
    this.path = path
    this.#transactions = transactions
    this.#database = opened.database
    this.#secureFiles = opened.secureFiles
  }

  static readonly open = Effect.fn("AgentArchiveStore.open")(function*(path: string) {
    const opened = yield* openPrivateSqlite(path, {
      initialize: (database) =>
        database.exec(`
        CREATE TABLE IF NOT EXISTS connect_archive_hosts (
          host TEXT COLLATE NOCASE PRIMARY KEY, observed_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS connect_archive_observations (
          host TEXT COLLATE NOCASE NOT NULL, agent_id TEXT NOT NULL,
          name TEXT NOT NULL, kind TEXT NOT NULL, work TEXT NOT NULL, state TEXT NOT NULL,
          first_seen_at INTEGER NOT NULL, parent_agent_id TEXT, relation TEXT,
          missing_since INTEGER, missing_reads INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (host, agent_id), CHECK ((parent_agent_id IS NULL) = (relation IS NULL))
        );
        CREATE TABLE IF NOT EXISTS connect_agent_archive (
          host TEXT COLLATE NOCASE NOT NULL, agent_id TEXT NOT NULL,
          name TEXT NOT NULL, kind TEXT NOT NULL, work TEXT NOT NULL, state TEXT NOT NULL,
          first_seen_at INTEGER NOT NULL, closed_at INTEGER NOT NULL,
          parent_agent_id TEXT, relation TEXT,
          PRIMARY KEY (host, agent_id), CHECK ((parent_agent_id IS NULL) = (relation IS NULL))
        );
        CREATE INDEX IF NOT EXISTS connect_archive_order
          ON connect_agent_archive (closed_at DESC, host, agent_id);
      `)
    }).pipe(Effect.mapError(fromPrivateDatabaseError))
    const transactions = yield* Semaphore.make(1)
    return new AgentArchiveStore(path, transactions, opened)
  })

  /** Supply one validated host read. Failed or partial reads must set complete to false. */
  readonly observe = Effect.fn("AgentArchiveStore.observe")(function*(
    this: AgentArchiveStore,
    input: ConnectArchiveObservation
  ) {
    const observation = yield* Schema.decodeUnknownEffect(ConnectArchiveObservation)(input).pipe(
      Effect.mapError(failWith("observe.decode"))
    )
    return yield* this.#transactions.withPermits(1)(
      Effect.try({
        try: () => {
          this.#database.exec("BEGIN IMMEDIATE")
          try {
            recordObservation(this.#database, observation)
            this.#database.exec("COMMIT")
          } catch (cause) {
            this.#database.exec("ROLLBACK")
            throw cause
          }
        },
        catch: failWith("observe.transaction")
      }).pipe(Effect.andThen(this.#secureFiles.pipe(Effect.mapError(fromPrivateDatabaseError))))
    )
  })

  /** Newest closure first, then host and stable identity; the cursor names the last returned row. */
  readonly page = Effect.fn("AgentArchiveStore.page")(function*(
    this: AgentArchiveStore,
    input: ConnectArchiveCursor | null = null
  ) {
    const cursor = yield* Schema.decodeUnknownEffect(Schema.NullOr(ConnectArchiveCursor))(input).pipe(
      Effect.mapError(failWith("page.cursor"))
    )
    return yield* this.#transactions.withPermits(1)(Effect.try({
      try: () => {
        const columns = "host, agent_id, name, kind, work, state, first_seen_at, closed_at, parent_agent_id, relation"
        const rows = cursor === null
          ? this.#database.prepare(
            `SELECT ${columns} FROM connect_agent_archive
             ORDER BY closed_at DESC, host, agent_id LIMIT ?`
          ).all(connectArchivePageMaxRecords + 1)
          : this.#database.prepare(
            `SELECT ${columns} FROM connect_agent_archive
             WHERE closed_at < ? OR (closed_at = ? AND (host > ? OR (host = ? AND agent_id > ?)))
             ORDER BY closed_at DESC, host, agent_id LIMIT ?`
          ).all(
            cursor.closedAt,
            cursor.closedAt,
            cursor.host,
            cursor.host,
            cursor.agentId,
            connectArchivePageMaxRecords + 1
          )
        const agents = rows.slice(0, connectArchivePageMaxRecords).map(decodeArchiveRow)
        const last = agents.at(-1)
        return Schema.decodeUnknownSync(ConnectArchivePage)({
          agents,
          nextCursor: rows.length > connectArchivePageMaxRecords && last !== undefined
            ? { closedAt: last.closedAt, host: last.host, agentId: last.agentId }
            : null
        })
      },
      catch: failWith("page")
    }))
  })

  close(): void {
    this.#database.close()
  }
}
