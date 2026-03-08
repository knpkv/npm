import * as SqlClient from "@effect/sql/SqlClient"
import * as Effect from "effect/Effect"

export default Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql`ALTER TABLE pull_requests ADD COLUMN merged_by TEXT`.pipe(
      Effect.catchAll(() => Effect.void)
    )
)
