import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

export default Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    Effect.all([
      sql`CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        operation TEXT NOT NULL,
        account_profile TEXT NOT NULL DEFAULT '',
        region TEXT NOT NULL DEFAULT '',
        permission_state TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        duration_ms INTEGER
      )`,
      sql`CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp)`,
      sql`CREATE INDEX IF NOT EXISTS idx_audit_log_operation ON audit_log(operation)`,
      sql`CREATE INDEX IF NOT EXISTS idx_audit_log_permission_state ON audit_log(permission_state)`,
      sql`CREATE INDEX IF NOT EXISTS idx_audit_log_account_profile ON audit_log(account_profile)`
    ]).pipe(Effect.asVoid, Effect.catchIf(() => true, () => Effect.void))
)
