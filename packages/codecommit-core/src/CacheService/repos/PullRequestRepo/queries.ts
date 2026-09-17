/**
 * @module PullRequestRepo/queries
 *
 * Read-only SQL queries. Each function takes `sql` (SqlClient) and returns
 * the query implementation for the PullRequestRepo service.
 *
 * @category CacheService
 */
import { Data, Effect, Option, Predicate, Schema } from "effect"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlSchema from "effect/unstable/sql/SqlSchema"
import { AwsProfileName, AwsRegion } from "../../../Domain.js"
import { CacheError } from "../../CacheError.js"
import { CachedPullRequest as CachedPullRequestSchema, cacheError, type SearchResult } from "./internal.js"

/** Coordinate-free lookup is unsafe once one account can contain duplicate PR IDs. */
export class PullRequestAmbiguityError extends Data.TaggedError("PullRequestAmbiguityError")<{
  readonly awsAccountId: string
  readonly pullRequestId: string
  readonly matches: number
}> {}

const StaleOpenRow = Schema.Struct({
  id: Schema.String,
  awsAccountId: Schema.String,
  repositoryName: Schema.String,
  accountProfile: AwsProfileName,
  accountRegion: AwsRegion
})

export const findAll = (sql: SqlClient.SqlClient) => {
  const run = SqlSchema.findAll({
    Result: CachedPullRequestSchema,
    Request: Schema.Void,
    execute: () => sql`SELECT * FROM pull_requests ORDER BY creation_date DESC`
  })
  const voidRequest: void = undefined
  return () => run(voidRequest).pipe(cacheError("findAll"))
}

export const findMissingDiffStats = (sql: SqlClient.SqlClient) => {
  const run = SqlSchema.findAll({
    Result: CachedPullRequestSchema,
    Request: Schema.Void,
    execute: () => sql`SELECT * FROM pull_requests WHERE files_added IS NULL ORDER BY creation_date DESC`
  })
  const voidRequest: void = undefined
  return () => run(voidRequest).pipe(cacheError("findMissingDiffStats"))
}

export const findByAccountAndId = (sql: SqlClient.SqlClient) => {
  const run = SqlSchema.findAll({
    Result: CachedPullRequestSchema,
    Request: Schema.Struct({ awsAccountId: Schema.String, id: Schema.String }),
    execute: (req) =>
      sql`SELECT * FROM pull_requests
          WHERE aws_account_id = ${req.awsAccountId} AND id = ${req.id}`
  })
  return (awsAccountId: string, id: string) =>
    run({ awsAccountId, id }).pipe(
      Effect.flatMap((rows) => {
        const [first, ...duplicates] = rows
        return duplicates.length > 0
          ? Effect.fail(
            new PullRequestAmbiguityError({
              awsAccountId,
              pullRequestId: id,
              matches: rows.length
            })
          )
          : Effect.succeed(first === undefined ? undefined : first)
      }),
      Effect.map((row) =>
        row === undefined
          ? Option.none<typeof CachedPullRequestSchema.Type>()
          : Option.some(row)
      ),
      Effect.mapError((cause) =>
        Predicate.isTagged(cause, "PullRequestAmbiguityError")
          ? cause
          : new CacheError({ operation: "PullRequestRepo.findByAccountAndId", cause })
      ),
      Effect.withSpan("PullRequestRepo.findByAccountAndId")
    )
}

export const findByCoordinates = (sql: SqlClient.SqlClient) => {
  const run = SqlSchema.findOneOption({
    Result: CachedPullRequestSchema,
    Request: Schema.Struct({
      awsAccountId: Schema.String,
      id: Schema.String,
      repositoryName: Schema.String,
      accountRegion: Schema.String
    }),
    execute: (req) =>
      sql`SELECT * FROM pull_requests
          WHERE aws_account_id = ${req.awsAccountId}
            AND id = ${req.id}
            AND repository_name = ${req.repositoryName}
            AND account_region = ${req.accountRegion}`
  })
  return (awsAccountId: string, id: string, repositoryName: string, accountRegion: string) =>
    run({ awsAccountId, id, repositoryName, accountRegion }).pipe(cacheError("findByCoordinates"))
}

export const search = (sql: SqlClient.SqlClient) => {
  const search_ = SqlSchema.findAll({
    Result: CachedPullRequestSchema,
    Request: Schema.Struct({ query: Schema.String, limit: Schema.Number, offset: Schema.Number }),
    execute: (req) =>
      sql`SELECT pull_requests.* FROM pull_requests
          JOIN pull_requests_fts fts ON pull_requests.rowid = fts.rowid
          WHERE pull_requests_fts MATCH ${req.query}
          ORDER BY rank
          LIMIT ${req.limit} OFFSET ${req.offset}`
  })

  const searchCount_ = SqlSchema.findOne({
    Result: Schema.Struct({ count: Schema.Number }),
    Request: Schema.Struct({ query: Schema.String }),
    execute: (req) =>
      sql`SELECT count(*) as count FROM pull_requests
          JOIN pull_requests_fts fts ON pull_requests.rowid = fts.rowid
          WHERE pull_requests_fts MATCH ${req.query}`
  })

  return (
    query: string,
    opts?: { readonly limit?: number; readonly offset?: number }
  ): Effect.Effect<SearchResult, CacheError, never> => {
    const limit = opts?.limit ?? 20
    const offset = opts?.offset ?? 0
    const stripped = query.replace(/[*^"]/g, "").replace(/\b(NEAR|OR|NOT|AND)\b/gi, "")
    const escaped = stripped.replace(/"/g, `""`)
    const ftsQuery = `"${escaped}"`
    const emptySearchResult: SearchResult = { items: [], total: 0, hasMore: false }
    return Effect.all({
      items: search_({ query: ftsQuery, limit, offset }),
      total: searchCount_({ query: ftsQuery }).pipe(
        Effect.map((r) => r.count)
      )
    }).pipe(
      Effect.map(({ items, total }) => ({ items, total, hasMore: offset + items.length < total })),
      Effect.catchTag("SqlError", () =>
        Effect.logWarning("FTS search failed").pipe(
          Effect.as(emptySearchResult)
        )),
      cacheError("search")
    )
  }
}

export const findStaleOpen = (sql: SqlClient.SqlClient) => {
  const run = SqlSchema.findAll({
    Result: StaleOpenRow,
    Request: Schema.Struct({ olderThan: Schema.String }),
    execute: (req) =>
      sql`SELECT id, aws_account_id, repository_name, account_profile, account_region
          FROM pull_requests
          WHERE status = 'OPEN' AND fetched_at < ${req.olderThan}`
  })
  return (olderThan: string) => run({ olderThan }).pipe(cacheError("findStaleOpen"))
}

export const findOpenInRange = (sql: SqlClient.SqlClient) => {
  const run = SqlSchema.findAll({
    Result: StaleOpenRow,
    Request: Schema.Struct({ weekStart: Schema.String, weekEnd: Schema.String }),
    execute: (req) =>
      sql`SELECT id, aws_account_id, repository_name, account_profile, account_region
          FROM pull_requests
          WHERE status = 'OPEN'
            AND (
              (creation_date >= ${req.weekStart} AND creation_date < ${req.weekEnd})
              OR (last_modified_date >= ${req.weekStart} AND last_modified_date < ${req.weekEnd})
            )`
  })
  return (weekStart: string, weekEnd: string) => run({ weekStart, weekEnd }).pipe(cacheError("findOpenInRange"))
}
