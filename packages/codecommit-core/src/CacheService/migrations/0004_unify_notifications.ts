import * as Effect from "effect/Effect"
import * as SqlClient from "effect/sql/SqlClient"

export default Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    Effect.all([
      sql`ALTER TABLE notifications ADD COLUMN title TEXT NOT NULL DEFAULT ''`.pipe(
        // ast-grep-ignore: no-silent-catch-all -- follow-up: silent fallback; fail with a typed error, log it, or mark it best-effort
        Effect.catchIf(() => true, () => Effect.void)
      ),
      sql`ALTER TABLE notifications ADD COLUMN profile TEXT NOT NULL DEFAULT ''`.pipe(
        // ast-grep-ignore: no-silent-catch-all -- follow-up: silent fallback; fail with a typed error, log it, or mark it best-effort
        Effect.catchIf(() => true, () => Effect.void)
      )
    ]).pipe(Effect.asVoid)
)
