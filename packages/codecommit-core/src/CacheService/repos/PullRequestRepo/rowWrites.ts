/**
 * @module PullRequestRepo/rowWrites
 *
 * The only writers of `pull_requests` rows. Every per-row write is a compare-and-set on the row's
 * version: (`last_modified_date`, `observation_seq`), compared in that order.
 *
 * - `last_modified_date` is the provider's last activity for the revision the row holds.
 * - `observation_seq` orders reads of the same revision: `observe` takes the next number from the
 *   database in one statement, before the provider call. Approval can turn unknown and back without
 *   the provider's last activity moving, so the read that began later wins.
 * - A write carries the version it observed: its read's last activity and observation, or, for a
 *   value recomputed from a cached row (diff stats, comment count, health score, commenters), that
 *   row's version when it was read. It applies only if the row's version is not newer, moves the row
 *   to its version, and reports whether it applied.
 *
 * Two set-based writes carry no version: filling a NULL `repo_account_id` (it never replaces a
 * value), and deleting rows not fetched since a cutoff (cache expiry, not a provider observation).
 * `ast-grep/rules/typescript/no-direct-pull-request-row-write.yml` keeps every other path out.
 *
 * @category CacheService
 */
import { Effect } from "effect"
import type * as SqlClient from "effect/sql/SqlClient"
import type * as Statement from "effect/sql/Statement"
import { joinApprovedBy, type UpsertInput } from "./internal.js"

/** A row version: the provider last activity a write observed, and the observation it came from. */
export interface RowVersion {
  readonly lastActivity: Date
  readonly observation: number
}

/** The version as stored: ISO last activity, observation number. */
interface StoredVersion {
  readonly lastActivity: string
  readonly observation: number
}

const stored = (version: RowVersion): StoredVersion => ({
  lastActivity: version.lastActivity.toISOString(),
  observation: version.observation
})

export const rowWrites = (sql: SqlClient.SqlClient) => {
  /** The row's version is not newer than `version`. */
  const notNewer = (version: StoredVersion) =>
    sql`(pull_requests.last_modified_date < ${version.lastActivity}
      OR (pull_requests.last_modified_date = ${version.lastActivity}
        AND pull_requests.observation_seq <= ${version.observation}))`

  const applied = (rows: ReadonlyArray<unknown>) => rows.length > 0

  return {
    /** The next observation number, taken before a provider read. */
    observe: () =>
      sql<{ readonly value: number }>`UPDATE observation_sequence SET value = value + 1 WHERE id = 1 RETURNING value`
        .pipe(Effect.map((rows) => rows[0]?.value ?? 0)),

    /**
     * Insert a listed pull request, or update its row unless the row's version is newer. True when
     * the row was written.
     */
    upsert: (req: typeof UpsertInput.Encoded, observation: number) => {
      const approvedByStr = joinApprovedBy(req.approvedBy)
      const approvedByArnsStr = joinApprovedBy(req.approvedByArns)
      const approvalRulesJson = req.approvalRules !== undefined && req.approvalRules.length > 0
        ? JSON.stringify(req.approvalRules)
        : "[]"
      return sql<{ readonly applied: number }>`INSERT INTO pull_requests
          (id, aws_account_id, repo_account_id, account_profile, account_region, title, description,
           author, repository_name, creation_date, last_modified_date, status,
           source_branch, destination_branch, is_mergeable, is_approved, approval_unknown_reason,
           comment_count, link, approved_by, approved_by_arns, approval_rules, fetched_at, observation_seq)
          SELECT ${req.id}, ${req.awsAccountId}, ${req.repoAccountId}, ${req.accountProfile}, ${req.accountRegion},
            ${req.title}, ${req.description}, ${req.author}, ${req.repositoryName},
            ${req.creationDate}, ${req.lastModifiedDate}, ${req.status},
            ${req.sourceBranch}, ${req.destinationBranch}, ${req.isMergeable}, ${req.isApproved}, ${req.approvalUnknownReason},
            ${req.commentCount}, ${req.link}, ${approvedByStr}, ${approvedByArnsStr}, ${approvalRulesJson}, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
            ${observation}
          -- A deleted pull request comes back only from a read that began after the deletion, of a
          -- revision no older than the deleted row's.
          WHERE NOT EXISTS (
            SELECT 1 FROM pull_request_tombstones t
            WHERE t.aws_account_id = ${req.awsAccountId} AND t.id = ${req.id}
              AND t.repository_name = ${req.repositoryName} AND t.account_region = ${req.accountRegion}
              AND (t.observation_seq >= ${observation} OR t.version > ${req.lastModifiedDate})
          )
          ON CONFLICT (aws_account_id, id, repository_name, account_region) DO UPDATE SET
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
            -- An unknown evaluation keeps the last known approval and rules; a successful one replaces both.
            is_approved = CASE WHEN excluded.approval_unknown_reason IS NULL
              THEN excluded.is_approved ELSE pull_requests.is_approved END,
            approval_unknown_reason = excluded.approval_unknown_reason,
            comment_count = COALESCE(excluded.comment_count, pull_requests.comment_count),
            health_score = pull_requests.health_score,
            link = excluded.link,
            approved_by = COALESCE(excluded.approved_by, pull_requests.approved_by),
            approved_by_arns = COALESCE(excluded.approved_by_arns, pull_requests.approved_by_arns),
            -- Rules are fetched fresh on every evaluated sync, unlike approved_by which accumulates
            approval_rules = CASE WHEN excluded.approval_unknown_reason IS NULL
              THEN excluded.approval_rules ELSE pull_requests.approval_rules END,
            repo_account_id = COALESCE(excluded.repo_account_id, pull_requests.repo_account_id),
            fetched_at = excluded.fetched_at,
            observation_seq = excluded.observation_seq
          WHERE ${notNewer({ lastActivity: req.lastModifiedDate, observation })}
          RETURNING 1 AS applied`.pipe(Effect.map(applied))
    },

    /**
     * Apply `set` to the row matched by `where` unless its version is newer than `version`, and move
     * it to `version`. True when the row was written.
     */
    compareAndSet: (where: Statement.Fragment, version: RowVersion, set: Statement.Fragment) => {
      const v = stored(version)
      return sql<{ readonly applied: number }>`UPDATE pull_requests
        SET ${set}, last_modified_date = ${v.lastActivity}, observation_seq = ${v.observation}
        WHERE ${where} AND ${notNewer(v)} RETURNING 1 AS applied`.pipe(Effect.map(applied))
    },

    /**
     * Delete the row matched by `where` for a not-found read begun at `observation`, unless a read
     * that began later has written the row since. A not-found answer carries no revision, so only its
     * observation orders it. Leaves a tombstone at the row's last activity and `observation`. True when
     * the row was deleted.
     */
    deleteIfNotNewer: (where: Statement.Fragment, observation: number) =>
      sql.withTransaction(
        sql`INSERT INTO pull_request_tombstones
            (aws_account_id, id, repository_name, account_region, version, observation_seq)
          SELECT aws_account_id, id, repository_name, account_region, last_modified_date, ${observation}
          FROM pull_requests WHERE ${where} AND observation_seq <= ${observation}
          ON CONFLICT (aws_account_id, id, repository_name, account_region) DO UPDATE SET
            version = excluded.version, observation_seq = excluded.observation_seq,
            deleted_at = excluded.deleted_at`.pipe(
          Effect.andThen(
            sql<{ readonly applied: number }>`DELETE FROM pull_requests
              WHERE ${where} AND observation_seq <= ${observation} RETURNING 1 AS applied`
          ),
          Effect.map(applied)
        )
      ),

    /**
     * Cache expiry: delete rows (only OPEN ones with `openOnly`) not fetched since `olderThan`, and
     * tombstones of deletions made before it (both on the cache clock), which no read in flight can
     * still be behind.
     */
    deleteFetchedBefore: (olderThan: string, openOnly: boolean) =>
      (openOnly
        ? sql`DELETE FROM pull_requests WHERE status = 'OPEN' AND fetched_at < ${olderThan}`
        : sql`DELETE FROM pull_requests WHERE fetched_at < ${olderThan}`).pipe(
          Effect.andThen(sql`DELETE FROM pull_request_tombstones WHERE deleted_at < ${olderThan}`)
        ),

    /** Fill a NULL `repo_account_id` from another row of the same repository; an existing value is kept. */
    fillRepoAccountIds: () =>
      sql`UPDATE pull_requests
          SET repo_account_id = (
            SELECT p2.repo_account_id FROM pull_requests p2
            WHERE p2.repo_account_id IS NOT NULL
              AND p2.aws_account_id = pull_requests.aws_account_id
              AND p2.repository_name = pull_requests.repository_name
              AND p2.account_region = pull_requests.account_region
            LIMIT 1
          )
          WHERE repo_account_id IS NULL`
  }
}
