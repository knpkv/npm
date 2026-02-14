import * as SqlClient from "@effect/sql/SqlClient"
import * as SqlSchema from "@effect/sql/SqlSchema"
import { Effect, Schema } from "effect"
import { AwsProfileName, AwsRegion, PullRequestId, PullRequestStatus, RepositoryName } from "../../Domain.js"
import { DatabaseLive } from "../Database.js"
import { EventsHub } from "../EventsHub.js"

const BooleanFromNumber = Schema.transform(
  Schema.Number,
  Schema.Boolean,
  { strict: true, decode: (n) => n === 1, encode: (b) => (b ? 1 : 0) }
)

export const CachedPullRequest = Schema.Struct({
  id: PullRequestId,
  awsAccountId: Schema.String,
  accountProfile: AwsProfileName,
  accountRegion: AwsRegion,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  author: Schema.String,
  repositoryName: RepositoryName,
  creationDate: Schema.DateFromString,
  lastModifiedDate: Schema.DateFromString,
  status: PullRequestStatus,
  sourceBranch: Schema.String,
  destinationBranch: Schema.String,
  isMergeable: BooleanFromNumber,
  isApproved: BooleanFromNumber,
  commentCount: Schema.NullOr(Schema.Number),
  healthScore: Schema.NullOr(Schema.Number),
  link: Schema.String,
  fetchedAt: Schema.String
})

export type CachedPullRequest = typeof CachedPullRequest.Type

export const UpsertInput = Schema.Struct({
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
  dependencies: [DatabaseLive, EventsHub.Default],
  effect: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const hub = yield* EventsHub

    const selectCols = sql`
      id, aws_account_id AS "awsAccountId", account_profile AS "accountProfile",
      account_region AS "accountRegion", title, description, author,
      repository_name AS "repositoryName", creation_date AS "creationDate",
      last_modified_date AS "lastModifiedDate", status,
      source_branch AS "sourceBranch", destination_branch AS "destinationBranch",
      is_mergeable AS "isMergeable", is_approved AS "isApproved",
      comment_count AS "commentCount", health_score AS "healthScore",
      link, fetched_at AS "fetchedAt"
    `

    const findAll_ = SqlSchema.findAll({
      Result: CachedPullRequest,
      Request: Schema.Void,
      execute: () => sql`SELECT ${selectCols} FROM pull_requests ORDER BY creation_date DESC`
    })

    const findByAccountAndId_ = SqlSchema.findOne({
      Result: CachedPullRequest,
      Request: Schema.Struct({ awsAccountId: Schema.String, id: Schema.String }),
      execute: (req) =>
        sql`
        SELECT ${selectCols} FROM pull_requests
        WHERE aws_account_id = ${req.awsAccountId} AND id = ${req.id}
      `
    })

    const upsert_ = SqlSchema.void({
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

    const search_ = SqlSchema.findAll({
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

    const deleteStale_ = SqlSchema.void({
      Request: Schema.Struct({ olderThan: Schema.String }),
      execute: (req) => sql`DELETE FROM pull_requests WHERE fetched_at < ${req.olderThan}`
    })

    const updateCommentCount_ = (awsAccountId: string, id: string, count: number | null) =>
      sql`UPDATE pull_requests SET comment_count = ${count}
          WHERE id = ${id} AND aws_account_id = ${awsAccountId}`.pipe(Effect.asVoid)

    const updateHealthScore_ = (awsAccountId: string, id: string, score: number) =>
      sql`UPDATE pull_requests SET health_score = ${score}
          WHERE id = ${id} AND aws_account_id = ${awsAccountId}`.pipe(Effect.asVoid)

    const upsertMany_ = (prs: ReadonlyArray<UpsertInput>) =>
      sql.withTransaction(Effect.forEach(prs, (pr) => upsert_(pr), { discard: true }))

    const publish = hub.publish({ _tag: "PullRequests" })

    return {
      findAll: () => findAll_(undefined as void).pipe(Effect.orDie),
      findByAccountAndId: (awsAccountId: string, id: string) =>
        findByAccountAndId_({ awsAccountId, id }).pipe(Effect.orDie),
      upsert: (input: UpsertInput) => upsert_(input).pipe(Effect.tap(() => publish), Effect.orDie),
      upsertMany: (prs: ReadonlyArray<UpsertInput>) => upsertMany_(prs).pipe(Effect.tap(() => publish), Effect.orDie),
      search: (query: string) => {
        const escaped = query.replace(/"/g, `""`)
        return search_({ query: `"${escaped}"` }).pipe(
          Effect.catchAll(() => Effect.succeed([]))
        )
      },
      deleteStale: (olderThan: string) => deleteStale_({ olderThan }).pipe(Effect.tap(() => publish), Effect.orDie),
      updateCommentCount: (awsAccountId: string, id: string, count: number | null) =>
        updateCommentCount_(awsAccountId, id, count).pipe(Effect.tap(() => publish), Effect.orDie),
      updateHealthScore: (awsAccountId: string, id: string, score: number) =>
        updateHealthScore_(awsAccountId, id, score).pipe(Effect.orDie)
    } as const
  })
}) {}
