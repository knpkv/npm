import * as Effect from "effect/Effect"
import * as SqlClient from "effect/sql/SqlClient"

/**
 * Whether `is_approved` came from a successful evaluation (1), or is the placeholder a pull request
 * first seen while its evaluation failed is stored with (0). Recovery from an unknown approval is
 * announced only over a known baseline. An unknown row not approved may hold a placeholder, so it
 * starts unknown; an unknown approved row kept an earlier successful evaluation (placeholders are
 * stored unapproved), and every other row was evaluated.
 */
export default Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql`ALTER TABLE pull_requests ADD COLUMN approval_baseline_known INTEGER NOT NULL DEFAULT 1`.pipe(
      Effect.andThen(
        sql`UPDATE pull_requests SET approval_baseline_known = 0 WHERE approval_unknown_reason IS NOT NULL AND is_approved = 0`
      )
    )
)
