import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/** Persist the provider region so same-id sandboxes cannot be reused across regions. */
export default Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`ALTER TABLE sandboxes ADD COLUMN region TEXT NOT NULL DEFAULT ''`.pipe(Effect.asVoid)
)
