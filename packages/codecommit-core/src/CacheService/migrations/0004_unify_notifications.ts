import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

export default Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    Effect.all([
      sql`ALTER TABLE notifications ADD COLUMN title TEXT NOT NULL DEFAULT ''`.pipe(
        Effect.catchIf(() => true, () => Effect.void)
      ),
      sql`ALTER TABLE notifications ADD COLUMN profile TEXT NOT NULL DEFAULT ''`.pipe(
        Effect.catchIf(() => true, () => Effect.void)
      )
    ]).pipe(Effect.asVoid)
)
