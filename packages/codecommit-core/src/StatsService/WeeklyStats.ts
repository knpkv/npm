/**
 * @module WeeklyStats
 *
 * Mental model: this is the **client-safe response schema** — the single
 * contract between server-side stats computation and client-side rendering.
 * It contains no server dependencies; only pure Schema definitions that both
 * sides can import without pulling in AWS SDK or database code.
 *
 * - Pure `Schema.Struct` definition — serialisable to JSON automatically.
 * - Sub-schemas are named consts; companion `declare namespace` exposes their
 *   types as `WeeklyStats.Contributor`, `WeeklyStats.ActivePR`, etc.
 *
 * @category Schema
 */
import { Schema } from "effect"

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

const Contributor = Schema.Struct({
  author: Schema.String,
  prCount: Schema.Number
})

const Reviewer = Schema.Struct({
  author: Schema.String,
  commentCount: Schema.Number
})

const Approver = Schema.Struct({
  author: Schema.String,
  approvalCount: Schema.Number
})

const ActivePR = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  author: Schema.String,
  repositoryName: Schema.String,
  commentCount: Schema.Number,
  awsAccountId: Schema.String
})

const SizeDistribution = Schema.Struct({
  small: Schema.Number,
  medium: Schema.Number,
  large: Schema.Number,
  extraLarge: Schema.Number
})

const DiffSize = Schema.Struct({
  filesAdded: Schema.Number,
  filesModified: Schema.Number,
  filesDeleted: Schema.Number
})

const DiffByContributor = Schema.Struct({
  author: Schema.String,
  avgFilesChanged: Schema.Number,
  prCount: Schema.Number
})

const StalePR = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  author: Schema.String,
  repositoryName: Schema.String,
  daysSinceActivity: Schema.Number,
  awsAccountId: Schema.String
})

const BusFactor = Schema.Struct({
  topContributorShare: Schema.Number,
  uniqueContributors: Schema.Number
})

const LifecycleDetail = Schema.Struct({
  prId: Schema.String,
  prTitle: Schema.String,
  author: Schema.String,
  repositoryName: Schema.String,
  awsAccountId: Schema.String,
  durationMs: Schema.Number,
  fromLabel: Schema.String,
  toLabel: Schema.String
})

// ---------------------------------------------------------------------------
// Main schema
// ---------------------------------------------------------------------------

export const WeeklyStats = Schema.Struct({
  week: Schema.String,
  weekStart: Schema.String,
  weekEnd: Schema.String,
  dataAvailableSince: Schema.NullOr(Schema.String),

  prsCreated: Schema.Number,
  prsMerged: Schema.Number,
  prsClosed: Schema.Number,
  totalComments: Schema.Number,

  topContributors: Schema.Array(Contributor),
  topReviewers: Schema.Array(Reviewer),
  topApprovers: Schema.Array(Approver),

  medianTimeToMerge: Schema.NullOr(Schema.Number),
  medianTimeToFirstReview: Schema.NullOr(Schema.Number),
  medianTimeToAddressFeedback: Schema.NullOr(Schema.Number),
  mergeTimeDetails: Schema.Array(LifecycleDetail),
  firstReviewDetails: Schema.Array(LifecycleDetail),
  feedbackDetails: Schema.Array(LifecycleDetail),

  mostActivePRs: Schema.Array(ActivePR),

  prSizeDistribution: SizeDistribution,
  avgDiffSize: Schema.NullOr(DiffSize),
  diffSizeByContributor: Schema.Array(DiffByContributor),

  stalePRs: Schema.Array(StalePR),
  reviewCoverage: Schema.NullOr(Schema.Number),
  approvalRate: Schema.NullOr(Schema.Number),
  busFactor: Schema.NullOr(BusFactor),

  availableRepos: Schema.Array(Schema.String),
  availableAuthors: Schema.Array(Schema.String),
  availableAccounts: Schema.Array(Schema.String)
})

export type WeeklyStats = typeof WeeklyStats.Type

// ---------------------------------------------------------------------------
// Companion namespace
// ---------------------------------------------------------------------------

export declare namespace WeeklyStats {
  /** @category models */
  export type Contributor = typeof Contributor.Type
  export type Reviewer = typeof Reviewer.Type
  export type Approver = typeof Approver.Type
  export type ActivePR = typeof ActivePR.Type
  export type SizeDistribution = typeof SizeDistribution.Type
  export type DiffSize = typeof DiffSize.Type
  export type DiffByContributor = typeof DiffByContributor.Type
  export type StalePR = typeof StalePR.Type
  export type BusFactor = typeof BusFactor.Type
}
