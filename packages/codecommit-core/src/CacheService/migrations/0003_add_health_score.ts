import * as SqlClient from "@effect/sql/SqlClient"
import * as Effect from "effect/Effect"

export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.all([
    sql`ALTER TABLE pull_requests ADD COLUMN health_score REAL`
  ], { discard: true }))
