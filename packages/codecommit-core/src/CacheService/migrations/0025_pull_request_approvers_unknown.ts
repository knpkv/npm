import * as Effect from "effect/Effect"
import * as SqlClient from "effect/sql/SqlClient"

/**
 * Whether the last approver read failed (1): `approved_by` then holds only the last known approvers.
 * Before this column a revoked approver was never cleared and a failed read kept the old list, so every
 * existing row starts unknown: an open row until the next refresh re-reads it, a merged or closed one
 * until the refresh's capped repair pass does. Every new write states it.
 */
export default Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql`ALTER TABLE pull_requests ADD COLUMN approvers_unknown INTEGER NOT NULL DEFAULT 0`.pipe(
      Effect.andThen(sql`UPDATE pull_requests SET approvers_unknown = 1`)
    )
)
