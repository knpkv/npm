/**
 * @module PullRequestRepo/mutations
 *
 * SQL write operations. Each function takes `sql` and `publish` (change event)
 * and returns the mutation implementations as an object.
 *
 * @category CacheService
 */
import type * as SqlClient from "@effect/sql/SqlClient"
import * as SqlSchema from "@effect/sql/SqlSchema"
import { Effect, Schema } from "effect"
import { PRCommentLocationJson } from "../../../Domain.js"
import { cacheError, joinApprovedBy, UpsertInput } from "./internal.js"

export const mutations = (sql: SqlClient.SqlClient, publish: Effect.Effect<void>) => {
  const upsert_ = SqlSchema.void({
    Request: UpsertInput,
    execute: (req) => {
      const approvedByStr = joinApprovedBy(req.approvedBy)
      return sql`INSERT INTO pull_requests
        (id, aws_account_id, account_profile, account_region, title, description,
         author, repository_name, creation_date, last_modified_date, status,
         source_branch, destination_branch, is_mergeable, is_approved,
         comment_count, link, approved_by, fetched_at)
        VALUES (${req.id}, ${req.awsAccountId}, ${req.accountProfile}, ${req.accountRegion},
          ${req.title}, ${req.description}, ${req.author}, ${req.repositoryName},
          ${req.creationDate}, ${req.lastModifiedDate}, ${req.status},
          ${req.sourceBranch}, ${req.destinationBranch}, ${req.isMergeable}, ${req.isApproved},
          ${req.commentCount}, ${req.link}, ${approvedByStr}, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
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
          approved_by = COALESCE(excluded.approved_by, pull_requests.approved_by),
          fetched_at = excluded.fetched_at`
    }
  })

  const deleteStale_ = SqlSchema.void({
    Request: Schema.Struct({ olderThan: Schema.String }),
    execute: (req) => sql`DELETE FROM pull_requests WHERE fetched_at < ${req.olderThan}`
  })

  const deleteStaleOpen_ = SqlSchema.void({
    Request: Schema.Struct({ olderThan: Schema.String }),
    execute: (req) => sql`DELETE FROM pull_requests WHERE status = 'OPEN' AND fetched_at < ${req.olderThan}`
  })

  return {
    upsert: (input: UpsertInput) => upsert_(input).pipe(Effect.tap(() => publish), cacheError("upsert")),

    upsertMany: (prs: ReadonlyArray<UpsertInput>) =>
      sql.withTransaction(Effect.forEach(prs, (pr) => upsert_(pr), { discard: true })).pipe(
        Effect.tap(() => publish),
        cacheError("upsertMany")
      ),

    deleteStale: (olderThan: string) =>
      deleteStale_({ olderThan }).pipe(Effect.tap(() => publish), cacheError("deleteStale")),

    deleteStaleOpen: (olderThan: string) =>
      deleteStaleOpen_({ olderThan }).pipe(Effect.tap(() => publish), cacheError("deleteStaleOpen")),

    deleteOne: (awsAccountId: string, id: string) =>
      sql`DELETE FROM pull_requests WHERE aws_account_id = ${awsAccountId} AND id = ${id}`.pipe(
        Effect.asVoid,
        Effect.tap(() => publish),
        cacheError("deleteOne")
      ),

    updateDiffStats: (
      awsAccountId: string,
      id: string,
      filesAdded: number,
      filesModified: number,
      filesDeleted: number
    ) =>
      sql`UPDATE pull_requests SET files_added = ${filesAdded}, files_modified = ${filesModified}, files_deleted = ${filesDeleted}
          WHERE id = ${id} AND aws_account_id = ${awsAccountId}`.pipe(
        Effect.asVoid,
        Effect.tap(() => publish),
        cacheError("updateDiffStats")
      ),

    updateStatusAndClosedAt: (
      awsAccountId: string,
      id: string,
      status: string,
      closedAt: string,
      mergedBy?: string,
      approvedBy?: ReadonlyArray<string>
    ) => {
      const approvedByStr = approvedBy ? joinApprovedBy([...approvedBy]) : null
      return sql`UPDATE pull_requests SET status = ${status}, closed_at = ${closedAt}, merged_by = ${mergedBy ?? null},
          approved_by = COALESCE(${approvedByStr}, approved_by),
          last_modified_date = ${closedAt}
          WHERE id = ${id} AND aws_account_id = ${awsAccountId}`.pipe(
        Effect.asVoid,
        Effect.tap(() => publish),
        cacheError("updateStatusAndClosedAt")
      )
    },

    updateCommentCount: (awsAccountId: string, id: string, count: number | null) =>
      sql`UPDATE pull_requests SET comment_count = ${count}
          WHERE id = ${id} AND aws_account_id = ${awsAccountId}`.pipe(
        Effect.asVoid,
        Effect.tap(() => publish),
        cacheError("updateCommentCount")
      ),

    updateHealthScore: (awsAccountId: string, id: string, score: number) =>
      sql`UPDATE pull_requests SET health_score = ${score}
          WHERE id = ${id} AND aws_account_id = ${awsAccountId}`.pipe(
        Effect.asVoid,
        Effect.tap(() => publish),
        cacheError("updateHealthScore")
      ),

    refreshCommentedBy: () =>
      sql.withTransaction(
        Effect.gen(function*() {
          const LocationsFromJson = Schema.parseJson(Schema.Array(PRCommentLocationJson))
          const rows = yield* sql<
            { awsAccountId: string; pullRequestId: string; author: string; locationsJson: string }
          >`
            SELECT c.aws_account_id, c.pull_request_id, p.author, c.locations_json
            FROM pr_comments c
            INNER JOIN pull_requests p ON p.id = c.pull_request_id AND p.aws_account_id = c.aws_account_id
          `
          for (const row of rows) {
            const parsed = yield* Schema.decodeUnknown(LocationsFromJson)(row.locationsJson).pipe(
              Effect.catchAll(() => Effect.succeed([]))
            )
            const commenters = new Set<string>()
            const walk = (threads: ReadonlyArray<typeof PRCommentLocationJson.Type["comments"][number]>) => {
              for (const t of threads) {
                if (t.root.author !== row.author) commenters.add(t.root.author)
                walk(t.replies)
              }
            }
            for (const loc of parsed) walk(loc.comments)
            const commentedBy = commenters.size > 0 ? [...commenters].join(",") : null
            yield* sql`UPDATE pull_requests SET commented_by = ${commentedBy}
                        WHERE id = ${row.pullRequestId} AND aws_account_id = ${row.awsAccountId}`
          }
        })
      ).pipe(Effect.asVoid, cacheError("refreshCommentedBy"))
  } as const
}
