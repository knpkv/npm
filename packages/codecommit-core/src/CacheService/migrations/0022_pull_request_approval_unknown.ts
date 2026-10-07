import * as Effect from "effect/Effect"
import * as SqlClient from "effect/sql/SqlClient"

/**
 * Why the last approval evaluation failed, as the reason's tag; NULL when it succeeded. While set,
 * `is_approved` is only the last known value.
 */
export default Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`ALTER TABLE pull_requests ADD COLUMN approval_unknown_reason TEXT`
)
