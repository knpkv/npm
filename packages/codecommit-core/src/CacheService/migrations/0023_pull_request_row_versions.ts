import * as Effect from "effect/Effect"
import * as SqlClient from "effect/sql/SqlClient"

/**
 * Row versions for `pull_requests`: (`last_modified_date`, `observation_seq`), compared in that
 * order. `observation_seq` comes from `observation_sequence`, incremented once per read before the
 * provider call, so two reads of the same provider revision are still ordered by when they began.
 *
 * `pull_request_tombstones` keeps the version at which a row was deleted: an insert observed at or
 * before it is a no-op, so a slower read can't bring a deleted pull request back, while a newer one
 * can. A tombstone expires by `deleted_at`, the cache clock.
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.all([
    sql`ALTER TABLE pull_requests ADD COLUMN observation_seq INTEGER NOT NULL DEFAULT 0`,
    sql`CREATE TABLE IF NOT EXISTS observation_sequence (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      value INTEGER NOT NULL
    )`,
    sql`INSERT OR IGNORE INTO observation_sequence (id, value) VALUES (1, 0)`,
    sql`CREATE TABLE IF NOT EXISTS pull_request_tombstones (
      aws_account_id TEXT NOT NULL,
      id TEXT NOT NULL,
      repository_name TEXT NOT NULL,
      account_region TEXT NOT NULL,
      version TEXT NOT NULL,
      observation_seq INTEGER NOT NULL,
      -- When the row was deleted, on the cache clock: tombstones expire by it, like fetched_at.
      deleted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      PRIMARY KEY (aws_account_id, id, repository_name, account_region)
    )`
  ], { discard: true }))
