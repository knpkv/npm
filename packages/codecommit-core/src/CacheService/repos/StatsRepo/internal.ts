/**
 * @module StatsRepo/internal
 *
 * Shared types, row interfaces, and helpers used across the StatsRepo query modules.
 * Everything here is pure (no SQL dependency) except `whereFilters` which takes `sql`.
 *
 * @category CacheService
 */
import type * as SqlClient from "@effect/sql/SqlClient"
import { Effect, Schema } from "effect"
import { PRCommentLocationJson } from "../../../Domain.js"
import { CacheError } from "../../CacheError.js"

// ---------------------------------------------------------------------------
// Row types for SQL query results
// ---------------------------------------------------------------------------

export interface VolumeRow {
  readonly prsCreated: number
  readonly prsMerged: number
  readonly prsClosed: number
}

export interface ContributorRow {
  readonly author: string
  readonly prCount: number
}

export interface ActivePRRow {
  readonly id: string
  readonly title: string
  readonly author: string
  readonly repositoryName: string
  readonly commentCount: number | null
  readonly awsAccountId: string
}

export interface SizeDistributionRow {
  readonly small: number
  readonly medium: number
  readonly large: number
  readonly extraLarge: number
}

export interface AvgDiffRow {
  readonly avgAdded: number | null
  readonly avgModified: number | null
  readonly avgDeleted: number | null
}

export interface DiffByContributorRow {
  readonly author: string
  readonly avgFilesChanged: number
  readonly prCount: number
}

export interface StalePRRow {
  readonly id: string
  readonly title: string
  readonly author: string
  readonly repositoryName: string
  readonly daysSinceActivity: number
  readonly awsAccountId: string
}

export interface HealthRow {
  readonly total: number
  readonly withComments: number
  readonly approved: number
}

export interface FilterOptionsRow {
  readonly repos: string
  readonly authors: string
  readonly accounts: string
}

export interface CommentRow {
  readonly pullRequestId: string
  readonly awsAccountId: string
  readonly locationsJson: string
}

export interface PRForReviewRow {
  readonly id: string
  readonly title: string
  readonly approvedBy: string | null
  readonly author: string
  readonly awsAccountId: string
  readonly creationDate: string
  readonly closedAt: string | null
  readonly lastModifiedDate: string
  readonly isApproved: number
  readonly mergedBy: string | null
  readonly repositoryName: string
  readonly status: string
}

export interface MergeTimeDetailRow {
  readonly id: string
  readonly title: string
  readonly author: string
  readonly repositoryName: string
  readonly awsAccountId: string
  readonly creationDate: string
  readonly lastModifiedDate: string
  readonly durationMs: number
}

export interface EarliestRow {
  readonly earliest: string | null
}

export interface CommentInfo {
  readonly author: string
  readonly creationDate: Date
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const LocationsFromJson = Schema.parseJson(Schema.Array(PRCommentLocationJson))

export const cacheError = (op: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) => new CacheError({ operation: `StatsRepo.${op}`, cause })),
    Effect.withSpan(`StatsRepo.${op}`, { captureStackTrace: false })
  )

export const extractComments = (
  locations: ReadonlyArray<typeof PRCommentLocationJson.Type>
): ReadonlyArray<CommentInfo> => {
  const result: Array<CommentInfo> = []
  const walk = (threads: ReadonlyArray<typeof PRCommentLocationJson.Type["comments"][number]>) => {
    for (const t of threads) {
      result.push({ author: t.root.author, creationDate: new Date(t.root.creationDate) })
      walk(t.replies)
    }
  }
  for (const loc of locations) {
    walk(loc.comments)
  }
  return result
}

export const parseFilter = (v?: string): ReadonlyArray<string> | undefined =>
  v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** @see StatsRepo.Filters */
export type Filters = {
  readonly repo?: string | undefined
  readonly author?: string | undefined
  readonly account?: string | undefined
}

export const whereFilters = (sql: SqlClient.SqlClient, filters: Filters, table?: string) => {
  const repos = parseFilter(filters.repo)
  const authors = parseFilter(filters.author)
  const accounts = parseFilter(filters.account)
  const t = table ? `${table}.` : ""
  return {
    repo: repos ? sql`AND ${sql.unsafe(`${t}repository_name`)} IN ${sql.in(repos)}` : sql``,
    author: authors ? sql`AND ${sql.unsafe(`${t}author`)} IN ${sql.in(authors)}` : sql``,
    account: accounts ? sql`AND ${sql.unsafe(`${t}aws_account_id`)} IN ${sql.in(accounts)}` : sql``
  }
}
