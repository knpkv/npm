import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/** Re-key cached PR rows so repository and region are part of durable identity. */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.gen(function*() {
    yield* sql`DROP TRIGGER IF EXISTS pull_requests_ai`
    yield* sql`DROP TRIGGER IF EXISTS pull_requests_ad`
    yield* sql`DROP TRIGGER IF EXISTS pull_requests_au`
    yield* sql`DROP TABLE IF EXISTS pull_requests_fts`
    yield* sql`CREATE TABLE pull_requests_coordinates_new (
      id TEXT NOT NULL,
      aws_account_id TEXT NOT NULL,
      repo_account_id TEXT,
      account_profile TEXT NOT NULL,
      account_region TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      author TEXT NOT NULL,
      repository_name TEXT NOT NULL,
      creation_date TEXT NOT NULL,
      last_modified_date TEXT NOT NULL,
      status TEXT NOT NULL,
      source_branch TEXT NOT NULL,
      destination_branch TEXT NOT NULL,
      is_mergeable INTEGER NOT NULL DEFAULT 0,
      is_approved INTEGER NOT NULL DEFAULT 0,
      comment_count INTEGER,
      link TEXT NOT NULL,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
      files_added INTEGER,
      files_modified INTEGER,
      files_deleted INTEGER,
      health_score REAL,
      closed_at TEXT,
      merged_by TEXT,
      approved_by TEXT,
      commented_by TEXT,
      approval_rules TEXT DEFAULT '[]',
      approved_by_arns TEXT,
      PRIMARY KEY (aws_account_id, id, repository_name, account_region)
    )`
    yield* sql`INSERT INTO pull_requests_coordinates_new (
      id, aws_account_id, repo_account_id, account_profile, account_region,
      title, description, author, repository_name, creation_date,
      last_modified_date, status, source_branch, destination_branch,
      is_mergeable, is_approved, comment_count, link, fetched_at,
      files_added, files_modified, files_deleted, health_score, closed_at, merged_by,
      approved_by, commented_by, approval_rules, approved_by_arns
    ) SELECT
      id, aws_account_id, repo_account_id, account_profile, account_region,
      title, description, author, repository_name, creation_date,
      last_modified_date, status, source_branch, destination_branch,
      is_mergeable, is_approved, comment_count, link, fetched_at,
      files_added, files_modified, files_deleted, health_score, closed_at, merged_by,
      approved_by, commented_by, approval_rules, approved_by_arns
      FROM pull_requests`
    yield* sql`DROP TABLE pull_requests`
    yield* sql`ALTER TABLE pull_requests_coordinates_new RENAME TO pull_requests`
    yield* sql`CREATE INDEX IF NOT EXISTS idx_pr_creation_date ON pull_requests(creation_date)`
    yield* sql`CREATE INDEX IF NOT EXISTS idx_pr_status ON pull_requests(status)`
    yield* sql`CREATE INDEX IF NOT EXISTS idx_pr_author ON pull_requests(author)`
    yield* sql`CREATE INDEX IF NOT EXISTS idx_pr_last_modified ON pull_requests(last_modified_date)`
    yield* sql`CREATE VIRTUAL TABLE pull_requests_fts USING fts5(
      title, description, author, repository_name,
      content='pull_requests', content_rowid='rowid'
    )`
    yield* sql`CREATE TRIGGER pull_requests_ai AFTER INSERT ON pull_requests BEGIN
      INSERT INTO pull_requests_fts(rowid, title, description, author, repository_name)
      VALUES (new.rowid, new.title, new.description, new.author, new.repository_name);
    END`
    yield* sql`CREATE TRIGGER pull_requests_ad AFTER DELETE ON pull_requests BEGIN
      INSERT INTO pull_requests_fts(pull_requests_fts, rowid, title, description, author, repository_name)
      VALUES ('delete', old.rowid, old.title, old.description, old.author, old.repository_name);
    END`
    yield* sql`CREATE TRIGGER pull_requests_au AFTER UPDATE ON pull_requests BEGIN
      INSERT INTO pull_requests_fts(pull_requests_fts, rowid, title, description, author, repository_name)
      VALUES ('delete', old.rowid, old.title, old.description, old.author, old.repository_name);
      INSERT INTO pull_requests_fts(rowid, title, description, author, repository_name)
      VALUES (new.rowid, new.title, new.description, new.author, new.repository_name);
    END`
    yield* sql`INSERT INTO pull_requests_fts(pull_requests_fts) VALUES ('rebuild')`
  }))
