/** @effect-diagnostics strictEffectProvide:skip-file */

import * as NodeServices from "@effect/platform-node/NodeServices"
import * as LibsqlClient from "@effect/sql-libsql/LibsqlClient"
import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer, Predicate, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import migration0018 from "../src/CacheService/migrations/0018_pull_request_coordinates.js"
import migration0019 from "../src/CacheService/migrations/0019_dependent_pr_coordinates.js"
import migration0020 from "../src/CacheService/migrations/0020_notification_coordinates.js"
import { UpsertInput } from "../src/CacheService/repos/PullRequestRepo/internal.js"
import { mutations } from "../src/CacheService/repos/PullRequestRepo/mutations.js"

const insertPullRequest = (
  sql: SqlClient.SqlClient,
  repositoryName: string,
  region: string
) =>
  sql`INSERT INTO pull_requests (
    id, aws_account_id, account_profile, account_region, title, author,
    repository_name, creation_date, last_modified_date, status,
    source_branch, destination_branch, link
  ) VALUES (
    '42', '123456789012', 'production', ${region}, 'Review', 'author',
    ${repositoryName}, '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z',
    'OPEN', 'feature', 'main', 'https://example.invalid/pr/42'
  )`

const upsertInput = (repositoryName: string, region: string, title: string, id = "42") =>
  Schema.decodeSync(UpsertInput)({
    id,
    awsAccountId: "123456789012",
    repoAccountId: null,
    accountProfile: "production",
    accountRegion: region,
    title,
    description: null,
    author: "author",
    repositoryName,
    creationDate: "2026-08-01T00:00:00.000Z",
    lastModifiedDate: "2026-08-02T00:00:00.000Z",
    status: "OPEN",
    sourceBranch: "feature",
    destinationBranch: "main",
    isMergeable: 1,
    isApproved: 0,
    commentCount: 0,
    link: "https://example.invalid/pr/42",
    approvedBy: [],
    approvedByArns: [],
    approvalRules: []
  })

describe("pull request coordinate migration", () => {
  it.effect("keeps duplicate account and PR ids distinct by repository and region", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codecommit-pr-coordinates-" })
      const context = yield* Layer.build(LibsqlClient.layer({ url: `file:${root}/cache.db` }))
      const sql = Context.get(context, SqlClient.SqlClient)

      yield* sql`CREATE TABLE pull_requests (
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
        PRIMARY KEY (aws_account_id, id)
      )`
      yield* insertPullRequest(sql, "payments", "eu-west-1")
      yield* migration0018.pipe(Effect.provideService(SqlClient.SqlClient, sql))
      yield* insertPullRequest(sql, "orders", "us-east-1")
      const repo = mutations(sql, Effect.void)
      yield* repo.upsert(upsertInput("orders", "us-east-1", "Orders updated"))
      yield* repo.upsert(upsertInput("payments", "eu-west-1", "Payments updated"))
      yield* repo.upsert(upsertInput("orders", "us-east-1", "Another orders PR", "43"))
      yield* sql`UPDATE pull_requests SET repo_account_id = 'repository-account'
        WHERE aws_account_id = '123456789012' AND id = '42'
          AND repository_name = 'orders' AND account_region = 'us-east-1'`
      yield* repo.propagateRepoAccountId()
      const propagated = yield* sql<{ readonly repoAccountId: string | null }>`
        SELECT repo_account_id AS repoAccountId FROM pull_requests
        WHERE aws_account_id = '123456789012' AND id = '43'
          AND repository_name = 'orders' AND account_region = 'us-east-1'`
      expect(propagated).toEqual([{ repoAccountId: "repository-account" }])

      const rows = yield* sql<
        { readonly repositoryName: string; readonly accountRegion: string; readonly title: string }
      >`
        SELECT repository_name AS repositoryName, account_region AS accountRegion, title
        FROM pull_requests
        WHERE aws_account_id = '123456789012' AND id = '42'
        ORDER BY repository_name
      `
      expect(rows).toEqual([
        { repositoryName: "orders", accountRegion: "us-east-1", title: "Orders updated" },
        { repositoryName: "payments", accountRegion: "eu-west-1", title: "Payments updated" }
      ])

      const ambiguous = yield* repo.updateHealthScore("123456789012", "42", 0.5).pipe(Effect.flip)
      expect(Predicate.isTagged(ambiguous, "CacheError")).toBe(true)
      if (Predicate.isTagged(ambiguous, "CacheError")) {
        expect(Predicate.isTagged(ambiguous.cause, "PullRequestAmbiguityError")).toBe(true)
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("keeps comment and subscription caches independently addressable by coordinates", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codecommit-dependent-coordinates-" })
      const context = yield* Layer.build(LibsqlClient.layer({ url: `file:${root}/cache.db` }))
      const sql = Context.get(context, SqlClient.SqlClient)

      yield* sql`CREATE TABLE pr_comments (
        pull_request_id TEXT NOT NULL,
        aws_account_id TEXT NOT NULL,
        locations_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (aws_account_id, pull_request_id)
      )`
      yield* sql`CREATE TABLE pr_subscriptions (
        pull_request_id TEXT NOT NULL,
        aws_account_id TEXT NOT NULL,
        subscribed_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (aws_account_id, pull_request_id)
      )`
      yield* sql`CREATE TABLE pull_requests (
        id TEXT NOT NULL,
        aws_account_id TEXT NOT NULL,
        repository_name TEXT NOT NULL,
        account_region TEXT NOT NULL,
        author TEXT NOT NULL,
        repo_account_id TEXT,
        commented_by TEXT,
        PRIMARY KEY (aws_account_id, id, repository_name, account_region)
      )`
      yield* sql`INSERT INTO pr_comments (pull_request_id, aws_account_id, locations_json)
        VALUES ('42', '123456789012', 'legacy'),
               ('43', '123456789012', 'legacy-single')`
      yield* sql`INSERT INTO pr_subscriptions (pull_request_id, aws_account_id)
        VALUES ('42', '123456789012'),
               ('43', '123456789012')`
      yield* sql`INSERT INTO pull_requests
        (id, aws_account_id, repository_name, account_region, author)
        VALUES ('42', '123456789012', 'payments', 'eu-west-1', 'author'),
               ('42', '123456789012', 'orders', 'us-east-1', 'author'),
               ('43', '123456789012', 'single', 'eu-west-1', 'author')`
      yield* migration0019.pipe(Effect.provideService(SqlClient.SqlClient, sql))

      const migratedSingle = yield* sql<{
        readonly repositoryName: string
        readonly accountRegion: string
      }>`SELECT repository_name AS repositoryName, account_region AS accountRegion
        FROM pr_subscriptions WHERE pull_request_id = '43'`
      expect(migratedSingle).toEqual([{ repositoryName: "single", accountRegion: "eu-west-1" }])

      yield* sql`INSERT OR REPLACE INTO pr_comments
        (pull_request_id, aws_account_id, repository_name, account_region, locations_json)
        VALUES ('42', '123456789012', '', '', 'legacy-replaced')`
      yield* sql`INSERT OR IGNORE INTO pr_comments
        (pull_request_id, aws_account_id, repository_name, account_region, locations_json)
        VALUES ('42', '123456789012', '', '', 'ignored-legacy-duplicate')`
      yield* sql`INSERT OR IGNORE INTO pr_subscriptions
        (pull_request_id, aws_account_id, repository_name, account_region)
        VALUES ('42', '123456789012', '', '')`

      const paymentComments = JSON.stringify([{
        comments: [{
          root: {
            id: "payment-comment",
            content: "Payment review",
            author: "payment-reviewer",
            creationDate: "2026-08-03T00:00:00.000Z",
            deleted: false
          },
          replies: []
        }]
      }])
      const orderComments = JSON.stringify([{
        comments: [{
          root: {
            id: "order-comment",
            content: "Order review",
            author: "order-reviewer",
            creationDate: "2026-08-03T00:00:00.000Z",
            deleted: false
          },
          replies: []
        }]
      }])

      yield* sql`INSERT OR REPLACE INTO pr_comments
        (pull_request_id, aws_account_id, repository_name, account_region, locations_json)
        VALUES ('42', '123456789012', 'payments', 'eu-west-1', 'payments-comments')`
      yield* sql`INSERT OR REPLACE INTO pr_comments
        (pull_request_id, aws_account_id, repository_name, account_region, locations_json)
        VALUES ('42', '123456789012', 'orders', 'us-east-1', 'orders-comments')`
      yield* sql`INSERT OR REPLACE INTO pr_subscriptions
        (pull_request_id, aws_account_id, repository_name, account_region)
        VALUES ('42', '123456789012', 'payments', 'eu-west-1')`
      yield* sql`INSERT OR REPLACE INTO pr_comments
        (pull_request_id, aws_account_id, repository_name, account_region, locations_json)
        VALUES ('42', '123456789012', 'payments', 'eu-west-1', ${paymentComments})`
      yield* sql`INSERT OR REPLACE INTO pr_comments
        (pull_request_id, aws_account_id, repository_name, account_region, locations_json)
        VALUES ('42', '123456789012', 'orders', 'us-east-1', ${orderComments})`
      yield* sql`INSERT OR REPLACE INTO pr_comments
        (pull_request_id, aws_account_id, repository_name, account_region, locations_json)
        VALUES ('43', '123456789012', 'single', 'eu-west-1', ${orderComments})`
      yield* mutations(sql, Effect.void).refreshCommentedBy()

      const comments = yield* sql<{ readonly repositoryName: string | null; readonly locationsJson: string }>`
        SELECT repository_name AS repositoryName, locations_json AS locationsJson
        FROM pr_comments WHERE aws_account_id = '123456789012' AND pull_request_id = '42'
        ORDER BY repository_name IS NOT NULL, repository_name`
      const subscriptions = yield* sql<{
        readonly repositoryName: string | null
        readonly accountRegion: string | null
      }>`
        SELECT repository_name AS repositoryName, account_region AS accountRegion
        FROM pr_subscriptions WHERE aws_account_id = '123456789012' AND pull_request_id = '42'
        ORDER BY repository_name IS NOT NULL, repository_name`

      expect(comments).toEqual([
        { repositoryName: "", locationsJson: "legacy-replaced" },
        { repositoryName: "orders", locationsJson: orderComments },
        { repositoryName: "payments", locationsJson: paymentComments }
      ])
      expect(subscriptions).toEqual([
        { repositoryName: "", accountRegion: "" },
        { repositoryName: "payments", accountRegion: "eu-west-1" }
      ])
      const commentedBy = yield* sql<{
        readonly repositoryName: string
        readonly commentedBy: string | null
      }>`SELECT repository_name AS repositoryName, commented_by AS commentedBy
        FROM pull_requests ORDER BY repository_name`
      expect(commentedBy).toEqual([
        { repositoryName: "orders", commentedBy: "order-reviewer" },
        { repositoryName: "payments", commentedBy: "payment-reviewer" },
        { repositoryName: "single", commentedBy: "order-reviewer" }
      ])
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("fails notification migration when the schema operation is not duplicate-column idempotence", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codecommit-notification-migration-" })
      const context = yield* Layer.build(LibsqlClient.layer({ url: `file:${root}/cache.db` }))
      const sql = Context.get(context, SqlClient.SqlClient)

      const missingTable = yield* migration0020.pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.result
      )
      expect(missingTable._tag).toBe("Failure")

      yield* sql`CREATE TABLE notifications (id INTEGER PRIMARY KEY)`
      yield* migration0020.pipe(Effect.provideService(SqlClient.SqlClient, sql))
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(notifications)`
      expect(columns.map((column) => column.name)).toEqual(["id", "repository_name", "account_region"])
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))
})
