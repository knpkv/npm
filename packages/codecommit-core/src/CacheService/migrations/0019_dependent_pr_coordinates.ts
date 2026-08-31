import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/** Preserve legacy comment/subscription rows as explicitly unqualified while allowing exact rows. */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.gen(function*() {
    yield* sql`CREATE TABLE pr_comments_coordinates_new (
      pull_request_id TEXT NOT NULL,
      aws_account_id TEXT NOT NULL,
      repository_name TEXT NOT NULL DEFAULT '',
      account_region TEXT NOT NULL DEFAULT '',
      locations_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (aws_account_id, pull_request_id, repository_name, account_region)
    )`
    yield* sql`INSERT INTO pr_comments_coordinates_new (
      pull_request_id, aws_account_id, repository_name, account_region, locations_json, fetched_at
    ) SELECT pull_request_id, aws_account_id, '', '', locations_json, fetched_at
      FROM pr_comments`
    yield* sql`DROP TABLE pr_comments`
    yield* sql`ALTER TABLE pr_comments_coordinates_new RENAME TO pr_comments`

    yield* sql`CREATE TABLE pr_subscriptions_coordinates_new (
      pull_request_id TEXT NOT NULL,
      aws_account_id TEXT NOT NULL,
      repository_name TEXT NOT NULL DEFAULT '',
      account_region TEXT NOT NULL DEFAULT '',
      subscribed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (aws_account_id, pull_request_id, repository_name, account_region)
    )`
    yield* sql`INSERT INTO pr_subscriptions_coordinates_new (
      pull_request_id, aws_account_id, repository_name, account_region, subscribed_at
    ) SELECT pull_request_id, aws_account_id, '', '', subscribed_at
      FROM pr_subscriptions`
    yield* sql`DROP TABLE pr_subscriptions`
    yield* sql`ALTER TABLE pr_subscriptions_coordinates_new RENAME TO pr_subscriptions`
  }))
