import * as SqlClient from "@effect/sql/SqlClient"
import * as SqlSchema from "@effect/sql/SqlSchema"
import { Effect, Option, Schema } from "effect"
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

export interface SearchResult {
  readonly items: ReadonlyArray<CachedPullRequest>
  readonly total: number
  readonly hasMore: boolean
}

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
        sql`INSERT INTO pull_requests
          (id, aws_account_id, account_profile, account_region, title, description,
           author, repository_name, creation_date, last_modified_date, status,
           source_branch, destination_branch, is_mergeable, is_approved,
           comment_count, link, fetched_at)
          VALUES (${req.id}, ${req.awsAccountId}, ${req.accountProfile}, ${req.accountRegion},
            ${req.title}, ${req.description}, ${req.author}, ${req.repositoryName},
            ${req.creationDate}, ${req.lastModifiedDate}, ${req.status},
            ${req.sourceBranch}, ${req.destinationBranch}, ${req.isMergeable}, ${req.isApproved},
            ${req.commentCount}, ${req.link}, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
          ON CONFLICT (aws_account_id, id) DO UPDATE SET
            account_profile = excluded.account_profile,
            account_region = excluded.account_region,
            title = excluded.title,
            description = excluded.description,
            author = excluded.author,
            repository_name = excluded.repository_name,
            creation_date = excluded.creation_date,
            last_modified_date = excluded.last_modified_date,
            status = excluded.status,
            source_branch = excluded.source_branch,
            destination_branch = excluded.destination_branch,
            is_mergeable = excluded.is_mergeable,
            is_approved = excluded.is_approved,
            comment_count = COALESCE(excluded.comment_count, pull_requests.comment_count),
            health_score = COALESCE(excluded.health_score, pull_requests.health_score),
            link = excluded.link,
            fetched_at = excluded.fetched_at`
    })

    const search_ = SqlSchema.findAll({
      Result: CachedPullRequest,
      Request: Schema.Struct({ query: Schema.String, limit: Schema.Number, offset: Schema.Number }),
      execute: (req) =>
        sql`
        SELECT ${selectCols} FROM pull_requests
        JOIN pull_requests_fts fts ON pull_requests.rowid = fts.rowid
        WHERE pull_requests_fts MATCH ${req.query}
        ORDER BY rank
        LIMIT ${req.limit} OFFSET ${req.offset}
      `
    })

    const searchCount_ = SqlSchema.findOne({
      Result: Schema.Struct({ count: Schema.Number }),
      Request: Schema.Struct({ query: Schema.String }),
      execute: (req) =>
        sql`
        SELECT count(*) as count FROM pull_requests
        JOIN pull_requests_fts fts ON pull_requests.rowid = fts.rowid
        WHERE pull_requests_fts MATCH ${req.query}
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
      search: (
        query: string,
        opts?: { readonly limit?: number; readonly offset?: number }
      ): Effect.Effect<SearchResult> => {
        const limit = opts?.limit ?? 20
        const offset = opts?.offset ?? 0
        const stripped = query.replace(/[*^"]/g, "").replace(/\b(NEAR|OR|NOT|AND)\b/gi, "")
        const escaped = stripped.replace(/"/g, `""`)
        const ftsQuery = `"${escaped}"`
        return Effect.all({
          items: search_({ query: ftsQuery, limit, offset }),
          total: searchCount_({ query: ftsQuery }).pipe(
            Effect.map((r) => r.pipe(Option.getOrElse(() => ({ count: 0 }))).count)
          )
        }).pipe(
          Effect.map(({ items, total }) => ({ items, total, hasMore: offset + items.length < total })),
          Effect.catchAll(() => Effect.succeed({ items: [], total: 0, hasMore: false }))
        )
      },
      deleteStale: (olderThan: string) => deleteStale_({ olderThan }).pipe(Effect.tap(() => publish), Effect.orDie),
      updateCommentCount: (awsAccountId: string, id: string, count: number | null) =>
        updateCommentCount_(awsAccountId, id, count).pipe(Effect.tap(() => publish), Effect.orDie),
      updateHealthScore: (awsAccountId: string, id: string, score: number) =>
        updateHealthScore_(awsAccountId, id, score).pipe(Effect.tap(() => publish), Effect.orDie)
    } as const
  })
}) {}
