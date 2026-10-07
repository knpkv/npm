import * as Effect from "effect/Effect"
import * as SqlClient from "effect/sql/SqlClient"

/**
 * Whether the last approver read failed (1): `approved_by` then holds only the last known approvers.
 * Before this column a revoked approver was never cleared and a failed read kept the old list, so an
 * open row starts unknown until the next refresh re-reads it. A merged or closed row is never re-read:
 * its list stays as recorded, history rather than a current claim. Every new write states it.
 */
export default Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql`ALTER TABLE pull_requests ADD COLUMN approvers_unknown INTEGER NOT NULL DEFAULT 0`.pipe(
      Effect.andThen(sql`UPDATE pull_requests SET approvers_unknown = 1 WHERE status = 'OPEN'`)
    )
)
