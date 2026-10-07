import * as Effect from "effect/Effect"
import * as SqlClient from "effect/sql/SqlClient"

export default Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    Effect.all([
      sql`ALTER TABLE pull_requests ADD COLUMN files_added INTEGER`.pipe(
        // ast-grep-ignore: no-silent-catch-all -- follow-up: silent fallback; fail with a typed error, log it, or mark it best-effort
        Effect.catchIf(() => true, () => Effect.void)
      ),
      sql`ALTER TABLE pull_requests ADD COLUMN files_modified INTEGER`.pipe(
        // ast-grep-ignore: no-silent-catch-all -- follow-up: silent fallback; fail with a typed error, log it, or mark it best-effort
        Effect.catchIf(() => true, () => Effect.void)
      ),
      sql`ALTER TABLE pull_requests ADD COLUMN files_deleted INTEGER`.pipe(
        // ast-grep-ignore: no-silent-catch-all -- follow-up: silent fallback; fail with a typed error, log it, or mark it best-effort
        Effect.catchIf(() => true, () => Effect.void)
      ),
      sql`ALTER TABLE pull_requests ADD COLUMN closed_at TEXT`.pipe(
        // ast-grep-ignore: no-silent-catch-all -- follow-up: silent fallback; fail with a typed error, log it, or mark it best-effort
        Effect.catchIf(() => true, () => Effect.void)
      ),
      sql`CREATE INDEX IF NOT EXISTS idx_pr_creation_date ON pull_requests(creation_date)`,
      sql`CREATE INDEX IF NOT EXISTS idx_pr_status ON pull_requests(status)`,
      sql`CREATE INDEX IF NOT EXISTS idx_pr_author ON pull_requests(author)`,
      sql`CREATE INDEX IF NOT EXISTS idx_pr_last_modified ON pull_requests(last_modified_date)`
    ]).pipe(Effect.asVoid)
)
