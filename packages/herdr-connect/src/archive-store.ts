import { openPrivateSqlite, type PrivateDatabaseError, type PrivateSqlite } from "@knpkv/herdr-fleet/sqlite"
import { Clock, Effect, Option, Schema, Semaphore } from "effect"
import type { DatabaseSync, SQLOutputValue } from "node:sqlite"
import { ConnectArchiveStoreError } from "./errors.js"
import { advanceHueObservation, initializeHues } from "./internal/hue-database.js"
import { initializePosts } from "./internal/post-database.js"
import { connectBusyTimeoutMillis, connectSqliteWrite } from "./internal/sqlite-write.js"
import {
  ArchivedConnectAgent,
  ConnectAgent,
  ConnectAgentHue,
  ConnectArchiveCursor,
  ConnectArchivePage,
  connectArchivePageMaxRecords,
  connectArchiveWindowDays,
  LocalConnectAgents
} from "./model.js"
import { connectPostRetentionMillis } from "./post-store.js"

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
  relation: Schema.NullOr(Schema.String),
  hue: Schema.NullOr(ConnectAgentHue),
  last_words_text: Schema.NullOr(Schema.String),
  last_words_at: Schema.NullOr(Schema.Number)
})
const HostRow = Schema.Struct({ observed_at: Schema.Number })
const NameRow = Schema.Struct({ name: ConnectAgent.fields.name })
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
  const withHue = decoded.hue === null ? agent : { ...agent, hue: decoded.hue }
  const withWords = decoded.last_words_text === null ? withHue : {
    ...withHue,
    lastWords: { text: decoded.last_words_text, createdAt: decoded.last_words_at }
  }
  return Schema.decodeUnknownSync(ArchivedConnectAgent)(
    decoded.parent_agent_id === null && decoded.relation === null
      ? withWords
      : { ...withWords, relationship: { parentAgentId: decoded.parent_agent_id, relation: decoded.relation } }
  )
}

const recordSighting = (database: DatabaseSync, agent: ConnectAgent, observedAt: number): void => {
  database.prepare(
    `INSERT INTO connect_archive_observations
       (host, agent_id, name, kind, work, state, first_seen_at, parent_agent_id, relation, hue)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(host, agent_id) DO UPDATE SET
       name = excluded.name, kind = excluded.kind, work = excluded.work, state = excluded.state,
       parent_agent_id = excluded.parent_agent_id, relation = excluded.relation,
       hue = COALESCE(excluded.hue, connect_archive_observations.hue),
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
    agent.relationship?.relation ?? null,
    agent.hue ?? null
  )
  database.prepare("DELETE FROM connect_agent_archive WHERE host = ? AND agent_id = ?")
    .run(agent.host.toLowerCase(), agent.id)
}

const recordObservation = (
  database: DatabaseSync,
  observation: ConnectArchiveObservation,
  resetAbsence: boolean
): void => {
  const host = observation.host.toLowerCase()
  if (resetAbsence) {
    database.prepare(
      "UPDATE connect_archive_observations SET missing_since = NULL, missing_reads = 0 WHERE host = ?"
    ).run(host)
  }
  const previous = database.prepare("SELECT observed_at FROM connect_archive_hosts WHERE host = ?").get(host)
  if (previous !== undefined && Schema.decodeUnknownSync(HostRow)(previous).observed_at >= observation.observedAt) {
    return
  }
  database.prepare(
    `INSERT INTO connect_archive_hosts (host, observed_at) VALUES (?, ?)
     ON CONFLICT(host) DO UPDATE SET observed_at = excluded.observed_at`
  ).run(host, observation.observedAt)
  advanceHueObservation(database, host, observation.observedAt)
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
       (host, agent_id, name, kind, work, state, first_seen_at, closed_at, parent_agent_id, relation, last_words_text, last_words_at, hue)
     SELECT o.host, o.agent_id, o.name, o.kind, o.work, o.state, o.first_seen_at, ?, o.parent_agent_id, o.relation,
       p.text, p.created_at, o.hue
     FROM connect_archive_observations o
     LEFT JOIN connect_posts p ON p.sequence = (
       SELECT MAX(sequence) FROM connect_posts
       WHERE host = o.host AND agent_id = o.agent_id AND created_at >= ?
     )
     WHERE o.host = ? AND o.missing_reads >= 2 AND o.missing_since <= ?
     ON CONFLICT(host, agent_id) DO NOTHING`
  ).run(
    observation.observedAt,
    observation.observedAt - connectPostRetentionMillis,
    host,
    observation.observedAt - connectArchiveClosureDelayMillis
  )
  database.prepare(`UPDATE connect_agent_hues SET closed_at = (
    SELECT a.closed_at FROM connect_agent_archive a
    WHERE a.host = connect_agent_hues.host AND a.agent_id = connect_agent_hues.agent_id
  ) WHERE host = ? AND closed_at IS NULL AND agent_id IN (
    SELECT agent_id FROM connect_agent_archive WHERE host = ?
  ) AND observed_at <= (
    SELECT a.closed_at FROM connect_agent_archive a
    WHERE a.host = connect_agent_hues.host AND a.agent_id = connect_agent_hues.agent_id
  )`).run(host, host)
  database.prepare(`DELETE FROM connect_self_state WHERE host = ? AND agent_id IN (
    SELECT agent_id FROM connect_agent_archive WHERE host = ?
  )`).run(host, host)
}

/**
 * Retain compact records until reappearance. Failed writes and reopening require fresh absence evidence.
 */
export class AgentArchiveStore {
  readonly #taintedHosts = new Map<string, number>()
  /** How many optional passes in flight observe each host. */
  readonly #optionalPasses = new Map<string, number>()
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
      busyTimeoutMillis: connectBusyTimeoutMillis,
      initialize: (database) => {
        initializePosts(database)
        initializeHues(database)
        database.exec(`
        CREATE TABLE IF NOT EXISTS connect_archive_hosts (
          host TEXT COLLATE NOCASE PRIMARY KEY, observed_at INTEGER NOT NULL
        );
        INSERT INTO connect_hue_hosts (host, observed_at)
          SELECT host, observed_at FROM connect_archive_hosts WHERE true
          ON CONFLICT(host) DO UPDATE SET observed_at = MAX(connect_hue_hosts.observed_at, excluded.observed_at);
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
        UPDATE connect_archive_observations SET missing_since = NULL, missing_reads = 0;
      `)
        for (const table of ["connect_archive_observations", "connect_agent_archive"]) {
          const columns = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ name: Schema.String })))(
            database.prepare(`PRAGMA table_info(${table})`).all()
          )
          if (!columns.some(({ name }) => name === "hue")) database.exec(`ALTER TABLE ${table} ADD COLUMN hue TEXT`)
        }
        const columns = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ name: Schema.String })))(
          database.prepare("PRAGMA table_info(connect_agent_archive)").all()
        )
        if (!columns.some(({ name }) => name === "last_words_text")) {
          database.exec("ALTER TABLE connect_agent_archive ADD COLUMN last_words_text TEXT")
        }
        if (!columns.some(({ name }) => name === "last_words_at")) {
          database.exec("ALTER TABLE connect_agent_archive ADD COLUMN last_words_at INTEGER")
        }
      }
    }).pipe(Effect.mapError(fromPrivateDatabaseError))
    const transactions = yield* Semaphore.make(1)
    return new AgentArchiveStore(path, transactions, opened)
  })

  /**
   * Supply one validated host read. Failed or partial reads must set complete to false.
   * By default busy writes retry for about five seconds. `retryBusy: false` makes one native 100 ms
   * attempt and refuses a queued archive permit, for optional enrichment on live directory reads.
   */
  readonly observe = Effect.fn("AgentArchiveStore.observe")(function*(
    this: AgentArchiveStore,
    input: ConnectArchiveObservation,
    options: { readonly retryBusy?: boolean } = {}
  ) {
    return yield* this.#observe(input, options.retryBusy !== false, false)
  })

  /**
   * `inPass`: called from an optional pass, which counts itself in `#optionalPasses`. A busy optional write skips
   * quietly when another pass in flight observes the same host: that pass carries the same evidence, so this read
   * neither fails nor resets the host's absence count.
   */
  readonly #observe = Effect.fn("AgentArchiveStore.observeOne")(function*(
    this: AgentArchiveStore,
    input: ConnectArchiveObservation,
    retryBusy: boolean,
    inPass: boolean
  ) {
    const observation = yield* Schema.decodeUnknownEffect(ConnectArchiveObservation)(input).pipe(
      Effect.mapError(failWith("observe.decode"))
    )
    const host = observation.host.toLowerCase()
    const markTainted = Effect.sync(() => this.taintHost(host, observation.observedAt))
    const write = connectSqliteWrite(
      "observe.transaction",
      () => {
        // Cancellation can taint this host while an older attempt waits; check again on every retry.
        const failedAt = this.#taintedHosts.get(host)
        if (failedAt !== undefined && observation.observedAt <= failedAt) return false
        this.#database.exec("BEGIN IMMEDIATE")
        try {
          recordObservation(this.#database, observation, failedAt !== undefined)
          this.#database.exec("COMMIT")
          return true
        } catch (cause) {
          this.#database.exec("ROLLBACK")
          throw cause
        }
      },
      failWith("observe.transaction"),
      retryBusy,
      retryBusy ? this.#transactions : undefined,
      (recorded) =>
        Effect.gen({ self: this }, function*() {
          if (!recorded) return
          yield* this.#secureFiles.pipe(Effect.mapError(fromPrivateDatabaseError))
          const failedAt = this.#taintedHosts.get(host)
          if (failedAt === undefined || failedAt < observation.observedAt) this.#taintedHosts.delete(host)
        })
    ).pipe(Effect.asVoid)
    const guarded = retryBusy
      ? write
      : this.#transactions.withPermitsIfAvailable(1)(write).pipe(Effect.flatMap(Option.match({
        onNone: () =>
          inPass && (this.#optionalPasses.get(host) ?? 0) > 1
            ? Effect.void
            : new ConnectArchiveStoreError({
              operation: "observe.transaction",
              cause: "archive transaction already in progress"
            }),
        onSome: () => Effect.void
      })))
    return yield* guarded.pipe(Effect.tapError(() => markTainted), Effect.onInterrupt(() => markTainted))
  })

  /**
   * One optional pass stops at its first failure; skipped hosts lose any prior absence evidence. A host another pass
   * in flight is writing is skipped quietly instead (see `#observe`).
   */
  readonly observeAvailable = Effect.fn("AgentArchiveStore.observeAvailable")(function*(
    this: AgentArchiveStore,
    input: ReadonlyArray<ConnectArchiveObservation>
  ) {
    const observations = yield* Schema.decodeUnknownEffect(Schema.Array(ConnectArchiveObservation))(input).pipe(
      Effect.mapError(failWith("observe.batch.decode"))
    )
    let completed = 0
    const taintPending = Effect.sync(() => {
      for (const observation of observations.slice(completed)) this.taintHost(observation.host, observation.observedAt)
    })
    const hosts = [...new Set(observations.map(({ host }) => host.toLowerCase()))]
    const enter = Effect.sync(() => {
      for (const host of hosts) this.#optionalPasses.set(host, (this.#optionalPasses.get(host) ?? 0) + 1)
    })
    const leave = Effect.sync(() => {
      for (const host of hosts) {
        const passes = (this.#optionalPasses.get(host) ?? 1) - 1
        if (passes === 0) this.#optionalPasses.delete(host)
        else this.#optionalPasses.set(host, passes)
      }
    })
    const pass = Effect.forEach(observations, (observation) =>
      this.#observe(observation, false, true).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            completed++
          })
        )
      ), { discard: true }).pipe(Effect.tapError(() => taintPending), Effect.onInterrupt(() => taintPending))
    return yield* Effect.acquireUseRelease(enter, () => pass, () => leave)
  })

  private taintHost(host: string, observedAt: number): void {
    const normalizedHost = host.toLowerCase()
    this.#taintedHosts.set(normalizedHost, Math.max(this.#taintedHosts.get(normalizedHost) ?? observedAt, observedAt))
  }

  /** Latest remembered names, scoped to the requested host and identity, including closed agents. */
  readonly namesFor = Effect.fn("AgentArchiveStore.namesFor")(function*(
    this: AgentArchiveStore,
    identities: ReadonlyArray<Pick<ConnectAgent, "host" | "id">>
  ) {
    return yield* this.#transactions.withPermits(1)(Effect.try({
      try: () => {
        const lookup = this.#database.prepare(
          `SELECT name FROM connect_archive_observations WHERE host = ? AND agent_id = ?
           UNION ALL SELECT name FROM connect_agent_archive WHERE host = ? AND agent_id = ? LIMIT 1`
        )
        return identities.flatMap(({ host, id }) => {
          const row = lookup.get(host, id, host, id)
          return row === undefined ? [] : [{ host, id, name: Schema.decodeUnknownSync(NameRow)(row).name }]
        })
      },
      catch: failWith("namesFor")
    }))
  })

  /** Page the current archive window, newest closure first; the cursor names the last returned row. */
  readonly page = Effect.fn("AgentArchiveStore.page")(function*(
    this: AgentArchiveStore,
    input: ConnectArchiveCursor | null = null
  ) {
    const cursor = yield* Schema.decodeUnknownEffect(Schema.NullOr(ConnectArchiveCursor))(input).pipe(
      Effect.mapError(failWith("page.cursor"))
    )
    const cutoff = (yield* Clock.currentTimeMillis) - connectArchiveWindowDays * 86_400_000
    return yield* this.#transactions.withPermits(1)(Effect.try({
      try: () => {
        const columns =
          "host, agent_id, name, kind, work, state, first_seen_at, closed_at, parent_agent_id, relation, last_words_text, last_words_at, hue"
        const rows = cursor === null
          ? this.#database.prepare(
            `SELECT ${columns} FROM connect_agent_archive
             WHERE closed_at >= ?
             ORDER BY closed_at DESC, host, agent_id LIMIT ?`
          ).all(cutoff, connectArchivePageMaxRecords + 1)
          : this.#database.prepare(
            `SELECT ${columns} FROM connect_agent_archive
             WHERE closed_at >= ? AND
               (closed_at < ? OR (closed_at = ? AND (host > ? OR (host = ? AND agent_id > ?))))
             ORDER BY closed_at DESC, host, agent_id LIMIT ?`
          ).all(
            cutoff,
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
