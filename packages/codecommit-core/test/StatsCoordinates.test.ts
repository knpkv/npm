/** @effect-diagnostics strictEffectProvide:skip-file */

import * as NodeServices from "@effect/platform-node/NodeServices"
import * as LibsqlClient from "@effect/sql-libsql/LibsqlClient"
import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { reviewerData } from "../src/CacheService/repos/StatsRepo/reviewerData.js"

const comments = (id: string, author: string): string =>
  JSON.stringify([{
    comments: [{
      root: {
        id,
        content: "Review",
        author,
        creationDate: "2026-08-03T00:00:00.000Z",
        deleted: false
      },
      replies: []
    }]
  }])

describe("stats pull-request coordinates", () => {
  it.effect("attributes comments to the matching repository and region", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codecommit-stats-coordinates-" })
      const context = yield* Layer.build(LibsqlClient.layer({
        url: `file:${root}/stats.db`,
        transformResultNames: (name: string) =>
          name.replace(/_([a-z])/g, (_, character: string) => character.toUpperCase())
      }))
      const sql = Context.get(context, SqlClient.SqlClient)

      yield* sql`CREATE TABLE pull_requests (
        id TEXT NOT NULL,
        title TEXT NOT NULL,
        author TEXT NOT NULL,
        aws_account_id TEXT NOT NULL,
        repository_name TEXT NOT NULL,
        account_region TEXT NOT NULL,
        creation_date TEXT NOT NULL,
        closed_at TEXT,
        last_modified_date TEXT NOT NULL,
        is_approved INTEGER NOT NULL,
        status TEXT NOT NULL,
        merged_by TEXT,
        approved_by TEXT
      )`
      yield* sql`CREATE TABLE pr_comments (
        pull_request_id TEXT NOT NULL,
        aws_account_id TEXT NOT NULL,
        repository_name TEXT NOT NULL,
        account_region TEXT NOT NULL,
        locations_json TEXT NOT NULL
      )`
      yield* sql`INSERT INTO pull_requests
        (id, title, author, aws_account_id, repository_name, account_region,
         creation_date, closed_at, last_modified_date, is_approved, status)
        VALUES
          ('42', 'Payments', 'author', '123', 'payments', 'eu-west-1',
           '2026-08-01T00:00:00.000Z', NULL, '2026-08-04T00:00:00.000Z', 0, 'MERGED'),
          ('42', 'Orders', 'author', '123', 'orders', 'us-east-1',
           '2026-08-01T00:00:00.000Z', NULL, '2026-08-04T00:00:00.000Z', 0, 'MERGED'),
          ('43', 'Legacy', 'author', '123', 'legacy', 'eu-west-1',
           '2026-08-01T00:00:00.000Z', NULL, '2026-08-04T00:00:00.000Z', 0, 'MERGED')`
      yield* sql`INSERT INTO pr_comments
        (pull_request_id, aws_account_id, repository_name, account_region, locations_json)
        VALUES
          ('42', '123', 'payments', 'eu-west-1', ${comments("payment-comment", "payment-reviewer")}),
          ('42', '123', 'orders', 'us-east-1', ${comments("order-comment", "order-reviewer")}),
          ('43', '123', '', '', ${comments("legacy-comment", "legacy-reviewer")})`

      const result = yield* reviewerData(sql)("2026-08-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z", {})
      expect(result.topReviewers).toEqual(expect.arrayContaining([
        { author: "payment-reviewer", commentCount: 1 },
        { author: "order-reviewer", commentCount: 1 },
        { author: "legacy-reviewer", commentCount: 1 }
      ]))
      expect(result.firstReviewDetails).toEqual(expect.arrayContaining([
        expect.objectContaining({ prId: "42", repositoryName: "payments", accountRegion: "eu-west-1" }),
        expect.objectContaining({ prId: "42", repositoryName: "orders", accountRegion: "us-east-1" })
      ]))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))
})
