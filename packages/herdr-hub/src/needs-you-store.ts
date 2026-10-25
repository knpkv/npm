/**
 * What a person did about a failed fleet job in the Needs-you inbox: {@link makeNeedsYouStore}.
 *
 * **Mental model**
 *
 * - **The hub remembers, not the job's host.** Failures come from every host, and a peer may run an older hub, so
 *   dismissals and retries live in the hub's own `needs-you.sqlite`, keyed by host (any case) and job id.
 * - **Dismiss is idempotent.** A second dismissal keeps the first one's time and person.
 * - **A retry is claimed before it is submitted.** {@link NeedsYouStore.claimRetry} inserts the key with no retry job
 *   yet, so two presses (or two devices) can't both submit. The submit then fills the new job id
 *   ({@link NeedsYouStore.fillRetry}) or, when it failed, releases the claim. A claim left without an id for
 *   {@link retryClaimStaleMillis} (a restart mid-submit) counts as absent and may be claimed again.
 * - **Only a filled retry hides a failure.** An in-flight or orphaned claim leaves the row visible.
 *
 * @module
 */
import { openPrivateSqlite } from "@knpkv/herdr-fleet/sqlite"
import { Clock, Effect, Schema } from "effect"

export const retryClaimStaleMillis = 2 * 60 * 1_000

export class NeedsYouStoreError extends Schema.TaggedError<NeedsYouStoreError>()("NeedsYouStoreError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/** The key of one job on one host. Hosts compare without case. */
export interface FleetJobKey {
  readonly host: string
  readonly jobId: string
}

/** A claim already held: by a retry that produced `retryJobId`, or one still in flight (null). */
export class RetryAlreadyClaimed extends Schema.TaggedError<RetryAlreadyClaimed>()("RetryAlreadyClaimed", {
  retryJobId: Schema.NullOr(Schema.String)
}) {}

const RetryRow = Schema.Struct({ retry_job_id: Schema.NullOr(Schema.String), retried_at: Schema.Number })
const KeyRow = Schema.Struct({ host: Schema.String, job_id: Schema.String })

export interface NeedsYouStore {
  readonly dismiss: (key: FleetJobKey, person: string) => Effect.Effect<void, NeedsYouStoreError>
  readonly claimRetry: (
    key: FleetJobKey,
    person: string
  ) => Effect.Effect<void, NeedsYouStoreError | RetryAlreadyClaimed>
  readonly fillRetry: (key: FleetJobKey, retryJobId: string) => Effect.Effect<void, NeedsYouStoreError>
  readonly releaseRetry: (key: FleetJobKey) => Effect.Effect<void, NeedsYouStoreError>
  /** The keys among `keys` that are dismissed or have a filled retry. */
  readonly settled: (keys: ReadonlyArray<FleetJobKey>) => Effect.Effect<ReadonlySet<string>, NeedsYouStoreError>
}

/** The set key {@link NeedsYouStore.settled} answers with. */
export const fleetJobKey = ({ host, jobId }: FleetJobKey): string => `${host.toLowerCase()}\u0000${jobId}`

/** The caller's scope owns the SQLite handle. */
export const makeNeedsYouStore = Effect.fn("NeedsYouStore.make")(function*(path: string) {
  const opened = yield* Effect.acquireRelease(
    openPrivateSqlite(path, {
      busyTimeoutMillis: 500,
      initialize: (database) => {
        database.exec(`
        CREATE TABLE IF NOT EXISTS dismissed (
          host TEXT COLLATE NOCASE NOT NULL, job_id TEXT NOT NULL,
          dismissed_at INTEGER NOT NULL, dismissed_by TEXT NOT NULL,
          PRIMARY KEY (host, job_id)
        );
        CREATE TABLE IF NOT EXISTS retried (
          host TEXT COLLATE NOCASE NOT NULL, job_id TEXT NOT NULL,
          retry_job_id TEXT, retried_at INTEGER NOT NULL, retried_by TEXT NOT NULL,
          PRIMARY KEY (host, job_id)
        );
        `)
      }
    }).pipe(Effect.mapError((cause) => new NeedsYouStoreError({ operation: "open", cause }))),
    (resource) => Effect.sync(() => resource.database.close())
  )
  const database = opened.database
  const write = <A>(operation: string, run: () => A) =>
    Effect.try({
      try: () => {
        database.exec("BEGIN IMMEDIATE")
        try {
          const result = run()
          database.exec("COMMIT")
          return result
        } catch (cause) {
          database.exec("ROLLBACK")
          throw cause
        }
      },
      catch: (cause) => new NeedsYouStoreError({ operation, cause })
    }).pipe(
      Effect.tap(() =>
        opened.secureFiles.pipe(Effect.mapError((cause) => new NeedsYouStoreError({ operation, cause })))
      )
    )

  const dismiss = Effect.fn("NeedsYouStore.dismiss")(function*(key: FleetJobKey, person: string) {
    const now = yield* Clock.currentTimeMillis
    yield* write("dismiss", () => {
      database.prepare(
        "INSERT OR IGNORE INTO dismissed (host, job_id, dismissed_at, dismissed_by) VALUES (?, ?, ?, ?)"
      ).run(key.host, key.jobId, now, person)
    })
  })

  const claimRetry = Effect.fn("NeedsYouStore.claimRetry")(function*(key: FleetJobKey, person: string) {
    const now = yield* Clock.currentTimeMillis
    const held = yield* write("retry.claim", (): typeof RetryRow.Type | null => {
      const existing = database.prepare("SELECT retry_job_id, retried_at FROM retried WHERE host = ? AND job_id = ?")
        .get(key.host, key.jobId)
      if (existing === undefined) {
        database.prepare(
          "INSERT INTO retried (host, job_id, retry_job_id, retried_at, retried_by) VALUES (?, ?, NULL, ?, ?)"
        )
          .run(key.host, key.jobId, now, person)
        return null
      }
      const row = Schema.decodeUnknownSync(RetryRow)(existing)
      if (row.retry_job_id === null && row.retried_at <= now - retryClaimStaleMillis) {
        database.prepare("UPDATE retried SET retried_at = ?, retried_by = ? WHERE host = ? AND job_id = ?")
          .run(now, person, key.host, key.jobId)
        return null
      }
      return row
    })
    if (held !== null) return yield* new RetryAlreadyClaimed({ retryJobId: held.retry_job_id })
  })

  const fillRetry = Effect.fn("NeedsYouStore.fillRetry")(function*(key: FleetJobKey, retryJobId: string) {
    yield* write("retry.fill", () => {
      database.prepare("UPDATE retried SET retry_job_id = ? WHERE host = ? AND job_id = ?")
        .run(retryJobId, key.host, key.jobId)
    })
  })

  const releaseRetry = Effect.fn("NeedsYouStore.releaseRetry")(function*(key: FleetJobKey) {
    yield* write("retry.release", () => {
      database.prepare("DELETE FROM retried WHERE host = ? AND job_id = ? AND retry_job_id IS NULL")
        .run(key.host, key.jobId)
    })
  })

  const settled = Effect.fn("NeedsYouStore.settled")(function*(keys: ReadonlyArray<FleetJobKey>) {
    if (keys.length === 0) return new Set<string>()
    const rows = yield* Effect.try({
      try: () => {
        const placeholders = keys.map(() => "(?, ?)").join(", ")
        const values = keys.flatMap(({ host, jobId }) => [host, jobId])
        return database.prepare(
          `WITH wanted (host, job_id) AS (VALUES ${placeholders})
           SELECT w.host, w.job_id FROM wanted w
           WHERE EXISTS (SELECT 1 FROM dismissed d WHERE d.host = w.host COLLATE NOCASE AND d.job_id = w.job_id)
              OR EXISTS (SELECT 1 FROM retried r WHERE r.host = w.host COLLATE NOCASE AND r.job_id = w.job_id
                         AND r.retry_job_id IS NOT NULL)`
        ).all(...values)
      },
      catch: (cause) => new NeedsYouStoreError({ operation: "settled", cause })
    })
    const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(KeyRow))(rows).pipe(
      Effect.mapError((cause) => new NeedsYouStoreError({ operation: "settled", cause }))
    )
    return new Set(decoded.map(({ host, job_id }) => fleetJobKey({ host, jobId: job_id })))
  })

  const store: NeedsYouStore = { dismiss, claimRetry, fillRetry, releaseRetry, settled }
  return store
})
