/**
 * @module PullRequestRepo/mutations
 *
 * SQL write operations for the pull_requests table. Each function takes `sql`
 * and `publish` (change event) and returns the mutation implementations.
 *
 * Every write goes through `rowWrites`: provider reads write whole column groups under their versions
 * (`upsert` for a listing, `writeRead` for a re-read), recomputed values go through `writeDerived`,
 * which applies only to the row as it was read, and a not-found read deletes through `deleteOne`.
 *
 * @category CacheService
 */
import { Effect, Schema } from "effect"
import type * as SqlClient from "effect/sql/SqlClient"
import * as SqlSchema from "effect/sql/SqlSchema"
import { type CommentThreadJson, decodeCommentLocationJson } from "../commentLocations.js"
import {
  approvalGroupOfListing,
  approvalGroupOfRead,
  type ApprovalRead,
  cacheError,
  rowGroupOfListing,
  rowGroupOfRead,
  UpsertInput
} from "./internal.js"
import { PullRequestAmbiguityError } from "./queries.js"
import { type DerivedColumns, type RowVersions, rowWrites } from "./rowWrites.js"

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
    encodeUpsert(input).pipe(
      Effect.flatMap((req) => writes.upsert(req, rowGroupOfListing(input), approvalGroupOfListing(input), observation))
    )
  /** Publish a change only when a write applied. */
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
     * Write a listed pull request observed by `observation`: its row and approval groups, each unless
     * that group is newer. The result says which were written; a group not written means a newer read
     * already reached it.
     */
    upsert: (input: UpsertInput, observation: number) =>
      upsert_(input, observation).pipe(
        Effect.tap((written) => publishIfApplied(written.row || written.approval)),
        cacheError("upsert")
      ),

    /**
     * Write a pull request read in full (a single-PR refresh): like `upsert`, but both groups come
     * from `read`, so a merged or closed read carries its merger and closing time.
     */
    upsertRead: (
      input: UpsertInput,
      read: Parameters<typeof rowGroupOfRead>[0] & ApprovalRead,
      observation: number
    ) =>
      encodeUpsert(input).pipe(
        Effect.flatMap((req) => writes.upsert(req, rowGroupOfRead(read), approvalGroupOfRead(read), observation)),
        Effect.tap((written) => publishIfApplied(written.row || written.approval)),
        cacheError("upsertRead")
      ),

    upsertMany: (prs: ReadonlyArray<UpsertInput>, observation: number) =>
      sql.withTransaction(Effect.forEach(prs, (pr) => upsert_(pr, observation), { discard: true })).pipe(
        Effect.tap(() => publish),
        cacheError("upsertMany")
      ),

    /**
     * Write a provider re-read of a cached pull request, observed by `observation`: its whole row group
     * (including a closed or merged status) and approval group, each unless that group is newer.
     */
    writeRead: (
      awsAccountId: string,
      id: string,
      read: Parameters<typeof rowGroupOfRead>[0] & ApprovalRead,
      observation: number,
      coordinates?: PullRequestCoordinates
    ) =>
      ensureUnambiguous(awsAccountId, id, coordinates).pipe(
        Effect.andThen(
          writes.writeRead(
            pullRequestWhere(awsAccountId, id, coordinates),
            { lastActivity: read.lastActivityDate, observation },
            rowGroupOfRead(read),
            approvalGroupOfRead(read)
          )
        ),
        Effect.tap((written) => publishIfApplied(written.row || written.approval)),
        cacheError("writeRead")
      ),

    /**
     * Write values recomputed from a cached row (diff stats, comment count, health score), only while
     * the row still holds `observed`, the versions it was read at. True when written.
     */
    writeDerived: (
      awsAccountId: string,
      id: string,
      observed: RowVersions,
      columns: DerivedColumns,
      coordinates?: PullRequestCoordinates
    ) =>
      ensureUnambiguous(awsAccountId, id, coordinates).pipe(
        Effect.andThen(writes.writeDerived(pullRequestWhere(awsAccountId, id, coordinates), observed, columns)),
        Effect.tap(publishIfApplied),
        cacheError("writeDerived")
      ),

    deleteStale: (olderThan: string) =>
      deleteStale_({ olderThan }).pipe(Effect.tap(() => publish), cacheError("deleteStale")),

    deleteStaleOpen: (olderThan: string) =>
      deleteStaleOpen_({ olderThan }).pipe(Effect.tap(() => publish), cacheError("deleteStaleOpen")),

    /**
     * Delete a row the provider answered "does not exist" for, in a read begun at `observation`,
     * unless a read that began later has written it since. True when the row was deleted.
     */
    deleteOne: (awsAccountId: string, id: string, observation: number, coordinates?: PullRequestCoordinates) =>
      ensureUnambiguous(awsAccountId, id, coordinates).pipe(
        Effect.andThen(writes.deleteIfNotNewer(pullRequestWhere(awsAccountId, id, coordinates), observation)),
        Effect.tap(publishIfApplied),
        cacheError("deleteOne")
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
              rowAt: string
              rowSeq: number
              approvalAt: string
              approvalSeq: number
            }
          >`
            SELECT c.aws_account_id AS awsAccountId, c.pull_request_id AS pullRequestId,
              p.repository_name AS repositoryName, p.account_region AS accountRegion,
              p.last_modified_date AS rowAt, p.observation_seq AS rowSeq,
              p.approval_version AS approvalAt, p.approval_observation_seq AS approvalSeq,
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
            // Read and written in one transaction, so the versions it read still hold.
            yield* writes.writeDerived(
              pullRequestWhere(row.awsAccountId, row.pullRequestId, {
                repositoryName: row.repositoryName,
                accountRegion: row.accountRegion
              }),
              {
                row: { lastActivity: new Date(row.rowAt), observation: row.rowSeq },
                approval: { lastActivity: new Date(row.approvalAt), observation: row.approvalSeq }
              },
              { commentedBy }
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
