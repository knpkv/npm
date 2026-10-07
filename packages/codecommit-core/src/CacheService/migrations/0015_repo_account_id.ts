import * as Effect from "effect/Effect"
import * as SqlClient from "effect/sql/SqlClient"

export default Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql`ALTER TABLE pull_requests ADD COLUMN repo_account_id TEXT`.pipe(
      Effect.asVoid,
      // ast-grep-ignore: no-silent-catch-all -- follow-up: silent fallback; fail with a typed error, log it, or mark it best-effort
      Effect.catchIf(() => true, () => Effect.void)
    )
)
