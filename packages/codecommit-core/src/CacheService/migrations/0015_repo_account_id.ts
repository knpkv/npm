import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

export default Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql`ALTER TABLE pull_requests ADD COLUMN repo_account_id TEXT`.pipe(
      Effect.asVoid,
      Effect.catchIf(() => true, () => Effect.void)
    )
)
