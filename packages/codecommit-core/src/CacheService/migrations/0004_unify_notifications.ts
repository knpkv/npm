import * as SqlClient from "@effect/sql/SqlClient"
import * as Effect from "effect/Effect"

export default Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    Effect.all([
      sql`ALTER TABLE notifications ADD COLUMN title TEXT NOT NULL DEFAULT ''`.pipe(
        Effect.catchAll(() => Effect.void)
      ),
      sql`ALTER TABLE notifications ADD COLUMN profile TEXT NOT NULL DEFAULT ''`.pipe(
        Effect.catchAll(() => Effect.void)
      )
    ]).pipe(Effect.asVoid)
)
