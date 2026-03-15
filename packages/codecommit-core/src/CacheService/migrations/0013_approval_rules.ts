import * as SqlClient from "@effect/sql/SqlClient"
import * as Effect from "effect/Effect"

export default Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql`ALTER TABLE pull_requests ADD COLUMN approval_rules TEXT DEFAULT '[]'`.pipe(
      Effect.asVoid,
      Effect.catchAll(() => Effect.void)
    )
)
