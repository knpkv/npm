/**
 * @module PullRequestRepo/mutations
 *
 * SQL write operations for the pull_requests table. Each function takes `sql`
 * and `publish` (change event) and returns the mutation implementations.
 *
 * Provides upsert (INSERT ON CONFLICT UPDATE with column-specific merge
 * strategy), stale cleanup, diff stats updates, status transitions,
 * comment count updates, health score updates, and commented-by refresh.
 *
 * **Gotchas**
 *
 * - approval_rules uses `= excluded` (no COALESCE) — always fresh from API
 * - repo_account_id uses COALESCE — preserves across partial updates
 *
 * @category CacheService
 */
import { Effect, Schema } from "effect"
import type * as SqlClient from "effect/sql/SqlClient"
import * as SqlSchema from "effect/sql/SqlSchema"
import { type CommentThreadJson, decodeCommentLocationJson } from "../commentLocations.js"
import { type ApprovalRead, cacheError, joinApprovedBy, UpsertInput } from "./internal.js"
import { PullRequestAmbiguityError } from "./queries.js"
import { type RowVersion, rowWrites } from "./rowWrites.js"

export interface PullRequestCoordinates {
  readonly repositoryName: string
  readonly accountRegion: string
}

export const mutations = (sql: SqlClient.SqlClient, publish: Effect.Effect<void>) => {
  const writes = rowWrites(sql)
  const countByLegacyIdentity_ = SqlSchema.findOne({
    Result: Schema.Struct({ count: Schema.Number }),
    Request: Schema.Struct({ awsAccountId: Schema.String, id: Schema.String }),
    execute: (req) =>
      sql`SELECT count(*) AS count FROM pull_requests
          WHERE aws_account_id = ${req.awsAccountId} AND id = ${req.id}`
  })

  const ensureUnambiguous = (awsAccountId: string, id: string, coordinates?: PullRequestCoordinates) =>
    coordinates !== undefined
      ? Effect.void
      : countByLegacyIdentity_({ awsAccountId, id }).pipe(
        Effect.flatMap(({ count }) =>
          count > 1
            ? Effect.fail(new PullRequestAmbiguityError({ awsAccountId, pullRequestId: id, matches: count }))
            : Effect.void
        )
      )

  const pullRequestWhere = (
    awsAccountId: string,
    id: string,
    coordinates?: PullRequestCoordinates
  ) =>
    coordinates === undefined
      ? sql`aws_account_id = ${awsAccountId} AND id = ${id}`
      : sql`aws_account_id = ${awsAccountId} AND id = ${id}
        AND repository_name = ${coordinates.repositoryName}
        AND account_region = ${coordinates.accountRegion}`
  const encodeUpsert = Schema.encodeEffect(UpsertInput)
  const upsert_ = (input: UpsertInput, observation: number) =>
    encodeUpsert(input).pipe(Effect.flatMap((req) => writes.upsert(req, observation)))
  /** Publish a change only when a compare-and-set write applied. */
  const publishIfApplied = (applied: boolean) => applied ? publish : Effect.void

  const deleteStale_ = SqlSchema.void({
    Request: Schema.Struct({ olderThan: Schema.String }),
    execute: (req) => writes.deleteFetchedBefore(req.olderThan, false)
  })

  const deleteStaleOpen_ = SqlSchema.void({
    Request: Schema.Struct({ olderThan: Schema.String }),
    execute: (req) => writes.deleteFetchedBefore(req.olderThan, true)
  })

  const repo = {
    /** The next observation number: take it before the provider read whose results a write carries. */
    observe: () => writes.observe().pipe(cacheError("observe")),

    /**
     * Write a listed pull request observed by `observation`, unless its row is newer. True when the
     * row was written; a false result means a newer read already reached it.
     */
    upsert: (input: UpsertInput, observation: number) =>
      upsert_(input, observation).pipe(Effect.tap(publishIfApplied), cacheError("upsert")),

    upsertMany: (prs: ReadonlyArray<UpsertInput>, observation: number) =>
      sql.withTransaction(Effect.forEach(prs, (pr) => upsert_(pr, observation), { discard: true })).pipe(
        Effect.tap(() => publish),
        cacheError("upsertMany")
      ),

    deleteStale: (olderThan: string) =>
      deleteStale_({ olderThan }).pipe(Effect.tap(() => publish), cacheError("deleteStale")),

    deleteStaleOpen: (olderThan: string) =>
      deleteStaleOpen_({ olderThan }).pipe(Effect.tap(() => publish), cacheError("deleteStaleOpen")),

    /** Delete a row observed at `version`, unless a newer write has reached it since. */
    deleteOne: (awsAccountId: string, id: string, version: RowVersion, coordinates?: PullRequestCoordinates) =>
      ensureUnambiguous(awsAccountId, id, coordinates).pipe(
        Effect.andThen(writes.deleteIfNotNewer(pullRequestWhere(awsAccountId, id, coordinates), version)),
        Effect.tap(publishIfApplied),
        cacheError("deleteOne")
      ),

    updateDiffStats: (
      awsAccountId: string,
      id: string,
      filesAdded: number,
      filesModified: number,
      filesDeleted: number,
      version: RowVersion,
      coordinates?: PullRequestCoordinates
    ) =>
      ensureUnambiguous(awsAccountId, id, coordinates).pipe(
        Effect.andThen(
          writes.compareAndSet(
            pullRequestWhere(awsAccountId, id, coordinates),
            version,
            sql`files_added = ${filesAdded}, files_modified = ${filesModified}, files_deleted = ${filesDeleted}`
          )
        ),
        Effect.tap(publishIfApplied),
        cacheError("updateDiffStats")
      ),

    /**
     * Record a provider re-read's approval evaluation on its row. While unknown, the last known
     * approval and rules are kept and only the reason is set; an evaluation replaces both and clears
     * the reason. A read older than the cached revision (its last activity is earlier) is not written:
     * the history sync runs outside the refresh lock, so a refresh may have stored a newer revision.
     * An accepted read advances the row to its last activity, so an older read landing later is dropped.
     */
    recordApprovalEvaluation: (
      awsAccountId: string,
      id: string,
      read: ApprovalRead,
      version: RowVersion,
      coordinates?: PullRequestCoordinates
    ) => {
      const set = read.approvalUnknown !== undefined
        ? sql`approval_unknown_reason = ${read.approvalUnknown._tag}`
        : sql`is_approved = ${read.isApproved ? 1 : 0}, approval_unknown_reason = NULL,
          approval_rules = ${read.approvalRules.length > 0 ? JSON.stringify(read.approvalRules) : "[]"}`
      return ensureUnambiguous(awsAccountId, id, coordinates).pipe(
        Effect.andThen(
          writes.compareAndSet(pullRequestWhere(awsAccountId, id, coordinates), version, set)
        ),
        Effect.tap(publishIfApplied),
        cacheError("recordApprovalEvaluation")
      )
    },

    /**
     * Record a provider read that found the pull request closed or merged at `closedAt`, its last
     * activity. A read older than the cached revision is not written, so a stale read can't re-close a
     * row a refresh has since stored newer.
     */
    updateStatusAndClosedAt: (
      awsAccountId: string,
      id: string,
      status: string,
      closedAt: string,
      observation: number,
      mergedBy?: string,
      approvedBy?: ReadonlyArray<string>,
      coordinates?: PullRequestCoordinates
    ) => {
      const approvedByStr = approvedBy !== undefined ? joinApprovedBy([...approvedBy]) : null
      return ensureUnambiguous(awsAccountId, id, coordinates).pipe(
        Effect.andThen(
          writes.compareAndSet(
            pullRequestWhere(awsAccountId, id, coordinates),
            { lastActivity: new Date(closedAt), observation },
            sql`status = ${status}, closed_at = ${closedAt}, merged_by = ${mergedBy ?? null},
              approved_by = COALESCE(${approvedByStr}, approved_by)`
          )
        ),
        Effect.tap(publishIfApplied),
        cacheError("updateStatusAndClosedAt")
      )
    },

    updateCommentCount: (
      awsAccountId: string,
      id: string,
      count: number | null,
      version: RowVersion,
      coordinates?: PullRequestCoordinates
    ) =>
      ensureUnambiguous(awsAccountId, id, coordinates).pipe(
        Effect.andThen(
          writes.compareAndSet(pullRequestWhere(awsAccountId, id, coordinates), version, sql`comment_count = ${count}`)
        ),
        Effect.tap(publishIfApplied),
        cacheError("updateCommentCount")
      ),

    updateHealthScore: (
      awsAccountId: string,
      id: string,
      score: number,
      version: RowVersion,
      coordinates?: PullRequestCoordinates
    ) =>
      ensureUnambiguous(awsAccountId, id, coordinates).pipe(
        Effect.andThen(
          writes.compareAndSet(pullRequestWhere(awsAccountId, id, coordinates), version, sql`health_score = ${score}`)
        ),
        Effect.tap(publishIfApplied),
        cacheError("updateHealthScore")
      ),

    refreshCommentedBy: () =>
      sql.withTransaction(
        Effect.gen(function*() {
          const rows = yield* sql<
            {
              awsAccountId: string
              pullRequestId: string
              repositoryName: string
              accountRegion: string
              author: string
              locationsJson: string
              version: string
              observation: number
            }
          >`
            SELECT c.aws_account_id AS awsAccountId, c.pull_request_id AS pullRequestId,
              p.repository_name AS repositoryName, p.account_region AS accountRegion,
              p.last_modified_date AS version, p.observation_seq AS observation,
              p.author AS author, c.locations_json AS locationsJson
            FROM pr_comments c
            INNER JOIN pull_requests p
              ON p.id = c.pull_request_id
              AND p.aws_account_id = c.aws_account_id
              AND (
                (p.repository_name = c.repository_name AND p.account_region = c.account_region)
                OR (
                  c.repository_name = ''
                  AND c.account_region = ''
                  AND (
                    SELECT count(*) FROM pull_requests p2
                    WHERE p2.aws_account_id = c.aws_account_id AND p2.id = c.pull_request_id
                  ) = 1
                  AND NOT EXISTS (
                    SELECT 1 FROM pr_comments c2
                    WHERE c2.aws_account_id = c.aws_account_id
                      AND c2.pull_request_id = c.pull_request_id
                      AND c2.repository_name = p.repository_name
                      AND c2.account_region = p.account_region
                  )
                )
              )
          `
          for (const row of rows) {
            const parsed = yield* decodeCommentLocationJson(row.locationsJson)
            const commenters = new Set<string>()
            const walk = (threads: ReadonlyArray<CommentThreadJson>) => {
              for (const t of threads) {
                if (t.root.author !== row.author) commenters.add(t.root.author)
                walk(t.replies)
              }
            }
            for (const loc of parsed) walk(loc.comments)
            const commentedBy = commenters.size > 0 ? [...commenters].join(",") : null
            yield* writes.compareAndSet(
              pullRequestWhere(row.awsAccountId, row.pullRequestId, {
                repositoryName: row.repositoryName,
                accountRegion: row.accountRegion
              }),
              { lastActivity: new Date(row.version), observation: row.observation },
              sql`commented_by = ${commentedBy}`
            )
          }
        })
      ).pipe(Effect.asVoid, cacheError("refreshCommentedBy")),

    propagateRepoAccountId: () =>
      writes.fillRepoAccountIds().pipe(
        Effect.asVoid,
        cacheError("propagateRepoAccountId")
      )
  }

  return repo
}
