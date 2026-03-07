/**
 * @module PullRequestRepo/queries
 *
 * Read-only SQL queries. Each function takes `sql` (SqlClient) and returns
 * the query implementation for the PullRequestRepo service.
 *
 * @category CacheService
 */
import type * as SqlClient from "@effect/sql/SqlClient"
import * as SqlSchema from "@effect/sql/SqlSchema"
import { Effect, Option, Schema } from "effect"
import { AwsProfileName, AwsRegion } from "../../../Domain.js"
import type { CacheError } from "../../CacheError.js"
import {
  type CachedPullRequest,
  CachedPullRequest as CachedPullRequestSchema,
  cacheError,
  type SearchResult
} from "./internal.js"

const StaleOpenRow = Schema.Struct({
  id: Schema.String,
  awsAccountId: Schema.String,
  accountProfile: AwsProfileName,
  accountRegion: AwsRegion
})

export const findAll = (sql: SqlClient.SqlClient) => {
  const run = SqlSchema.findAll({
    Result: CachedPullRequestSchema,
    Request: Schema.Void,
    execute: () => sql`SELECT * FROM pull_requests ORDER BY creation_date DESC`
  })
  return () => run(undefined as void).pipe(cacheError("findAll"))
}

export const findMissingDiffStats = (sql: SqlClient.SqlClient) => {
  const run = SqlSchema.findAll({
    Result: CachedPullRequestSchema,
    Request: Schema.Void,
    execute: () => sql`SELECT * FROM pull_requests WHERE files_added IS NULL ORDER BY creation_date DESC`
  })
  return () => run(undefined as void).pipe(cacheError("findMissingDiffStats"))
}

export const findByAccountAndId = (sql: SqlClient.SqlClient) => {
  const run = SqlSchema.findOne({
    Result: CachedPullRequestSchema,
    Request: Schema.Struct({ awsAccountId: Schema.String, id: Schema.String }),
    execute: (req) =>
      sql`SELECT * FROM pull_requests
          WHERE aws_account_id = ${req.awsAccountId} AND id = ${req.id}`
  })
  return (awsAccountId: string, id: string) => run({ awsAccountId, id }).pipe(cacheError("findByAccountAndId"))
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
  ): Effect.Effect<SearchResult, CacheError> => {
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
      Effect.catchTag("SqlError", () =>
        Effect.logWarning("FTS search failed").pipe(
          Effect.as({ items: [] as ReadonlyArray<CachedPullRequest>, total: 0, hasMore: false })
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
      sql`SELECT id, aws_account_id, account_profile, account_region
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
      sql`SELECT id, aws_account_id, account_profile, account_region
          FROM pull_requests
          WHERE status = 'OPEN'
            AND (
              (creation_date >= ${req.weekStart} AND creation_date < ${req.weekEnd})
              OR (last_modified_date >= ${req.weekStart} AND last_modified_date < ${req.weekEnd})
            )`
  })
  return (weekStart: string, weekEnd: string) => run({ weekStart, weekEnd }).pipe(cacheError("findOpenInRange"))
}
