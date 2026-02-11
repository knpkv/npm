import * as SqlClient from "@effect/sql/SqlClient"
import * as SqlSchema from "@effect/sql/SqlSchema"
import { Effect, Schema } from "effect"
import { flow } from "effect/Function"
import { DatabaseLive } from "../Database.js"

const CachedPullRequest = Schema.Struct({
  id: Schema.String,
  awsAccountId: Schema.String,
  accountProfile: Schema.String,
  accountRegion: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  author: Schema.String,
  repositoryName: Schema.String,
  creationDate: Schema.String,
  lastModifiedDate: Schema.String,
  status: Schema.String,
  sourceBranch: Schema.String,
  destinationBranch: Schema.String,
  isMergeable: Schema.Number,
  isApproved: Schema.Number,
  commentCount: Schema.NullOr(Schema.Number),
  link: Schema.String,
  fetchedAt: Schema.String
})

export type CachedPullRequest = typeof CachedPullRequest.Type

const UpsertInput = Schema.Struct({
  id: Schema.String,
  awsAccountId: Schema.String,
  accountProfile: Schema.String,
  accountRegion: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  author: Schema.String,
  repositoryName: Schema.String,
  creationDate: Schema.String,
  lastModifiedDate: Schema.String,
  status: Schema.String,
  sourceBranch: Schema.String,
  destinationBranch: Schema.String,
  isMergeable: Schema.Number,
  isApproved: Schema.Number,
  commentCount: Schema.NullOr(Schema.Number),
  link: Schema.String
})

export type UpsertInput = typeof UpsertInput.Type

export class PullRequestRepo extends Effect.Service<PullRequestRepo>()("PullRequestRepo", {
  dependencies: [DatabaseLive],
  effect: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    const selectCols = sql`
      id, aws_account_id AS "awsAccountId", account_profile AS "accountProfile",
      account_region AS "accountRegion", title, description, author,
      repository_name AS "repositoryName", creation_date AS "creationDate",
      last_modified_date AS "lastModifiedDate", status,
      source_branch AS "sourceBranch", destination_branch AS "destinationBranch",
      is_mergeable AS "isMergeable", is_approved AS "isApproved",
      comment_count AS "commentCount", link, fetched_at AS "fetchedAt"
    `

    const findAll = SqlSchema.findAll({
      Result: CachedPullRequest,
      Request: Schema.Void,
      execute: () => sql`SELECT ${selectCols} FROM pull_requests ORDER BY creation_date DESC`
    })

    const findByAccountAndId = SqlSchema.findOne({
      Result: CachedPullRequest,
      Request: Schema.Struct({ awsAccountId: Schema.String, id: Schema.String }),
      execute: (req) =>
        sql`
        SELECT ${selectCols} FROM pull_requests
        WHERE aws_account_id = ${req.awsAccountId} AND id = ${req.id}
      `
    })

    const upsert = SqlSchema.void({
      Request: UpsertInput,
      execute: (req) =>
        sql`INSERT OR REPLACE INTO pull_requests
          (id, aws_account_id, account_profile, account_region, title, description,
           author, repository_name, creation_date, last_modified_date, status,
           source_branch, destination_branch, is_mergeable, is_approved,
           comment_count, link, fetched_at)
          VALUES (${req.id}, ${req.awsAccountId}, ${req.accountProfile}, ${req.accountRegion},
            ${req.title}, ${req.description}, ${req.author}, ${req.repositoryName},
            ${req.creationDate}, ${req.lastModifiedDate}, ${req.status},
            ${req.sourceBranch}, ${req.destinationBranch}, ${req.isMergeable}, ${req.isApproved},
            ${req.commentCount}, ${req.link}, datetime('now'))`
    })

    const search = SqlSchema.findAll({
      Result: CachedPullRequest,
      Request: Schema.Struct({ query: Schema.String }),
      execute: (req) =>
        sql`
        SELECT ${selectCols} FROM pull_requests
        JOIN pull_requests_fts fts ON pull_requests.rowid = fts.rowid
        WHERE pull_requests_fts MATCH ${req.query}
        ORDER BY rank
      `
    })

    const deleteStale = SqlSchema.void({
      Request: Schema.Struct({ olderThan: Schema.String }),
      execute: (req) => sql`DELETE FROM pull_requests WHERE fetched_at < ${req.olderThan}`
    })

    return {
      findAll: flow(findAll, Effect.orDie),
      findByAccountAndId: (awsAccountId: string, id: string) =>
        findByAccountAndId({ awsAccountId, id }).pipe(Effect.orDie),
      upsert: flow(upsert, Effect.orDie),
      upsertMany: (prs: ReadonlyArray<UpsertInput>) =>
        Effect.forEach(prs, (pr) => upsert(pr), { discard: true }).pipe(Effect.orDie),
      search: (query: string) => search({ query }).pipe(Effect.orDie),
      deleteStale: (olderThan: string) => deleteStale({ olderThan }).pipe(Effect.orDie)
    } as const
  })
}) {}
