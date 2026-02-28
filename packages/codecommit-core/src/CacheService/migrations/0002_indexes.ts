import * as SqlClient from "@effect/sql/SqlClient"
import * as Effect from "effect/Effect"

export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.all([
    sql`CREATE INDEX IF NOT EXISTS idx_pr_creation_date ON pull_requests(creation_date DESC)`,
    sql`CREATE INDEX IF NOT EXISTS idx_notif_read_created ON notifications(read, created_at DESC)`
  ], { discard: true }))
