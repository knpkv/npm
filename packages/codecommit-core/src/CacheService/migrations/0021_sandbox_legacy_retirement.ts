import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/** Persist the retirement boundary so a recreated service cannot restart a migrated legacy row. */
export default Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`ALTER TABLE sandboxes ADD COLUMN legacy_retired_at TEXT`
)
