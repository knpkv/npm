import { openPrivateSqlite, type PrivateSqlite } from "@knpkv/herdr-fleet/sqlite"
import { Clock, Effect, Schema, Semaphore } from "effect"
import type { DatabaseSync } from "node:sqlite"
import {
  applyBlockedPushMutation,
  blockedAgentBucket,
  BlockedObservation,
  blockedPromptFirstLine,
  BlockedPushMutation,
  BlockedPushPayload,
  blockedPushReminderMillis,
  BlockedPushSettings,
  BlockedPushStoreError,
  StageHeartbeat,
  stageViewingTtlMillis
} from "./blocked-push-model.js"
import { hubConnectBusyTimeoutMillis } from "./internal/sqlite-busy.js"

const closedEpisodeRetentionMillis = 7 * 24 * 60 * 60 * 1_000

const Episode = Schema.Struct({
  host: Schema.String,
  agent_id: Schema.String,
  started_at: Schema.Number,
  payload: Schema.String
})
export type BlockedEpisode = {
  readonly host: string
  readonly agentId: string
  readonly startedAt: number
  readonly payload: BlockedPushPayload
}
const failure = (operation: string) => (cause: unknown) => new BlockedPushStoreError({ operation, cause })

const readSettings = (db: DatabaseSync, owner: string): BlockedPushSettings => {
  const result = db.prepare("SELECT settings FROM blocked_push_settings WHERE owner = ?").get(owner)
  if (result === undefined) return { mutedAgents: [], quietHours: null }
  const row = Schema.decodeUnknownSync(Schema.Struct({ settings: Schema.String }))(result)
  return Schema.decodeUnknownSync(Schema.fromJsonString(BlockedPushSettings))(row.settings)
}

/** Stores blocked episodes and delivery reservations in the owner's private hub database. */
export class BlockedPushStore {
  readonly #database: DatabaseSync
  readonly #transactions: Semaphore.Semaphore
  readonly #secureFiles: PrivateSqlite["secureFiles"]
  readonly path: string

  private constructor(path: string, opened: PrivateSqlite, transactions: Semaphore.Semaphore) {
    this.path = path
    this.#database = opened.database
    this.#secureFiles = opened.secureFiles
    this.#transactions = transactions
  }

  static readonly open = Effect.fn("BlockedPushStore.open")(function*(path: string) {
    const opened = yield* openPrivateSqlite(path, {
      busyTimeoutMillis: hubConnectBusyTimeoutMillis,
      initialize: (db) =>
        db.exec(`
      CREATE TABLE IF NOT EXISTS blocked_push_hosts (
        host TEXT COLLATE NOCASE PRIMARY KEY, observed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS blocked_push_episodes (
        host TEXT COLLATE NOCASE NOT NULL, agent_id TEXT NOT NULL, started_at INTEGER NOT NULL,
        payload TEXT NOT NULL, closed_at INTEGER, missing_since INTEGER, missing_reads INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (host, agent_id, started_at)
      );
      CREATE TABLE IF NOT EXISTS blocked_push_agents (
        host TEXT COLLATE NOCASE NOT NULL, agent_id TEXT NOT NULL, last_started_at INTEGER NOT NULL,
        PRIMARY KEY (host, agent_id)
      );
      INSERT OR IGNORE INTO blocked_push_agents
        SELECT host, agent_id, MAX(started_at) FROM blocked_push_episodes GROUP BY host, agent_id;
      CREATE UNIQUE INDEX IF NOT EXISTS blocked_push_open ON blocked_push_episodes (host, agent_id) WHERE closed_at IS NULL;
      CREATE TABLE IF NOT EXISTS blocked_push_sends (
        host TEXT COLLATE NOCASE NOT NULL, agent_id TEXT NOT NULL, started_at INTEGER NOT NULL,
        subscription TEXT NOT NULL, slot INTEGER NOT NULL, reserved_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL, status TEXT NOT NULL,
        PRIMARY KEY (host, agent_id, started_at, subscription, slot), CHECK (slot IN (0, 1))
      );
      CREATE TABLE IF NOT EXISTS blocked_push_viewing (
        owner TEXT NOT NULL, client_id TEXT NOT NULL, host TEXT COLLATE NOCASE NOT NULL,
        agent_id TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (owner, client_id)
      );
      CREATE TABLE IF NOT EXISTS blocked_push_acknowledged (
        owner TEXT NOT NULL, host TEXT COLLATE NOCASE NOT NULL, agent_id TEXT NOT NULL, started_at INTEGER NOT NULL,
        PRIMARY KEY (owner, host, agent_id, started_at)
      );
      CREATE TABLE IF NOT EXISTS blocked_push_settings (owner TEXT PRIMARY KEY, settings TEXT NOT NULL);
      UPDATE blocked_push_episodes SET missing_since = NULL, missing_reads = 0;
    `)
    }).pipe(Effect.mapError(failure("open")))
    return new BlockedPushStore(path, opened, yield* Semaphore.make(1))
  })

  readonly #transaction = <A>(operation: string, run: (db: DatabaseSync) => A) =>
    this.#transactions.withPermits(1)(
      Effect.try({
        try: () => {
          this.#database.exec("BEGIN IMMEDIATE")
          try {
            const result = run(this.#database)
            this.#database.exec("COMMIT")
            return result
          } catch (cause) {
            this.#database.exec("ROLLBACK")
            throw cause
          }
        },
        catch: failure(operation)
      }).pipe(Effect.tap(() => this.#secureFiles.pipe(Effect.mapError(failure(`${operation}.permissions`)))))
    )

  /** Closed sensitive data expires after seven days; only identity watermarks survive. Removed subscription revisions lose all sends. */
  readonly prune = Effect.fn("BlockedPushStore.prune")(
    function*(this: BlockedPushStore, liveSubscriptions: ReadonlyArray<string>) {
      const now = yield* Clock.currentTimeMillis
      return yield* this.#transaction("prune", (db) => {
        db.prepare("DELETE FROM blocked_push_episodes WHERE closed_at <= ?").run(now - closedEpisodeRetentionMillis)
        for (const table of ["blocked_push_sends", "blocked_push_acknowledged"]) {
          db.prepare(`DELETE FROM ${table} WHERE NOT EXISTS (
            SELECT 1 FROM blocked_push_episodes AS episode WHERE episode.host = ${table}.host
            AND episode.agent_id = ${table}.agent_id AND episode.started_at = ${table}.started_at
          )`).run()
        }
        const live = new Set(liveSubscriptions)
        const revisions = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ subscription: Schema.String })))(
          db.prepare("SELECT DISTINCT subscription FROM blocked_push_sends").all()
        )
        for (const { subscription } of revisions) {
          if (!live.has(subscription)) {
            db.prepare("DELETE FROM blocked_push_sends WHERE subscription = ?").run(subscription)
          }
        }
        db.prepare("DELETE FROM blocked_push_viewing WHERE expires_at <= ?").run(now)
      })
    }
  )

  /** Partial reads never start or end episodes and break any absence sequence. */
  readonly observe = Effect.fn("BlockedPushStore.observe")(
    function*(this: BlockedPushStore, input: BlockedObservation) {
      const observation = yield* Schema.decodeUnknownEffect(BlockedObservation)(input).pipe(
        Effect.mapError(failure("observe.decode"))
      )
      return yield* this.#transaction("observe", (db) => {
        const host = observation.host.toLowerCase()
        if (!observation.complete) {
          db.prepare(
            "UPDATE blocked_push_episodes SET missing_since = NULL, missing_reads = 0 WHERE host = ? AND closed_at IS NULL"
          ).run(host)
          return
        }
        const previous = db.prepare("SELECT observed_at FROM blocked_push_hosts WHERE host = ?").get(host)
        if (
          previous !== undefined &&
          Schema.decodeUnknownSync(Schema.Struct({ observed_at: Schema.Number }))(previous).observed_at >
            observation.observedAt
        ) return
        db.prepare(
          "INSERT INTO blocked_push_hosts VALUES (?, ?) ON CONFLICT(host) DO UPDATE SET observed_at = excluded.observed_at"
        ).run(host, observation.observedAt)
        db.prepare(
          `UPDATE blocked_push_episodes SET missing_since = COALESCE(missing_since, ?), missing_reads = MIN(missing_reads + 1, 2)
        WHERE host = ? AND closed_at IS NULL`
        ).run(observation.observedAt, host)
        for (const agent of observation.agents) {
          db.prepare(
            "UPDATE blocked_push_episodes SET missing_since = NULL, missing_reads = 0 WHERE host = ? AND agent_id = ? AND closed_at IS NULL"
          ).run(host, agent.id)
          const bucket = blockedAgentBucket(agent.state)
          if (bucket === "unknown" && agent.blocker !== true) continue
          if (bucket === "inactive" && agent.blocker !== true) {
            db.prepare(
              "UPDATE blocked_push_episodes SET closed_at = ? WHERE host = ? AND agent_id = ? AND closed_at IS NULL"
            ).run(observation.observedAt, host, agent.id)
            continue
          }
          const fields = {
            kind: "agent-blocked",
            host,
            agentId: agent.id,
            agentName: agent.name,
            state: bucket === "blocked" ? "blocked" : "needs-you",
            firstLine: blockedPromptFirstLine(
              agent.firstLine ?? (bucket === "blocked" ? `${agent.name} is blocked` : `${agent.name} needs you`)
            ),
            approvalJobId: agent.approvalJobId ?? null
          }
          const payload = Schema.decodeUnknownSync(BlockedPushPayload)(
            agent.eventId === undefined ? fields : { ...fields, eventId: agent.eventId }
          )
          const current = db.prepare(
            "SELECT started_at FROM blocked_push_episodes WHERE host = ? AND agent_id = ? AND closed_at IS NULL"
          ).get(host, agent.id)
          if (current === undefined) {
            const latest = Schema.decodeUnknownSync(Schema.Struct({ latest: Schema.NullOr(Schema.Number) }))(
              db.prepare(
                "SELECT MAX(last_started_at) AS latest FROM blocked_push_agents WHERE host = ? AND agent_id = ?"
              )
                .get(host, agent.id)
            ).latest
            const startedAt = latest === null ? observation.observedAt : Math.max(observation.observedAt, latest + 1)
            db.prepare("INSERT INTO blocked_push_episodes (host, agent_id, started_at, payload) VALUES (?, ?, ?, ?)")
              .run(host, agent.id, startedAt, JSON.stringify(payload))
            db.prepare(`INSERT INTO blocked_push_agents VALUES (?, ?, ?) ON CONFLICT(host, agent_id)
              DO UPDATE SET last_started_at = excluded.last_started_at`).run(host, agent.id, startedAt)
          } else {
            db.prepare(
              "UPDATE blocked_push_episodes SET payload = ? WHERE host = ? AND agent_id = ? AND closed_at IS NULL"
            ).run(JSON.stringify(payload), host, agent.id)
          }
        }
        db.prepare(`UPDATE blocked_push_episodes SET closed_at = ?
        WHERE host = ? AND closed_at IS NULL AND missing_reads >= 2 AND missing_since <= ?`).run(
          observation.observedAt,
          host,
          observation.observedAt - 300_000
        )
      })
    }
  )

  readonly pending = Effect.fn("BlockedPushStore.pending")(
    function*(this: BlockedPushStore, targets: ReadonlyArray<{ readonly host: string; readonly agentId: string }>) {
      return yield* this.#transaction("pending", (db) =>
        db.prepare(
          "SELECT host, agent_id, started_at, payload FROM blocked_push_episodes WHERE closed_at IS NULL AND missing_since IS NULL"
        ).all().map((row) => Schema.decodeUnknownSync(Episode)(row))
          .filter((row) =>
            targets.some((target) => target.host.toLowerCase() === row.host && target.agentId === row.agent_id)
          )
          .map((row): BlockedEpisode => ({
            host: row.host,
            agentId: row.agent_id,
            startedAt: row.started_at,
            payload: Schema.decodeUnknownSync(Schema.fromJsonString(BlockedPushPayload))(row.payload)
          })))
    }
  )

  /** Reserve before network I/O: a crash after provider acceptance cannot resend the same slot. */
  readonly reserve = Effect.fn("BlockedPushStore.reserve")(
    function*(this: BlockedPushStore, episode: BlockedEpisode, subscription: string, owner: string) {
      const now = yield* Clock.currentTimeMillis
      return yield* this.#transaction("reserve", (db) => {
        const acknowledged = db.prepare(
          "SELECT 1 FROM blocked_push_acknowledged WHERE owner = ? AND host = ? AND agent_id = ? AND started_at = ?"
        ).get(owner, episode.host, episode.agentId, episode.startedAt)
        if (acknowledged !== undefined) return null
        const viewing = db.prepare(
          "SELECT 1 FROM blocked_push_viewing WHERE owner = ? AND host = ? AND agent_id = ? AND expires_at > ? LIMIT 1"
        )
          .get(owner, episode.host, episode.agentId, now)
        if (viewing !== undefined) return null
        const preferences = db.prepare("SELECT settings FROM blocked_push_settings WHERE owner = ?").get(owner)
        if (preferences !== undefined) {
          const row = Schema.decodeUnknownSync(Schema.Struct({ settings: Schema.String }))(preferences)
          const settings = Schema.decodeUnknownSync(Schema.fromJsonString(BlockedPushSettings))(row.settings)
          if (
            settings.mutedAgents.some((key) =>
              key.host.toLowerCase() === episode.host && key.agentId === episode.agentId
            )
          ) return null
          const quiet = settings.quietHours
          if (quiet !== null) {
            const parts = new Intl.DateTimeFormat("en", {
              hour: "2-digit",
              minute: "2-digit",
              hourCycle: "h23",
              timeZone: quiet.timeZone
            }).formatToParts(now)
            const { hour, minute: localMinute } = Schema.decodeUnknownSync(Schema.Struct({
              hour: Schema.NumberFromString,
              minute: Schema.NumberFromString
            }))(Object.fromEntries(parts.map(({ type, value }) => [type, value])))
            const minute = hour * 60 + localMinute
            if (
              quiet.startMinute === quiet.endMinute || (quiet.startMinute < quiet.endMinute
                ? minute >= quiet.startMinute && minute < quiet.endMinute
                : minute >= quiet.startMinute || minute < quiet.endMinute)
            ) return null
          }
        }
        const rows = Schema.decodeUnknownSync(
          Schema.Array(
            Schema.Struct({
              slot: Schema.Literals([0, 1]),
              reserved_at: Schema.Number,
              attempts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
              status: Schema.Literals(["reserved", "sent", "retry", "failed"])
            })
          )
        )(
          db.prepare(
            "SELECT slot, reserved_at, attempts, status FROM blocked_push_sends WHERE host = ? AND agent_id = ? AND started_at = ? AND subscription = ? ORDER BY slot"
          ).all(episode.host, episode.agentId, episode.startedAt, subscription)
        )
        const initial = rows.find((row) => row.slot === 0)
        const retry = rows.find((row) => row.status === "retry")
        if (retry !== undefined) {
          const updated = db.prepare(
            `UPDATE blocked_push_sends SET status = 'reserved', attempts = attempts + 1, reserved_at = ?
            WHERE host = ? AND agent_id = ? AND started_at = ? AND subscription = ? AND slot = ? AND status = 'retry' AND attempts < 3`
          )
            .run(now, episode.host, episode.agentId, episode.startedAt, subscription, retry.slot)
          return updated.changes === 1 ? retry.slot : null
        }
        const slot = rows.length === 0
          ? 0
          : initial !== undefined && now >= initial.reserved_at + blockedPushReminderMillis &&
              !rows.some((row) => row.slot === 1)
          ? 1
          : null
        if (slot === null) return null
        const result = db.prepare(
          `INSERT INTO blocked_push_sends SELECT host, agent_id, started_at, ?, ?, ?, 1, 'reserved'
        FROM blocked_push_episodes WHERE host = ? AND agent_id = ? AND started_at = ? AND closed_at IS NULL
        ON CONFLICT DO NOTHING`
        ).run(subscription, slot, now, episode.host, episode.agentId, episode.startedAt)
        return result.changes === 1 ? slot : null
      })
    }
  )

  /** Only a definite rejection releases a reservation, and its third rejection is final. */
  readonly finish = Effect.fn("BlockedPushStore.finish")(
    function*(
      this: BlockedPushStore,
      episode: BlockedEpisode,
      subscription: string,
      slot: number,
      outcome: "accepted" | "rejected"
    ) {
      return yield* this.#transaction("finish", (db) => {
        db.prepare(
          `UPDATE blocked_push_sends SET status = CASE WHEN ? = 'accepted' THEN 'sent' WHEN attempts >= 3 THEN 'failed' ELSE 'retry' END
        WHERE host = ? AND agent_id = ? AND started_at = ? AND subscription = ? AND slot = ? AND status = 'reserved'`
        )
          .run(outcome, episode.host, episode.agentId, episode.startedAt, subscription, slot)
      })
    }
  )

  readonly settings = Effect.fn("BlockedPushStore.settings")(function*(this: BlockedPushStore, owner: string) {
    return yield* this.#transaction("settings", (db) => readSettings(db, owner))
  })

  /** Read, merge and persist each preference intent under the same SQLite write transaction. */
  readonly mutateSettings = Effect.fn("BlockedPushStore.mutateSettings")(
    function*(this: BlockedPushStore, owner: string, input: BlockedPushMutation) {
      const mutation = yield* Schema.decodeUnknownEffect(BlockedPushMutation)(input).pipe(
        Effect.mapError(failure("settings.decode"))
      )
      return yield* this.#transaction("settings.patch", (db) => {
        const settings = Schema.decodeUnknownSync(BlockedPushSettings)(
          applyBlockedPushMutation(readSettings(db, owner), mutation)
        )
        db.prepare(
          "INSERT INTO blocked_push_settings VALUES (?, ?) ON CONFLICT(owner) DO UPDATE SET settings = excluded.settings"
        ).run(owner, JSON.stringify(settings))
        return settings
      })
    }
  )

  /** A visible heartbeat acknowledges the current episode for its owner; presence expires independently per tab. */
  readonly heartbeat = Effect.fn("BlockedPushStore.heartbeat")(
    function*(this: BlockedPushStore, owner: string, input: StageHeartbeat) {
      const heartbeat = yield* Schema.decodeUnknownEffect(StageHeartbeat)(input).pipe(
        Effect.mapError(failure("heartbeat.decode"))
      )
      const now = yield* Clock.currentTimeMillis
      return yield* this.#transaction("heartbeat", (db) => {
        db.prepare("DELETE FROM blocked_push_viewing WHERE expires_at <= ?").run(now)
        if (heartbeat.target === null) {
          db.prepare("DELETE FROM blocked_push_viewing WHERE owner = ? AND client_id = ?").run(
            owner,
            heartbeat.clientId
          )
        } else {
          db.prepare(`INSERT INTO blocked_push_acknowledged (owner, host, agent_id, started_at)
          SELECT ?, host, agent_id, started_at FROM blocked_push_episodes
          WHERE host = ? AND agent_id = ? AND closed_at IS NULL ON CONFLICT DO NOTHING`)
            .run(owner, heartbeat.target.host.toLowerCase(), heartbeat.target.agentId)
          db.prepare(`INSERT INTO blocked_push_viewing VALUES (?, ?, ?, ?, ?) ON CONFLICT(owner, client_id)
          DO UPDATE SET host = excluded.host, agent_id = excluded.agent_id, expires_at = excluded.expires_at`)
            .run(
              owner,
              heartbeat.clientId,
              heartbeat.target.host.toLowerCase(),
              heartbeat.target.agentId,
              now + stageViewingTtlMillis
            )
        }
      })
    }
  )

  close(): void {
    this.#database.close()
  }
}
