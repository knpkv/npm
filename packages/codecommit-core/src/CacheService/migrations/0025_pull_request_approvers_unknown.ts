import * as Effect from "effect/Effect"
import * as SqlClient from "effect/sql/SqlClient"

/**
 * Whether the last approver read failed (1): `approved_by` then holds only the last known approvers.
 * Every existing row was written before approver reads could fail visibly, so it starts known.
 */
export default Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`ALTER TABLE pull_requests ADD COLUMN approvers_unknown INTEGER NOT NULL DEFAULT 0`
)
