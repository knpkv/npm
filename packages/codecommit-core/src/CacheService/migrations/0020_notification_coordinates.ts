import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlError from "effect/unstable/sql/SqlError"

/** Only an already-present column is safe to treat as migration idempotence. */
const isDuplicateColumnError: Predicate.Refinement<unknown, SqlError.SqlError> = (
  error
): error is SqlError.SqlError => {
  if (!SqlError.isSqlError(error)) return false
  const reasonMessage = error.reason.message
  if (reasonMessage !== undefined && /duplicate column name/i.test(reasonMessage)) return true
  const cause = error.reason.cause
  return Predicate.hasProperty(cause, "message") &&
    Predicate.isString(cause.message) &&
    /duplicate column name/i.test(cause.message)
}

/** Add exact PR coordinates to notifications while retaining legacy rows as unqualified. */
export default Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    Effect.all([
      sql`ALTER TABLE notifications ADD COLUMN repository_name TEXT NOT NULL DEFAULT ''`.pipe(
        Effect.catchIf(isDuplicateColumnError, () => Effect.void)
      ),
      sql`ALTER TABLE notifications ADD COLUMN account_region TEXT NOT NULL DEFAULT ''`.pipe(
        Effect.catchIf(isDuplicateColumnError, () => Effect.void)
      )
    ]).pipe(Effect.asVoid)
)
