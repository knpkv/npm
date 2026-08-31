import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/** Add exact PR coordinates to notifications while retaining legacy rows as unqualified. */
export default Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    Effect.all([
      sql`ALTER TABLE notifications ADD COLUMN repository_name TEXT NOT NULL DEFAULT ''`.pipe(
        Effect.catchIf(() => true, () => Effect.void)
      ),
      sql`ALTER TABLE notifications ADD COLUMN account_region TEXT NOT NULL DEFAULT ''`.pipe(
        Effect.catchIf(() => true, () => Effect.void)
      )
    ]).pipe(Effect.asVoid)
)
