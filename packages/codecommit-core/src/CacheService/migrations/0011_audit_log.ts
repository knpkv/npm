import * as SqlClient from "@effect/sql/SqlClient"
import * as Effect from "effect/Effect"

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
      sql`CREATE INDEX IF NOT EXISTS idx_audit_log_operation ON audit_log(operation)`
    ]).pipe(Effect.asVoid, Effect.catchAll(() => Effect.void))
)
