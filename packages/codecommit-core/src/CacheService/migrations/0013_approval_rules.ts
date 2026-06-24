import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

export default Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql`ALTER TABLE pull_requests ADD COLUMN approval_rules TEXT DEFAULT '[]'`.pipe(
      Effect.asVoid,
      Effect.catchIf(() => true, () => Effect.void)
    )
)
