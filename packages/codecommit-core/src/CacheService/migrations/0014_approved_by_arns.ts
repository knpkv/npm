import * as SqlClient from "@effect/sql/SqlClient"
import * as Effect from "effect/Effect"

export default Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql`ALTER TABLE pull_requests ADD COLUMN approved_by_arns TEXT`.pipe(
      Effect.asVoid,
      Effect.catchAll(() => Effect.void)
    )
)
