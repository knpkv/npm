import * as SqlClient from "@effect/sql/SqlClient"
import * as Effect from "effect/Effect"

export default Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    Effect.all([
      sql`ALTER TABLE pull_requests ADD COLUMN files_added INTEGER`.pipe(
        Effect.catchAll(() => Effect.void)
      ),
      sql`ALTER TABLE pull_requests ADD COLUMN files_modified INTEGER`.pipe(
        Effect.catchAll(() => Effect.void)
      ),
      sql`ALTER TABLE pull_requests ADD COLUMN files_deleted INTEGER`.pipe(
        Effect.catchAll(() => Effect.void)
      ),
      sql`ALTER TABLE pull_requests ADD COLUMN closed_at TEXT`.pipe(
        Effect.catchAll(() => Effect.void)
      ),
      sql`CREATE INDEX IF NOT EXISTS idx_pr_creation_date ON pull_requests(creation_date)`,
      sql`CREATE INDEX IF NOT EXISTS idx_pr_status ON pull_requests(status)`,
      sql`CREATE INDEX IF NOT EXISTS idx_pr_author ON pull_requests(author)`,
      sql`CREATE INDEX IF NOT EXISTS idx_pr_last_modified ON pull_requests(last_modified_date)`
    ]).pipe(Effect.asVoid)
)
