/** @effect-diagnostics strictEffectProvide:skip-file */

import * as NodeServices from "@effect/platform-node/NodeServices"
import * as LibsqlClient from "@effect/sql-libsql/LibsqlClient"
import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import migration0018 from "../src/CacheService/migrations/0018_pull_request_coordinates.js"
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

const upsertInput = (repositoryName: string, region: string, title: string) =>
  Schema.decodeSync(UpsertInput)({
    id: "42",
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
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))
})
