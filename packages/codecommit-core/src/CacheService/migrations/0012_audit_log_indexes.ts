import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

export default Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    Effect.all([
      sql`CREATE INDEX IF NOT EXISTS idx_audit_log_permission_state ON audit_log(permission_state)`,
      sql`CREATE INDEX IF NOT EXISTS idx_audit_log_account_profile ON audit_log(account_profile)`
    ]).pipe(Effect.asVoid, Effect.catchIf(() => true, () => Effect.void))
)
