import * as SqlClient from "@effect/sql/SqlClient"
import * as Effect from "effect/Effect"

export default Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    Effect.all([
      sql`CREATE INDEX IF NOT EXISTS idx_audit_log_permission_state ON audit_log(permission_state)`,
      sql`CREATE INDEX IF NOT EXISTS idx_audit_log_account_profile ON audit_log(account_profile)`
    ]).pipe(Effect.asVoid, Effect.catchAll(() => Effect.void))
)
