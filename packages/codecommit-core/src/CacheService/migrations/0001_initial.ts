import * as SqlClient from "@effect/sql/SqlClient"
import * as Effect from "effect/Effect"

export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.all([
    sql`CREATE TABLE IF NOT EXISTS pull_requests (
      id TEXT NOT NULL,
      aws_account_id TEXT NOT NULL,
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
      PRIMARY KEY (aws_account_id, id)
    )`,

    sql`CREATE TABLE IF NOT EXISTS pr_comments (
      pull_request_id TEXT NOT NULL,
      aws_account_id TEXT NOT NULL,
      locations_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (aws_account_id, pull_request_id)
    )`,

    sql`CREATE TABLE IF NOT EXISTS pr_subscriptions (
      pull_request_id TEXT NOT NULL,
      aws_account_id TEXT NOT NULL,
      subscribed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (aws_account_id, pull_request_id)
    )`,

    sql`CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pull_request_id TEXT NOT NULL,
      aws_account_id TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      read INTEGER NOT NULL DEFAULT 0
    )`,

    sql`CREATE TABLE IF NOT EXISTS sync_metadata (
      account_id TEXT NOT NULL,
      account_region TEXT NOT NULL,
      last_synced_at TEXT NOT NULL,
      PRIMARY KEY (account_id, account_region)
    )`,

    sql`CREATE VIRTUAL TABLE IF NOT EXISTS pull_requests_fts USING fts5(
      title, description, author, repository_name,
      content='pull_requests', content_rowid='rowid'
    )`,

    sql`CREATE TRIGGER IF NOT EXISTS pull_requests_ai AFTER INSERT ON pull_requests BEGIN
      INSERT INTO pull_requests_fts(rowid, title, description, author, repository_name)
      VALUES (new.rowid, new.title, new.description, new.author, new.repository_name);
    END`,

    sql`CREATE TRIGGER IF NOT EXISTS pull_requests_ad AFTER DELETE ON pull_requests BEGIN
      INSERT INTO pull_requests_fts(pull_requests_fts, rowid, title, description, author, repository_name)
      VALUES ('delete', old.rowid, old.title, old.description, old.author, old.repository_name);
    END`,

    sql`CREATE TRIGGER IF NOT EXISTS pull_requests_au AFTER UPDATE ON pull_requests BEGIN
      INSERT INTO pull_requests_fts(pull_requests_fts, rowid, title, description, author, repository_name)
      VALUES ('delete', old.rowid, old.title, old.description, old.author, old.repository_name);
      INSERT INTO pull_requests_fts(rowid, title, description, author, repository_name)
      VALUES (new.rowid, new.title, new.description, new.author, new.repository_name);
    END`
  ], { discard: true }))
