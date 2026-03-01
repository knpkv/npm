import * as SqlClient from "@effect/sql/SqlClient"
import * as Effect from "effect/Effect"

export default Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    Effect.all([
      sql`CREATE TABLE IF NOT EXISTS sandboxes (
        id TEXT PRIMARY KEY,
        pull_request_id TEXT NOT NULL,
        aws_account_id TEXT NOT NULL,
        repository_name TEXT NOT NULL,
        source_branch TEXT NOT NULL,
        container_id TEXT,
        port INTEGER,
        workspace_path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'creating',
        error TEXT,
        created_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL
      )`,
      sql`CREATE INDEX IF NOT EXISTS idx_sandboxes_pr
        ON sandboxes(aws_account_id, pull_request_id)`,
      sql`CREATE INDEX IF NOT EXISTS idx_sandboxes_status
        ON sandboxes(status)`
    ]).pipe(Effect.asVoid)
)
