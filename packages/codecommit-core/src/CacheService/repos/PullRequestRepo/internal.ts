/**
 * @module PullRequestRepo/internal
 *
 * Schemas, types, and helpers shared across the PullRequestRepo modules.
 *
 * @category CacheService
 */
import * as Model from "@effect/sql/Model"
import { Effect, Schema } from "effect"
import { AwsProfileName, AwsRegion, PullRequestId, PullRequestStatus, RepositoryName } from "../../../Domain.js"
import { CacheError } from "../../CacheError.js"

/** DB column `TEXT` (comma-separated) <-> `readonly string[]` */
export const CommaSeparatedArray = Schema.transform(
  Schema.NullOr(Schema.String),
  Schema.Array(Schema.String),
  {
    decode: (s) => (s ? s.split(",") : []),
    encode: (arr) => (arr.length > 0 ? arr.join(",") : null)
  }
)

export const CachedPullRequest = Schema.Struct({
  id: PullRequestId,
  awsAccountId: Schema.String,
  accountProfile: AwsProfileName,
  accountRegion: AwsRegion,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  author: Schema.String,
  repositoryName: RepositoryName,
  creationDate: Schema.DateFromString,
  lastModifiedDate: Schema.DateFromString,
  status: PullRequestStatus,
  sourceBranch: Schema.String,
  destinationBranch: Schema.String,
  isMergeable: Model.BooleanFromNumber,
  isApproved: Model.BooleanFromNumber,
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
  commentedBy: CommaSeparatedArray
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
  accountProfile: Schema.String,
  accountRegion: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  author: Schema.String,
  repositoryName: Schema.String,
  creationDate: Schema.String,
  lastModifiedDate: Schema.String,
  status: Schema.String,
  sourceBranch: Schema.String,
  destinationBranch: Schema.String,
  isMergeable: Schema.Number,
  isApproved: Schema.Number,
  commentCount: Schema.NullOr(Schema.Number),
  link: Schema.String,
  approvedBy: Schema.Array(Schema.String)
})

export type UpsertInput = typeof UpsertInput.Type

/** Wrap an Effect with CacheError mapping and a span. */
export const cacheError = (op: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) => new CacheError({ operation: `PullRequestRepo.${op}`, cause })),
    Effect.withSpan(`PullRequestRepo.${op}`, { captureStackTrace: false })
  )

/** Join a string array for the approved_by TEXT column. */
export const joinApprovedBy = (arr: ReadonlyArray<string>) => (arr.length > 0 ? arr.join(",") : null)
