import { Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/** Bind pagination semantics and successful health evidence to committed sync pages. */
export const migration0006PluginSyncPageEvidence = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE plugin_sync_pages
    ADD COLUMN has_more INTEGER NOT NULL DEFAULT 0 CHECK(has_more IN (0, 1))`
  yield* sql`ALTER TABLE plugin_sync_pages
    ADD COLUMN successful_health_json TEXT
      CHECK(successful_health_json IS NULL OR length(successful_health_json) BETWEEN 2 AND 2048)`
  yield* sql`ALTER TABLE plugin_sync_pages
    ADD COLUMN successful_health_digest TEXT
      CHECK(
        (successful_health_digest IS NULL) = (successful_health_json IS NULL) AND
        (successful_health_digest IS NULL OR (
          length(successful_health_digest) = 64 AND successful_health_digest NOT GLOB '*[^0-9a-f]*'
        ))
      )`
})
