import * as Effect from "effect/Effect"
import * as SqlClient from "effect/sql/SqlClient"

/**
 * The version at which a pull request's row was deleted. An insert observed at that version or
 * earlier is a no-op, so a slower read of a pull request that is gone can't bring its row back; a
 * listing newer than the deletion still can. A tombstone expires by `deleted_at`, the cache clock,
 * since its `version` is provider activity and can be years old.
 */
export default Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql`CREATE TABLE IF NOT EXISTS pull_request_tombstones (
      aws_account_id TEXT NOT NULL,
      id TEXT NOT NULL,
      repository_name TEXT NOT NULL,
      account_region TEXT NOT NULL,
      version TEXT NOT NULL,
      -- When the row was deleted, on the cache clock: tombstones expire by it, like fetched_at.
      deleted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      PRIMARY KEY (aws_account_id, id, repository_name, account_region)
    )`
)
