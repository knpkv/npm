/**
 * @module StatsRepo/queries
 *
 * Simple SQL query methods. Each function takes `sql` (SqlClient) and returns
 * the method implementation for the StatsRepo service.
 *
 * @category CacheService
 */
import type * as SqlClient from "@effect/sql/SqlClient"
import { Effect } from "effect"
import {
  type ActivePRRow,
  type AvgDiffRow,
  cacheError,
  type ContributorRow,
  type DiffByContributorRow,
  type EarliestRow,
  type FilterOptionsRow,
  type Filters,
  type HealthRow,
  type MergeTimeDetailRow,
  type SizeDistributionRow,
  type StalePRRow,
  type VolumeRow,
  whereFilters
} from "./internal.js"

const fmtDate = (iso: string) => iso.slice(0, 16).replace("T", " ")

export const weeklyVolume = (sql: SqlClient.SqlClient) => (weekStart: string, weekEnd: string, filters: Filters) => {
  const f = whereFilters(sql, filters)
  return sql<VolumeRow>`
      SELECT
        COUNT(CASE WHEN creation_date >= ${weekStart} AND creation_date < ${weekEnd} THEN 1 END) as prs_created,
        COUNT(CASE WHEN status = 'MERGED' AND COALESCE(closed_at, last_modified_date) >= ${weekStart} AND COALESCE(closed_at, last_modified_date) < ${weekEnd} THEN 1 END) as prs_merged,
        COUNT(CASE WHEN status = 'CLOSED' AND COALESCE(closed_at, last_modified_date) >= ${weekStart} AND COALESCE(closed_at, last_modified_date) < ${weekEnd} THEN 1 END) as prs_closed
      FROM pull_requests
      WHERE (creation_date >= ${weekStart} OR COALESCE(closed_at, last_modified_date) >= ${weekStart})
        ${f.repo} ${f.author} ${f.account}
    `.pipe(
    Effect.map((rows) => rows[0] ?? { prsCreated: 0, prsMerged: 0, prsClosed: 0 }),
    cacheError("weeklyVolume")
  )
}

export const topContributors =
  (sql: SqlClient.SqlClient) => (weekStart: string, weekEnd: string, filters: Filters, limit = 10) => {
    const f = whereFilters(sql, filters)
    return sql<ContributorRow>`
      SELECT author, COUNT(*) as pr_count
      FROM pull_requests
      WHERE creation_date >= ${weekStart} AND creation_date < ${weekEnd}
        AND status != 'CLOSED'
        ${f.repo} ${f.author} ${f.account}
      GROUP BY author
      ORDER BY pr_count DESC
      LIMIT ${limit}
    `.pipe(cacheError("topContributors"))
  }

export const mostActivePRs =
  (sql: SqlClient.SqlClient) => (weekStart: string, weekEnd: string, filters: Filters, limit = 10) => {
    const f = whereFilters(sql, filters)
    return sql<ActivePRRow>`
      SELECT id, title, author, repository_name, comment_count, aws_account_id
      FROM pull_requests
      WHERE COALESCE(closed_at, last_modified_date) >= ${weekStart} AND COALESCE(closed_at, last_modified_date) < ${weekEnd}
        AND comment_count > 0
        AND status != 'CLOSED'
        ${f.repo} ${f.author} ${f.account}
      ORDER BY comment_count DESC
      LIMIT ${limit}
    `.pipe(cacheError("mostActivePRs"))
  }

export const prSizeDistribution =
  (sql: SqlClient.SqlClient) => (weekStart: string, weekEnd: string, filters: Filters) => {
    const f = whereFilters(sql, filters)
    return sql<SizeDistributionRow>`
      SELECT
        COUNT(CASE WHEN COALESCE(files_added,0)+COALESCE(files_modified,0)+COALESCE(files_deleted,0) < 5 THEN 1 END) as small,
        COUNT(CASE WHEN COALESCE(files_added,0)+COALESCE(files_modified,0)+COALESCE(files_deleted,0) BETWEEN 5 AND 15 THEN 1 END) as medium,
        COUNT(CASE WHEN COALESCE(files_added,0)+COALESCE(files_modified,0)+COALESCE(files_deleted,0) BETWEEN 16 AND 30 THEN 1 END) as large,
        COUNT(CASE WHEN COALESCE(files_added,0)+COALESCE(files_modified,0)+COALESCE(files_deleted,0) > 30 THEN 1 END) as extra_large
      FROM pull_requests
      WHERE creation_date >= ${weekStart} AND creation_date < ${weekEnd}
        AND files_added IS NOT NULL
        AND status != 'CLOSED'
        ${f.repo} ${f.author} ${f.account}
    `.pipe(
      Effect.map((rows) => rows[0] ?? { small: 0, medium: 0, large: 0, extraLarge: 0 }),
      cacheError("prSizeDistribution")
    )
  }

export const avgDiffSize = (sql: SqlClient.SqlClient) => (weekStart: string, weekEnd: string, filters: Filters) => {
  const f = whereFilters(sql, filters)
  return sql<AvgDiffRow>`
      SELECT
        AVG(files_added) as avg_added,
        AVG(files_modified) as avg_modified,
        AVG(files_deleted) as avg_deleted
      FROM pull_requests
      WHERE creation_date >= ${weekStart} AND creation_date < ${weekEnd}
        AND files_added IS NOT NULL
        AND status != 'CLOSED'
        ${f.repo} ${f.author} ${f.account}
    `.pipe(
    Effect.map((rows) => {
      const r = rows[0]
      if (!r || r.avgAdded == null) return null
      return { filesAdded: r.avgAdded, filesModified: r.avgModified ?? 0, filesDeleted: r.avgDeleted ?? 0 }
    }),
    cacheError("avgDiffSize")
  )
}

export const diffSizeByContributor =
  (sql: SqlClient.SqlClient) => (weekStart: string, weekEnd: string, filters: Filters, limit = 10) => {
    const f = whereFilters(sql, filters)
    return sql<DiffByContributorRow>`
      SELECT
        author,
        AVG(COALESCE(files_added,0)+COALESCE(files_modified,0)+COALESCE(files_deleted,0)) as avg_files_changed,
        COUNT(*) as pr_count
      FROM pull_requests
      WHERE creation_date >= ${weekStart} AND creation_date < ${weekEnd}
        AND files_added IS NOT NULL
        AND status != 'CLOSED'
        ${f.repo} ${f.author} ${f.account}
      GROUP BY author
      ORDER BY avg_files_changed DESC
      LIMIT ${limit}
    `.pipe(cacheError("diffSizeByContributor"))
  }

export const stalePRs = (sql: SqlClient.SqlClient) => (nowISO: string, filters: Filters, limit = 10) => {
  const f = whereFilters(sql, filters)
  return sql<StalePRRow>`
      SELECT
        id, title, author, repository_name, aws_account_id,
        CAST((julianday(${nowISO}) - julianday(last_modified_date)) AS INTEGER) as days_since_activity
      FROM pull_requests
      WHERE status = 'OPEN'
        AND julianday(${nowISO}) - julianday(last_modified_date) > 7
        ${f.repo} ${f.author} ${f.account}
      ORDER BY days_since_activity DESC
      LIMIT ${limit}
    `.pipe(cacheError("stalePRs"))
}

export const healthIndicators =
  (sql: SqlClient.SqlClient) => (weekStart: string, weekEnd: string, filters: Filters) => {
    const f = whereFilters(sql, filters)
    return sql<HealthRow>`
      SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN comment_count > 0 THEN 1 END) as with_comments,
        COUNT(CASE WHEN is_approved = 1 THEN 1 END) as approved
      FROM pull_requests
      WHERE creation_date >= ${weekStart} AND creation_date < ${weekEnd}
        AND status != 'CLOSED'
        ${f.repo} ${f.author} ${f.account}
    `.pipe(
      Effect.map((rows) => rows[0] ?? { total: 0, withComments: 0, approved: 0 }),
      cacheError("healthIndicators")
    )
  }

export const filterOptions = (sql: SqlClient.SqlClient) => () =>
  sql<FilterOptionsRow>`
      SELECT
        GROUP_CONCAT(DISTINCT repository_name) as repos,
        GROUP_CONCAT(DISTINCT author) as authors,
        GROUP_CONCAT(DISTINCT aws_account_id) as accounts
      FROM pull_requests
    `.pipe(
    Effect.map((rows) => {
      const r = rows[0]
      return {
        repos: r?.repos?.split(",").filter(Boolean) ?? [],
        authors: r?.authors?.split(",").filter(Boolean) ?? [],
        accounts: r?.accounts?.split(",").filter(Boolean) ?? []
      }
    }),
    cacheError("filterOptions")
  )

export const totalComments = (sql: SqlClient.SqlClient) => (weekStart: string, weekEnd: string, filters: Filters) => {
  const f = whereFilters(sql, filters)
  return sql<{ total: number }>`
      SELECT COALESCE(SUM(comment_count), 0) as total
      FROM pull_requests
      WHERE COALESCE(closed_at, last_modified_date) >= ${weekStart} AND COALESCE(closed_at, last_modified_date) < ${weekEnd}
        AND status != 'CLOSED'
        ${f.repo} ${f.author} ${f.account}
    `.pipe(
    Effect.map((rows) => rows[0]?.total ?? 0),
    cacheError("totalComments")
  )
}

export const mergeTimeDetails =
  (sql: SqlClient.SqlClient) => (weekStart: string, weekEnd: string, filters: Filters) => {
    const f = whereFilters(sql, filters)
    return sql<MergeTimeDetailRow>`
      SELECT id, title, author, repository_name, aws_account_id, creation_date,
        COALESCE(closed_at, last_modified_date) as last_modified_date,
        CAST((julianday(COALESCE(closed_at, last_modified_date)) - julianday(creation_date)) * 86400000 AS INTEGER) as duration_ms
      FROM pull_requests
      WHERE status = 'MERGED'
        AND COALESCE(closed_at, last_modified_date) >= ${weekStart} AND COALESCE(closed_at, last_modified_date) < ${weekEnd}
        ${f.repo} ${f.author} ${f.account}
      ORDER BY COALESCE(closed_at, last_modified_date) DESC
    `.pipe(
      Effect.map((rows) =>
        rows.map((r) => ({
          prId: r.id,
          prTitle: r.title,
          author: r.author,
          repositoryName: r.repositoryName,
          awsAccountId: r.awsAccountId,
          durationMs: r.durationMs,
          fromLabel: fmtDate(r.creationDate),
          toLabel: fmtDate(r.lastModifiedDate)
        }))
      ),
      cacheError("mergeTimeDetails")
    )
  }

export const avgTimeToMerge = (sql: SqlClient.SqlClient) => (weekStart: string, weekEnd: string, filters: Filters) => {
  const f = whereFilters(sql, filters)
  return sql<{ avgMs: number | null }>`
      SELECT AVG(
        CAST((julianday(COALESCE(closed_at, last_modified_date)) - julianday(creation_date)) * 86400000 AS INTEGER)
      ) as avg_ms
      FROM pull_requests
      WHERE status = 'MERGED'
        AND COALESCE(closed_at, last_modified_date) >= ${weekStart} AND COALESCE(closed_at, last_modified_date) < ${weekEnd}
        ${f.repo} ${f.author} ${f.account}
    `.pipe(
    Effect.map((rows) => rows[0]?.avgMs ?? null),
    cacheError("avgTimeToMerge")
  )
}

export const dataAvailableSince = (sql: SqlClient.SqlClient) => () =>
  sql<EarliestRow>`
      SELECT MIN(creation_date) as earliest FROM pull_requests
    `.pipe(
    Effect.map((rows) => rows[0]?.earliest ?? null),
    cacheError("dataAvailableSince")
  )
