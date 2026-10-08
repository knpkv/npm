/**
 * @module PullRequestRepo/rowWrites
 *
 * The only writers of `pull_requests` rows. A row has two versioned column groups and some
 * recomputed columns:
 *
 * - the row group (title, description, author, status, branches, mergeability, approvers, merge and
 *   close details), versioned by `last_modified_date`/`observation_seq`;
 * - the approval group (`is_approved`, `approval_unknown_reason`, `approval_rules`,
 *   `approval_baseline_known`), versioned by
 *   `approval_version`/`approval_observation_seq`;
 * - recomputed columns (diff stats, comment count, health score, commenters), which carry no version.
 *
 * A version is (provider last activity, observation number), compared in that order. `observe` takes
 * the observation from the database in one statement, before the provider call, so two reads of the
 * same revision are ordered by when they began.
 *
 * Three rules close the class of "an older read overwrites a newer one":
 *
 * 1. A provider read writes whole groups only: `upsert` and `writeRead` take a complete `RowGroup`
 *    and `ApprovalGroup`, and each group is written unless its version is newer than the read's.
 * 2. A recomputed write never moves a version: `writeDerived` applies only while both groups still
 *    hold exactly the versions it read, so a value computed from an older row is dropped.
 * 3. A tombstone keeps the later of the two groups' versions, so a deletion forgets neither.
 *
 * Two set-based writes carry no version: filling a NULL `repo_account_id` (it never replaces a value),
 * and deleting rows not fetched since a cutoff (cache expiry, not a provider observation).
 * `ast-grep/rules/typescript/no-direct-pull-request-row-write.yml` keeps every other path out.
 *
 * @category CacheService
 */
import { Data, Effect, Option } from "effect"
import type * as SqlClient from "effect/sql/SqlClient"
import type * as Statement from "effect/sql/Statement"
import { joinApprovedBy, type UpsertInput } from "./internal.js"

/**
 * The `observation_sequence` row is missing, so no observation number can be taken. Without one, reads
 * of the same revision can't be ordered; callers skip the read instead.
 */
export class ObservationSequenceMissing extends Data.TaggedError("ObservationSequenceMissing")<{}> {}

/** A version: the provider last activity a read saw, and the observation it came from. */
export interface RowVersion {
  readonly lastActivity: Date
  readonly observation: number
}

/** Both groups' versions, as a read of the row saw them. */
export interface RowVersions {
  readonly row: RowVersion
  readonly approval: RowVersion
}

/** The row group, complete: a provider read has every column of it. */
export interface RowGroup {
  readonly title: string
  readonly description: string | null
  readonly author: string
  readonly status: string
  readonly creationDate: string
  readonly sourceBranch: string
  readonly destinationBranch: string
  readonly isMergeable: boolean
  readonly mergedBy: string | null
  readonly closedAt: string | null
}

/**
 * The approval group, complete. While `unknownReason` is set, the stored approval and rules are kept
 * as the last known value and only the reason is written.
 */
export interface ApprovalGroup {
  readonly isApproved: boolean
  readonly approvalRules: UpsertInput["approvalRules"]
  readonly unknownReason: string | null
  /** Who approved now, from the same read; none when the read couldn't fetch them (the stored ones stay). */
  readonly approvers: Option.Option<{ readonly names: ReadonlyArray<string>; readonly arns: ReadonlyArray<string> }>
}

/** Recomputed columns: any subset, written without a version. */
export interface DerivedColumns {
  readonly filesAdded?: number
  readonly filesModified?: number
  readonly filesDeleted?: number
  readonly commentCount?: number | null
  readonly healthScore?: number | null
  readonly commentedBy?: string | null
}

/** Which column groups a provider read wrote, and the versions the row now holds. */
export interface GroupsWritten {
  readonly row: boolean
  readonly approval: boolean
  /** The row's versions after the write; absent when the row doesn't exist (a tombstone kept it out). */
  readonly versions: RowVersions | undefined
}

interface StoredVersions {
  readonly rowAt: string
  readonly rowSeq: number
  readonly approvalAt: string
  readonly approvalSeq: number
}

const written = (rows: ReadonlyArray<StoredVersions>, version: RowVersion): GroupsWritten => {
  const after = rows[0]
  if (after === undefined) return { row: false, approval: false, versions: undefined }
  const at = version.lastActivity.toISOString()
  return {
    row: after.rowAt === at && after.rowSeq === version.observation,
    approval: after.approvalAt === at && after.approvalSeq === version.observation,
    versions: {
      row: { lastActivity: new Date(after.rowAt), observation: after.rowSeq },
      approval: { lastActivity: new Date(after.approvalAt), observation: after.approvalSeq }
    }
  }
}

const rulesJson = (rules: ApprovalGroup["approvalRules"]) => rules.length > 0 ? JSON.stringify(rules) : "[]"

export const rowWrites = (sql: SqlClient.SqlClient) => {
  /** The group whose version is in `at`/`seq` is not newer than `version`. */
  const notNewer = (at: Statement.Fragment, seq: Statement.Fragment, version: RowVersion) => {
    const lastActivity = version.lastActivity.toISOString()
    return sql`(${at} < ${lastActivity} OR (${at} = ${lastActivity} AND ${seq} <= ${version.observation}))`
  }
  const rowNotNewer = (version: RowVersion) =>
    notNewer(sql`pull_requests.last_modified_date`, sql`pull_requests.observation_seq`, version)
  const approvalNotNewer = (version: RowVersion) =>
    notNewer(sql`pull_requests.approval_version`, sql`pull_requests.approval_observation_seq`, version)

  const returningVersions = sql`RETURNING last_modified_date AS rowAt, observation_seq AS rowSeq,
    approval_version AS approvalAt, approval_observation_seq AS approvalSeq`

  /** Each group's assignments, guarded by that group's version. */
  const groupAssignments = (version: RowVersion, row: RowGroup, approval: ApprovalGroup) => {
    const rowFresh = rowNotNewer(version)
    const approvalFresh = approvalNotNewer(version)
    const at = version.lastActivity.toISOString()
    const keep = (column: string) => sql.literal(`pull_requests.${column}`)
    const rowSet = (column: string, value: Statement.Fragment | string | number | null) =>
      sql`${sql.literal(column)} = CASE WHEN ${rowFresh} THEN ${value} ELSE ${keep(column)} END`
    const approvalSet = (column: string, value: Statement.Fragment | string | number | null) =>
      sql`${sql.literal(column)} = CASE WHEN ${approvalFresh} THEN ${value} ELSE ${keep(column)} END`
    const known = approval.unknownReason === null
    return sql.join(", ", false)([
      rowSet("title", row.title),
      rowSet("description", row.description),
      rowSet("author", row.author),
      rowSet("status", row.status),
      rowSet("creation_date", row.creationDate),
      rowSet("source_branch", row.sourceBranch),
      rowSet("destination_branch", row.destinationBranch),
      rowSet("is_mergeable", row.isMergeable ? 1 : 0),

      rowSet("merged_by", row.mergedBy),
      rowSet("closed_at", row.closedAt),
      // An unknown evaluation keeps the last known approval and rules; a successful one replaces both.
      approvalSet("is_approved", known ? (approval.isApproved ? 1 : 0) : keep("is_approved")),
      approvalSet("approval_rules", known ? rulesJson(approval.approvalRules) : keep("approval_rules")),
      approvalSet("approval_unknown_reason", approval.unknownReason),
      // Approvers are who approved now: a read with none clears them; one that couldn't fetch keeps them.
      approvalSet(
        "approved_by",
        Option.match(approval.approvers, {
          onNone: () => keep("approved_by"),
          onSome: ({ names }) => joinApprovedBy(names)
        })
      ),
      approvalSet("approvers_unknown", Option.isNone(approval.approvers) ? 1 : 0),
      approvalSet(
        "approved_by_arns",
        Option.match(approval.approvers, {
          onNone: () => keep("approved_by_arns"),
          onSome: ({ arns }) => joinApprovedBy(arns)
        })
      ),
      // A successful evaluation makes the baseline known; an unknown one keeps whatever it was.
      approvalSet("approval_baseline_known", known ? 1 : keep("approval_baseline_known")),
      // SQLite evaluates every SET expression on the row as it was, so each guard sees the old versions.
      approvalSet("approval_version", at),
      approvalSet("approval_observation_seq", version.observation),
      rowSet("last_modified_date", at),
      rowSet("observation_seq", version.observation)
    ])
  }

  return {
    /** The next observation number, taken before a provider read. Fails when the sequence row is missing. */
    observe: () =>
      sql<{ readonly value: number }>`UPDATE observation_sequence SET value = value + 1 WHERE id = 1 RETURNING value`
        .pipe(
          Effect.flatMap((rows) => {
            const next = rows[0]
            return next === undefined ? Effect.fail(new ObservationSequenceMissing()) : Effect.succeed(next.value)
          })
        ),

    /**
     * Insert a listed pull request, or write each of its groups unless that group is newer. A deleted
     * pull request comes back only from a read that began after the deletion, of a revision no older
     * than the deleted row's. Recomputed columns are set only on insert; afterwards only
     * `writeDerived` changes them.
     */
    upsert: (req: typeof UpsertInput.Encoded, row: RowGroup, approval: ApprovalGroup, observation: number) => {
      const version = { lastActivity: new Date(req.lastModifiedDate), observation }
      // A first read that couldn't fetch its approvers stores none; its refresh is reported partial.
      const insertedApprovers = Option.match(approval.approvers, {
        onNone: () => ({ names: null, arns: null }),
        onSome: ({ arns, names }) => ({ names: joinApprovedBy(names), arns: joinApprovedBy(arns) })
      })
      return sql<StoredVersions>`INSERT INTO pull_requests
          (id, aws_account_id, repo_account_id, account_profile, account_region, title, description,
           author, repository_name, creation_date, last_modified_date, status,
           source_branch, destination_branch, is_mergeable, is_approved, approval_unknown_reason,
           approval_baseline_known, approvers_unknown, comment_count, link, approved_by, approved_by_arns, approval_rules, merged_by, closed_at, fetched_at,
           observation_seq, approval_version, approval_observation_seq)
          SELECT ${req.id}, ${req.awsAccountId}, ${req.repoAccountId}, ${req.accountProfile}, ${req.accountRegion},
            ${row.title}, ${row.description}, ${row.author}, ${req.repositoryName},
            ${row.creationDate}, ${req.lastModifiedDate}, ${row.status},
            ${row.sourceBranch}, ${row.destinationBranch}, ${row.isMergeable ? 1 : 0},
            ${approval.isApproved ? 1 : 0}, ${approval.unknownReason},
            ${approval.unknownReason === null ? 1 : 0}, ${
        Option.isNone(approval.approvers) ? 1 : 0
      }, ${req.commentCount}, ${req.link}, ${insertedApprovers.names},
            ${insertedApprovers.arns}, ${rulesJson(approval.approvalRules)},
            ${row.mergedBy}, ${row.closedAt}, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
            ${observation}, ${req.lastModifiedDate}, ${observation}
          WHERE NOT EXISTS (
            SELECT 1 FROM pull_request_tombstones t
            WHERE t.aws_account_id = ${req.awsAccountId} AND t.id = ${req.id}
              AND t.repository_name = ${req.repositoryName} AND t.account_region = ${req.accountRegion}
              AND (t.observation_seq >= ${observation} OR t.version > ${req.lastModifiedDate})
          )
          ON CONFLICT (aws_account_id, id, repository_name, account_region) DO UPDATE SET
            account_profile = excluded.account_profile,
            link = excluded.link,
            repo_account_id = COALESCE(excluded.repo_account_id, pull_requests.repo_account_id),
            fetched_at = excluded.fetched_at,
            ${groupAssignments(version, row, approval)}
          WHERE ${rowNotNewer(version)} OR ${approvalNotNewer(version)}
          ${returningVersions}`.pipe(Effect.map((rows) => written(rows, version)))
    },

    /** Write a provider re-read of an existing row: each group unless that group is newer. */
    writeRead: (where: Statement.Fragment, version: RowVersion, row: RowGroup, approval: ApprovalGroup) =>
      sql<StoredVersions>`UPDATE pull_requests SET ${
        groupAssignments(version, row, approval)
      }, fetched_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE ${where} AND (${rowNotNewer(version)} OR ${approvalNotNewer(version)})
        ${returningVersions}`.pipe(Effect.map((rows) => written(rows, version))),

    /**
     * Write recomputed columns, only while both groups hold exactly the versions `observed` saw: a value
     * computed from an older row is dropped. Moves no version. True when the row was written.
     */
    writeDerived: (where: Statement.Fragment, observed: RowVersions, columns: DerivedColumns) => {
      const assignments = [
        columns.filesAdded !== undefined ? sql`files_added = ${columns.filesAdded}` : undefined,
        columns.filesModified !== undefined ? sql`files_modified = ${columns.filesModified}` : undefined,
        columns.filesDeleted !== undefined ? sql`files_deleted = ${columns.filesDeleted}` : undefined,
        columns.commentCount !== undefined ? sql`comment_count = ${columns.commentCount}` : undefined,
        columns.healthScore !== undefined ? sql`health_score = ${columns.healthScore}` : undefined,
        columns.commentedBy !== undefined ? sql`commented_by = ${columns.commentedBy}` : undefined
      ].filter((assignment) => assignment !== undefined)
      if (assignments.length === 0) return Effect.succeed(false)
      return sql<{ readonly applied: number }>`UPDATE pull_requests SET ${sql.join(", ", false)(assignments)}
        WHERE ${where}
          AND last_modified_date = ${observed.row.lastActivity.toISOString()}
          AND observation_seq = ${observed.row.observation}
          AND approval_version = ${observed.approval.lastActivity.toISOString()}
          AND approval_observation_seq = ${observed.approval.observation}
        RETURNING 1 AS applied`.pipe(Effect.map((rows) => rows.length > 0))
    },

    /**
     * Delete the row matched by `where` for a not-found read begun at `observation`, unless a read that
     * began later has written either group since. A not-found answer carries no revision, so only its
     * observation orders it. The tombstone keeps the later of the two groups' versions and
     * `observation`. True when the row was deleted.
     */
    deleteIfNotNewer: (where: Statement.Fragment, observation: number) => {
      const unwritten = sql`observation_seq <= ${observation} AND approval_observation_seq <= ${observation}`
      return sql.withTransaction(
        sql`INSERT INTO pull_request_tombstones
            (aws_account_id, id, repository_name, account_region, version, observation_seq)
          SELECT aws_account_id, id, repository_name, account_region,
            MAX(last_modified_date, approval_version), ${observation}
          FROM pull_requests WHERE ${where} AND ${unwritten}
          ON CONFLICT (aws_account_id, id, repository_name, account_region) DO UPDATE SET
            version = excluded.version, observation_seq = excluded.observation_seq,
            deleted_at = excluded.deleted_at`.pipe(
          Effect.andThen(
            sql<{ readonly applied: number }>`DELETE FROM pull_requests WHERE ${where} AND ${unwritten}
              RETURNING 1 AS applied`
          ),
          // A row already gone: a later not-found read still advances its tombstone (never lowers it),
          // so a read that began between the two deletions can't bring it back.
          Effect.tap(() =>
            sql`UPDATE pull_request_tombstones
              SET observation_seq = ${observation}, deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
              WHERE ${where} AND observation_seq < ${observation}
                AND NOT EXISTS (SELECT 1 FROM pull_requests WHERE ${where})`
          ),
          Effect.map((rows) => rows.length > 0)
        )
      )
    },

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
