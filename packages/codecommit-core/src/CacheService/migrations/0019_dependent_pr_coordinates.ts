import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/** Backfill uniquely attributable dependent rows while retaining ambiguous/orphan sentinels. */
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
    ) SELECT pull_request_id, aws_account_id,
      CASE WHEN (SELECT count(*) FROM pull_requests p
        WHERE p.aws_account_id = pr_comments.aws_account_id AND p.id = pr_comments.pull_request_id) = 1
        THEN (SELECT p.repository_name FROM pull_requests p
          WHERE p.aws_account_id = pr_comments.aws_account_id AND p.id = pr_comments.pull_request_id)
        ELSE '' END,
      CASE WHEN (SELECT count(*) FROM pull_requests p
        WHERE p.aws_account_id = pr_comments.aws_account_id AND p.id = pr_comments.pull_request_id) = 1
        THEN (SELECT p.account_region FROM pull_requests p
          WHERE p.aws_account_id = pr_comments.aws_account_id AND p.id = pr_comments.pull_request_id)
        ELSE '' END,
      locations_json, fetched_at
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
    ) SELECT pull_request_id, aws_account_id,
      CASE WHEN (SELECT count(*) FROM pull_requests p
        WHERE p.aws_account_id = pr_subscriptions.aws_account_id AND p.id = pr_subscriptions.pull_request_id) = 1
        THEN (SELECT p.repository_name FROM pull_requests p
          WHERE p.aws_account_id = pr_subscriptions.aws_account_id AND p.id = pr_subscriptions.pull_request_id)
        ELSE '' END,
      CASE WHEN (SELECT count(*) FROM pull_requests p
        WHERE p.aws_account_id = pr_subscriptions.aws_account_id AND p.id = pr_subscriptions.pull_request_id) = 1
        THEN (SELECT p.account_region FROM pull_requests p
          WHERE p.aws_account_id = pr_subscriptions.aws_account_id AND p.id = pr_subscriptions.pull_request_id)
        ELSE '' END,
      subscribed_at
      FROM pr_subscriptions`
    yield* sql`DROP TABLE pr_subscriptions`
    yield* sql`ALTER TABLE pr_subscriptions_coordinates_new RENAME TO pr_subscriptions`
  }))
