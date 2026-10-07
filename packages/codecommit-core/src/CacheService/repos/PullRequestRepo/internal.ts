/**
 * @module PullRequestRepo/internal
 *
 * Schemas, types, and helpers shared across the PullRequestRepo modules.
 *
 * Defines {@link CachedPullRequest} (SQLite row schema with approval rules,
 * approver ARNs, repo account ID), {@link UpsertInput} (write-side schema),
 * and codec transforms: `ApprovalRulesFromJson` (JSON TEXT <-> ApprovalRule[]),
 * `CommaSeparatedArray` (TEXT <-> string[] for approved_by, approved_by_arns,
 * commented_by).
 *
 * @category CacheService
 */
import { Effect, Schema, SchemaGetter } from "effect"
import {
  ApprovalRule,
  type ApprovalUnknownReason,
  ApprovalUnknownTag,
  PullRequestId,
  PullRequestStatus,
  RepositoryName
} from "../../../Domain.js"
import { CacheError } from "../../CacheError.js"
import type { ApprovalGroup, RowGroup, RowVersions } from "./rowWrites.js"

/** DB column `TEXT` (comma-separated) <-> `readonly string[]` */
export const CommaSeparatedArray = Schema.NullOr(Schema.String).pipe(
  Schema.decodeTo(Schema.Array(Schema.String), {
    decode: SchemaGetter.transform((s) => (s ? s.split(",").filter(Boolean) : [])),
    encode: SchemaGetter.transform((arr) => (arr.length > 0 ? arr.join(",") : null))
  })
)

const BooleanFromNumber = Schema.Number.pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((n) => n !== 0),
    encode: SchemaGetter.transform((b) => b ? 1 : 0)
  })
)

/** DB column `TEXT` (JSON) <-> `readonly ApprovalRule[]` */
const ApprovalRulesFromJson = Schema.NullOr(Schema.String).pipe(
  Schema.decodeTo(Schema.Array(ApprovalRule), {
    decode: SchemaGetter.transform((s) => {
      if (!s) return []
      try {
        return Schema.decodeUnknownSync(Schema.Array(ApprovalRule))(JSON.parse(s))
      } catch {
        return []
      }
    }),
    encode: SchemaGetter.transform((arr) => (arr.length > 0 ? JSON.stringify(arr) : null))
  })
)

/**
 * The `approval_unknown_reason` column: the reason's tag, or NULL when the last evaluation succeeded.
 */
export const ApprovalUnknownColumn = Schema.NullOr(ApprovalUnknownTag)

export const CachedPullRequest = Schema.Struct({
  id: PullRequestId,
  awsAccountId: Schema.String,
  repoAccountId: Schema.NullOr(Schema.String),
  accountProfile: Schema.String,
  accountRegion: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  author: Schema.String,
  repositoryName: RepositoryName,
  creationDate: Schema.DateFromString,
  lastModifiedDate: Schema.DateFromString,
  /** With `lastModifiedDate`, the row group's version: the observation that last wrote it. */
  observationSeq: Schema.Number,
  /** The approval group's version: the provider last activity and observation that last wrote it. */
  approvalVersion: Schema.DateFromString,
  approvalObservationSeq: Schema.Number,
  status: PullRequestStatus,
  sourceBranch: Schema.String,
  destinationBranch: Schema.String,
  isMergeable: BooleanFromNumber,
  isApproved: BooleanFromNumber,
  approvalUnknownReason: ApprovalUnknownColumn,
  commentCount: Schema.NullOr(Schema.Number),
  healthScore: Schema.NullOr(Schema.Number),
  link: Schema.String,
  fetchedAt: Schema.String,
  filesAdded: Schema.NullOr(Schema.Number),
  filesModified: Schema.NullOr(Schema.Number),
  filesDeleted: Schema.NullOr(Schema.Number),
  closedAt: Schema.NullOr(Schema.String),
  mergedBy: Schema.NullOr(Schema.String),
  approvedBy: CommaSeparatedArray,
  approvedByArns: CommaSeparatedArray,
  commentedBy: CommaSeparatedArray,
  approvalRules: ApprovalRulesFromJson
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
  repoAccountId: Schema.NullOr(Schema.String),
  accountProfile: Schema.String,
  accountRegion: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  author: Schema.String,
  repositoryName: Schema.String,
  creationDate: Schema.String,
  lastModifiedDate: Schema.String,
  status: PullRequestStatus,
  sourceBranch: Schema.String,
  destinationBranch: Schema.String,
  isMergeable: Schema.Number,
  isApproved: Schema.Number,
  approvalUnknownReason: ApprovalUnknownColumn,
  commentCount: Schema.NullOr(Schema.Number),
  link: Schema.String,
  approvedBy: Schema.Array(Schema.String),
  approvedByArns: Schema.Array(Schema.String),
  approvalRules: Schema.Array(ApprovalRule).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed([])))
})

export type UpsertInput = typeof UpsertInput.Type

/**
 * A provider read's approval, as `recordApprovalEvaluation` and `approvalColumnsOf` take it: the
 * evaluated value and its complete rules, or the reason evaluation failed. A `PullRequestDetail` is one.
 */
export interface ApprovalRead {
  readonly isApproved: boolean
  readonly approvalRules: UpsertInput["approvalRules"]
  readonly approvalUnknown?: ApprovalUnknownReason | undefined
}

/** Both groups' versions as a read of the row saw them: what a recomputed write must still find. */
export const versionsOf = (row: {
  readonly lastModifiedDate: Date
  readonly observationSeq: number
  readonly approvalVersion: Date
  readonly approvalObservationSeq: number
}): RowVersions => ({
  row: { lastActivity: row.lastModifiedDate, observation: row.observationSeq },
  approval: { lastActivity: row.approvalVersion, observation: row.approvalObservationSeq }
})

/**
 * A listed pull request's row group, complete. The listing reads open pull requests, so no merger and
 * no closing time are authoritative values, not gaps.
 */
export const rowGroupOfListing = (input: UpsertInput): RowGroup => ({
  title: input.title,
  description: input.description,
  author: input.author,
  status: input.status,
  creationDate: input.creationDate,
  sourceBranch: input.sourceBranch,
  destinationBranch: input.destinationBranch,
  isMergeable: input.isMergeable === 1,
  approvedBy: input.approvedBy,
  approvedByArns: input.approvedByArns,
  mergedBy: null,
  closedAt: null
})

/** A listed pull request's approval group, complete. */
export const approvalGroupOfListing = (input: UpsertInput): ApprovalGroup => ({
  isApproved: input.isApproved === 1,
  approvalRules: input.approvalRules,
  unknownReason: input.approvalUnknownReason
})

/** A provider re-read's row group, complete: a closed or merged read also carries when and by whom. */
export const rowGroupOfRead = (read: {
  readonly title: string
  readonly description?: string | undefined
  readonly author: string
  readonly status: string
  readonly creationDate: Date
  readonly lastActivityDate: Date
  readonly sourceBranch: string
  readonly destinationBranch: string
  readonly isMergeable: boolean
  readonly approvedBy: ReadonlyArray<string>
  readonly approvedByArns: ReadonlyArray<string>
  readonly mergedBy?: string | undefined
}): RowGroup => ({
  title: read.title,
  description: read.description ?? null,
  author: read.author,
  status: read.status,
  creationDate: read.creationDate.toISOString(),
  sourceBranch: read.sourceBranch,
  destinationBranch: read.destinationBranch,
  isMergeable: read.isMergeable,
  approvedBy: read.approvedBy,
  approvedByArns: read.approvedByArns,
  mergedBy: read.mergedBy ?? null,
  closedAt: read.status === "OPEN" ? null : read.lastActivityDate.toISOString()
})

/** A provider read's approval group, complete. */
export const approvalGroupOfRead = (read: ApprovalRead): ApprovalGroup => ({
  isApproved: read.isApproved,
  approvalRules: read.approvalRules,
  unknownReason: read.approvalUnknown?._tag ?? null
})

/**
 * The approval columns an upsert input carries for a provider read. While approval is unknown,
 * `isApproved` is a placeholder: the write keeps an existing row's last known value.
 */
export const approvalColumnsOf = (read: ApprovalRead) => ({
  isApproved: read.approvalUnknown === undefined && read.isApproved ? 1 : 0,
  approvalUnknownReason: read.approvalUnknown?._tag ?? null
})

/** Wrap an Effect with CacheError mapping and a span. */
export const cacheError = (op: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) => new CacheError({ operation: `PullRequestRepo.${op}`, cause })),
    Effect.withSpan(`PullRequestRepo.${op}`)
  )

/** Join a string array for the approved_by TEXT column. */
export const joinApprovedBy = (arr: ReadonlyArray<string>) => (arr.length > 0 ? arr.join(",") : null)
