import * as SqlClient from "@effect/sql/SqlClient"
import * as Effect from "effect/Effect"

export default Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    Effect.all([
      sql`ALTER TABLE sandboxes ADD COLUMN status_detail TEXT`,
      sql`ALTER TABLE sandboxes ADD COLUMN logs TEXT`
    ]).pipe(Effect.asVoid)
)
