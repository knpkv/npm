/**
 * The per-machine SQLite store: Usage Events, Ingest Cursors, Limit Snapshots, Balance Readings and
 * cached ticket titles.
 *
 * **Mental model**
 *
 * - **Facts only** (ADR 0002). Rows hold token counts and Attribution Inputs; Bookings and costs are
 *   derived by callers. No column can hold prompt or response text.
 * - **A chunk commits whole.** A file chunk's events, observations and the cursor past them land in
 *   one transaction, so a pass killed mid-backfill neither loses nor double-counts: the next pass
 *   resumes from the cursor, and event keys absorb any overlap.
 * - **Series store changes, not ticks.** A Limit Snapshot or Balance Reading equal to the one stored
 *   before it only moves that row's `confirmed_at`, which bounds Codex's per-request rate-limit
 *   echoes while keeping "last read" true; graphs draw the series as steps.
 * - **Usage is pre-aggregated into 15-minute buckets** by every dimension pricing and Booking need.
 *   Every time zone's offset is a multiple of 15 minutes, so callers roll buckets up into local
 *   hours, days and weeks without touching raw events.
 *
 * @module
 */
import { SqliteMigrator } from "@effect/sql-sqlite-node"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import {
  Agent,
  AttributionInputs,
  BalanceKind,
  type BalanceReading,
  BalanceValue,
  Count,
  LimitReading,
  type LimitSnapshot,
  ObservationSource,
  Tokens,
  type UsageEvent,
  WindowMinutes
} from "./Model.js"
import { LONG_PROMPT_TOKENS } from "./Pricing.js"

export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

const storeError = (operation: string) => (cause: unknown) => new StoreError({ operation, cause })

/** How far a source file has been read, and the reader state to resume with (reader-owned JSON). */
export const Cursor = Schema.Struct({
  /** Device and inode: a file that was replaced reads from 0 again. */
  identity: Schema.String,
  offset: Count,
  state: Schema.String
})
export type Cursor = typeof Cursor.Type

export interface Chunk {
  readonly agent: Agent
  readonly fileKey: string
  readonly cursor: Cursor
  readonly events: ReadonlyArray<UsageEvent>
  readonly snapshots: ReadonlyArray<LimitSnapshot>
  readonly balances: ReadonlyArray<BalanceReading>
}

/** A half-open time range in epoch milliseconds. */
export interface Range {
  readonly from: number
  readonly to: number
}

/** Usage summed over one 15-minute bucket and every dimension that prices or books it. */
export const UsageGroup = Schema.Struct({
  bucketStart: Schema.Int,
  agent: Agent,
  model: Schema.String,
  fast: Schema.Boolean,
  longPrompt: Schema.Boolean,
  attribution: AttributionInputs,
  requests: Count,
  tokens: Tokens
})
export type UsageGroup = typeof UsageGroup.Type

export const TicketTitle = Schema.Struct({
  key: Schema.String,
  /** Null when the lookup ran and found no title. */
  summary: Schema.NullOr(Schema.String),
  fetchedAt: Schema.Int
})
export type TicketTitle = typeof TicketTitle.Type

/** A stored Limit Snapshot and when an equal reading was last observed. */
export type StoredSnapshot = LimitSnapshot & { readonly confirmedAt: number }

export const BUCKET_MILLIS = 15 * 60 * 1000

const EVENT_BATCH = 400

const GroupRow = Schema.Struct({
  bucket_start: Schema.Int,
  agent: Agent,
  model: Schema.String,
  fast: Schema.Literals([0, 1]),
  long_prompt: Schema.Literals([0, 1]),
  cwd: Schema.String,
  branch: Schema.String,
  active_ticket: Schema.NullOr(Schema.String),
  requests: Count,
  input: Count,
  output: Count,
  reasoning: Count,
  cache_read: Count,
  cache_write_5m: Count,
  cache_write_1h: Count
})

const SnapshotRow = Schema.Struct({
  agent: Agent,
  machine: Schema.String,
  source: ObservationSource,
  label: Schema.String,
  window_minutes: WindowMinutes,
  observed_at: Schema.Int,
  confirmed_at: Schema.Int,
  reading: Schema.fromJsonString(LimitReading)
})

const BalanceRow = Schema.Struct({
  kind: BalanceKind,
  machine: Schema.String,
  confirmed_at: Schema.Int,
  value: Schema.fromJsonString(BalanceValue)
})

const CursorRow = Schema.Struct({ identity: Schema.String, offset: Count, state: Schema.String })
const TicketRow = Schema.Struct({ key: Schema.String, summary: Schema.NullOr(Schema.String), fetched_at: Schema.Int })
const ReadingJson = Schema.fromJsonString(LimitReading)
const BalanceJson = Schema.fromJsonString(BalanceValue)
const encodeReading = Schema.encodeSync(ReadingJson)
const encodeBalance = Schema.encodeSync(BalanceJson)
const Existing = Schema.Struct({ observed_at: Schema.Int, value: Schema.String })
const Found = Schema.Struct({ found: Schema.Int })

const migrations = SqliteMigrator.fromRecord({
  "0001_usage": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE usage_events (
        agent TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        machine TEXT NOT NULL,
        session_id TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        model TEXT NOT NULL,
        fast INTEGER NOT NULL CHECK (fast IN (0, 1)),
        input INTEGER NOT NULL,
        output INTEGER NOT NULL,
        reasoning INTEGER NOT NULL,
        cache_read INTEGER NOT NULL,
        cache_write_5m INTEGER NOT NULL,
        cache_write_1h INTEGER NOT NULL,
        cwd TEXT NOT NULL,
        branch TEXT NOT NULL,
        active_ticket TEXT,
        PRIMARY KEY (agent, dedupe_key)
      )
    `
    yield* sql`CREATE INDEX usage_events_time ON usage_events (occurred_at)`
    yield* sql`
      CREATE TABLE ingest_cursors (
        agent TEXT NOT NULL,
        file_key TEXT NOT NULL,
        identity TEXT NOT NULL,
        offset INTEGER NOT NULL,
        state TEXT NOT NULL,
        PRIMARY KEY (agent, file_key)
      )
    `
    yield* sql`
      CREATE TABLE limit_snapshots (
        agent TEXT NOT NULL,
        machine TEXT NOT NULL,
        source TEXT NOT NULL,
        label TEXT NOT NULL,
        window_minutes INTEGER,
        observed_at INTEGER NOT NULL,
        confirmed_at INTEGER NOT NULL,
        reading TEXT NOT NULL,
        PRIMARY KEY (agent, machine, source, label, observed_at)
      )
    `
    yield* sql`
      CREATE TABLE balance_readings (
        kind TEXT NOT NULL,
        machine TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        confirmed_at INTEGER NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (kind, machine, observed_at)
      )
    `
    yield* sql`
      CREATE TABLE tickets (
        key TEXT PRIMARY KEY,
        summary TEXT,
        fetched_at INTEGER NOT NULL
      )
    `
  })
})

export class UsageStore extends Context.Service<UsageStore, {
  readonly cursor: (agent: Agent, fileKey: string) => Effect.Effect<Option.Option<Cursor>, StoreError>
  /** Writes a chunk's events, observations and cursor in one transaction. */
  readonly commitChunk: (chunk: Chunk) => Effect.Effect<{ readonly eventsAdded: number }, StoreError>
  /** Records observations made outside a file chunk, such as a limit poll. */
  readonly recordObservations: (
    snapshots: ReadonlyArray<LimitSnapshot>,
    balances: ReadonlyArray<BalanceReading>
  ) => Effect.Effect<void, StoreError>
  readonly usageGroups: (range: Range) => Effect.Effect<ReadonlyArray<UsageGroup>, StoreError>
  /** Every distinct branch and working directory ever recorded: what vouches for Known Projects. */
  readonly places: Effect.Effect<ReadonlyArray<{ readonly branch: string; readonly cwd: string }>, StoreError>
  readonly limitSnapshots: (range: Range) => Effect.Effect<ReadonlyArray<StoredSnapshot>, StoreError>
  /** The newest reading of each balance kind on each machine. */
  readonly latestBalances: Effect.Effect<ReadonlyArray<BalanceReading>, StoreError>
  readonly tickets: (keys: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<TicketTitle>, StoreError>
  readonly saveTicket: (ticket: TicketTitle) => Effect.Effect<void, StoreError>
}>()("@knpkv/agent-usage/core/Store/UsageStore") {
  static readonly layer = Layer.effect(
    UsageStore,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* SqliteMigrator.run({ loader: migrations }).pipe(Effect.mapError(storeError("migrate")))

      const insertEvents = Effect.fnUntraced(function*(events: ReadonlyArray<UsageEvent>) {
        let added = 0
        for (let start = 0; start < events.length; start += EVENT_BATCH) {
          const rows = events.slice(start, start + EVENT_BATCH).map((event) => ({
            agent: event.agent,
            dedupe_key: event.dedupeKey,
            machine: event.machine,
            session_id: event.sessionId,
            occurred_at: event.occurredAt,
            model: event.model,
            fast: event.fast ? 1 : 0,
            input: event.tokens.input,
            output: event.tokens.output,
            reasoning: event.tokens.reasoning,
            cache_read: event.tokens.cacheRead,
            cache_write_5m: event.tokens.cacheWrite5m,
            cache_write_1h: event.tokens.cacheWrite1h,
            cwd: event.attribution.cwd,
            branch: event.attribution.branch,
            active_ticket: event.attribution.activeTicket
          }))
          const inserted = yield* sql`
            INSERT INTO usage_events ${sql.insert(rows)}
            ON CONFLICT DO NOTHING
            RETURNING dedupe_key
          `
          added += inserted.length
        }
        return added
      })

      // Each observation is compared with the row actually stored before it, rows written earlier
      // in this transaction included: rollouts are read file by file, so a series' history arrives
      // interleaved and a chunk-local memory would skip real transitions.
      const insertSnapshots = Effect.fnUntraced(function*(snapshots: ReadonlyArray<LimitSnapshot>) {
        const ordered = [...snapshots].sort((left, right) => left.observedAt - right.observedAt)
        for (const snapshot of ordered) {
          const encoded = encodeReading(snapshot.reading)
          const current = `${String(snapshot.windowMinutes)} ${encoded}`
          const previous = (yield* sql`
            SELECT observed_at, coalesce(window_minutes, 'null') || ' ' || reading AS value FROM limit_snapshots
            WHERE agent = ${snapshot.agent} AND machine = ${snapshot.machine}
              AND source = ${snapshot.source} AND label = ${snapshot.label}
              AND observed_at <= ${snapshot.observedAt}
            ORDER BY observed_at DESC LIMIT 1
          `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Existing)))))[0]
          if (previous !== undefined && previous.value === current) {
            // An unchanged window still starts a new row when the whole source failed in between:
            // that row is the recovery, and without it the failure would look permanent.
            const failedSince = snapshot.label !== "*" && (yield* sql`
              SELECT 1 AS found FROM limit_snapshots
              WHERE agent = ${snapshot.agent} AND machine = ${snapshot.machine}
                AND source = ${snapshot.source} AND label = '*'
                AND observed_at > ${previous.observed_at} AND observed_at <= ${snapshot.observedAt}
              LIMIT 1
            `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Found))))).length > 0
            if (!failedSince) {
              yield* sql`
                UPDATE limit_snapshots SET confirmed_at = max(confirmed_at, ${snapshot.observedAt})
                WHERE agent = ${snapshot.agent} AND machine = ${snapshot.machine}
                  AND source = ${snapshot.source} AND label = ${snapshot.label}
                  AND observed_at = ${previous.observed_at}
              `
              continue
            }
          }
          yield* sql`
            INSERT INTO limit_snapshots ${
            sql.insert({
              agent: snapshot.agent,
              machine: snapshot.machine,
              source: snapshot.source,
              label: snapshot.label,
              window_minutes: snapshot.windowMinutes,
              observed_at: snapshot.observedAt,
              confirmed_at: snapshot.observedAt,
              reading: encoded
            })
          }
            ON CONFLICT DO NOTHING
          `
        }
      })

      const insertBalances = Effect.fnUntraced(function*(balances: ReadonlyArray<BalanceReading>) {
        const ordered = [...balances].sort((left, right) => left.observedAt - right.observedAt)
        for (const balance of ordered) {
          const encoded = encodeBalance(balance.value)
          const previous = (yield* sql`
            SELECT observed_at, value FROM balance_readings
            WHERE kind = ${balance.kind} AND machine = ${balance.machine} AND observed_at <= ${balance.observedAt}
            ORDER BY observed_at DESC LIMIT 1
          `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Existing)))))[0]
          if (previous !== undefined && previous.value === encoded) {
            yield* sql`
              UPDATE balance_readings SET confirmed_at = max(confirmed_at, ${balance.observedAt})
              WHERE kind = ${balance.kind} AND machine = ${balance.machine} AND observed_at = ${previous.observed_at}
            `
            continue
          }
          yield* sql`
            INSERT INTO balance_readings ${
            sql.insert({
              kind: balance.kind,
              machine: balance.machine,
              observed_at: balance.observedAt,
              confirmed_at: balance.observedAt,
              value: encoded
            })
          }
            ON CONFLICT DO NOTHING
          `
        }
      })

      const recordObservations = (
        snapshots: ReadonlyArray<LimitSnapshot>,
        balances: ReadonlyArray<BalanceReading>
      ) =>
        sql.withTransaction(Effect.andThen(insertSnapshots(snapshots), insertBalances(balances))).pipe(
          Effect.mapError(storeError("record-observations"))
        )

      const commitChunk = (chunk: Chunk) =>
        sql.withTransaction(Effect.gen(function*() {
          const eventsAdded = yield* insertEvents(chunk.events)
          yield* insertSnapshots(chunk.snapshots)
          yield* insertBalances(chunk.balances)
          yield* sql`
            INSERT INTO ingest_cursors ${
            sql.insert({
              agent: chunk.agent,
              file_key: chunk.fileKey,
              identity: chunk.cursor.identity,
              offset: chunk.cursor.offset,
              state: chunk.cursor.state
            })
          }
            ON CONFLICT (agent, file_key) DO UPDATE SET
              identity = excluded.identity, offset = excluded.offset, state = excluded.state
          `
          return { eventsAdded }
        })).pipe(Effect.mapError(storeError("commit-chunk")))

      const cursor = (agent: Agent, fileKey: string) =>
        sql`SELECT identity, offset, state FROM ingest_cursors WHERE agent = ${agent} AND file_key = ${fileKey}`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(CursorRow))),
          Effect.map((rows) => Option.fromNullishOr(rows[0])),
          Effect.mapError(storeError("read-cursor"))
        )

      const usageGroups = (range: Range) =>
        sql`
          SELECT
            (occurred_at - occurred_at % ${BUCKET_MILLIS}) AS bucket_start,
            agent, model, fast,
            (input + cache_read + cache_write_5m + cache_write_1h) > ${LONG_PROMPT_TOKENS} AS long_prompt,
            cwd, branch, active_ticket,
            count(*) AS requests,
            sum(input) AS input, sum(output) AS output, sum(reasoning) AS reasoning,
            sum(cache_read) AS cache_read, sum(cache_write_5m) AS cache_write_5m, sum(cache_write_1h) AS cache_write_1h
          FROM usage_events
          WHERE occurred_at >= ${range.from} AND occurred_at < ${range.to}
          GROUP BY bucket_start, agent, model, fast, long_prompt, cwd, branch, active_ticket
          ORDER BY bucket_start, agent, model
        `.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(GroupRow))),
          Effect.map((rows) =>
            rows.map((row): UsageGroup => ({
              bucketStart: row.bucket_start,
              agent: row.agent,
              model: row.model,
              fast: row.fast === 1,
              longPrompt: row.long_prompt === 1,
              attribution: { cwd: row.cwd, branch: row.branch, activeTicket: row.active_ticket },
              requests: row.requests,
              tokens: {
                input: row.input,
                output: row.output,
                reasoning: row.reasoning,
                cacheRead: row.cache_read,
                cacheWrite5m: row.cache_write_5m,
                cacheWrite1h: row.cache_write_1h
              }
            }))
          ),
          Effect.mapError(storeError("usage-groups"))
        )

      const places = sql`SELECT DISTINCT branch, cwd FROM usage_events`.pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ branch: Schema.String, cwd: Schema.String })))
        ),
        Effect.mapError(storeError("places"))
      )

      const limitSnapshots = (range: Range) =>
        sql`
          SELECT agent, machine, source, label, window_minutes, observed_at, confirmed_at, reading FROM limit_snapshots
          WHERE observed_at >= ${range.from} AND observed_at < ${range.to}
          ORDER BY observed_at, agent, label
        `.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SnapshotRow))),
          Effect.map((rows) =>
            rows.map((row): StoredSnapshot => ({
              agent: row.agent,
              machine: row.machine,
              source: row.source,
              label: row.label,
              windowMinutes: row.window_minutes,
              observedAt: row.observed_at,
              confirmedAt: row.confirmed_at,
              reading: row.reading
            }))
          ),
          Effect.mapError(storeError("limit-snapshots"))
        )

      const latestBalances = sql`
        SELECT kind, machine, confirmed_at, value FROM balance_readings AS outer_reading
        WHERE observed_at = (
          SELECT max(observed_at) FROM balance_readings AS inner_reading
          WHERE inner_reading.kind = outer_reading.kind AND inner_reading.machine = outer_reading.machine
        )
        ORDER BY kind, machine
      `.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(BalanceRow))),
        Effect.map((rows) =>
          // The value as last observed: an unchanged reading confirms the stored one.
          rows.map((row): BalanceReading => ({
            kind: row.kind,
            machine: row.machine,
            observedAt: row.confirmed_at,
            value: row.value
          }))
        ),
        Effect.mapError(storeError("latest-balances"))
      )

      const tickets = (keys: ReadonlyArray<string>) =>
        keys.length === 0
          ? Effect.succeed([])
          : sql`SELECT key, summary, fetched_at FROM tickets WHERE ${sql.in("key", keys)}`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(TicketRow))),
            Effect.map((rows) =>
              rows.map((row): TicketTitle => ({ key: row.key, summary: row.summary, fetchedAt: row.fetched_at }))
            ),
            Effect.mapError(storeError("tickets"))
          )

      const saveTicket = (ticket: TicketTitle) =>
        sql`
          INSERT INTO tickets ${sql.insert({ key: ticket.key, summary: ticket.summary, fetched_at: ticket.fetchedAt })}
          ON CONFLICT (key) DO UPDATE SET summary = excluded.summary, fetched_at = excluded.fetched_at
        `.pipe(Effect.asVoid, Effect.mapError(storeError("save-ticket")))

      return UsageStore.of({
        cursor,
        commitChunk,
        recordObservations,
        usageGroups,
        places,
        limitSnapshots,
        latestBalances,
        tickets,
        saveTicket
      })
    })
  )
}
