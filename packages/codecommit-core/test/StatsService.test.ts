import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { AwsClient } from "../src/AwsClient/index.js"
import { PullRequestRepo } from "../src/CacheService/repos/PullRequestRepo/index.js"
import { StatsRepo } from "../src/CacheService/repos/StatsRepo/index.js"
import { ConfigService } from "../src/ConfigService/index.js"
import { StatsService } from "../src/StatsService/index.js"

// ---------------------------------------------------------------------------
// Test layer helpers
// ---------------------------------------------------------------------------

const makeDetail = (prId: string, durationMs: number) => ({
  prId,
  prTitle: `PR ${prId}`,
  author: "alice",
  repositoryName: "repo",
  awsAccountId: "111",
  durationMs,
  fromLabel: "2026-01-01 10:00",
  toLabel: "2026-01-02 10:00"
})

type Detail = ReturnType<typeof makeDetail>
const emptyHealth = { total: 0, withComments: 0, approved: 0 }
const emptySize = { small: 0, medium: 0, large: 0, extraLarge: 0 }
const emptyFilterOpts: { repos: Array<string>; authors: Array<string>; accounts: Array<string> } = {
  repos: [],
  authors: [],
  accounts: []
}
const emptyReviewer: {
  topReviewers: Array<{ author: string; commentCount: number }>
  topApprovers: Array<{ author: string; approvalCount: number }>
  avgTimeToFirstReview: number | null
  avgTimeToMerge: number | null
  avgTimeToAddressFeedback: number | null
  firstReviewDetails: Array<Detail>
  feedbackDetails: Array<Detail>
} = {
  topReviewers: [],
  topApprovers: [],
  avgTimeToFirstReview: null,
  avgTimeToMerge: null,
  avgTimeToAddressFeedback: null,
  firstReviewDetails: [],
  feedbackDetails: []
}

/** Build a mock StatsRepo with overridable query results */
const mockStatsRepo = (overrides: Partial<{
  volume: { prsCreated: number; prsMerged: number; prsClosed: number }
  contributors: Array<{ author: string; prCount: number }>
  health: { total: number; withComments: number; approved: number }
  mergeDetails: Array<Detail>
  reviewerData: typeof emptyReviewer
}> = {}) =>
  Layer.succeed(
    StatsRepo,
    StatsRepo.make({
      weeklyVolume: () => Effect.succeed(overrides.volume ?? { prsCreated: 0, prsMerged: 0, prsClosed: 0 }),
      topContributors: () => Effect.succeed(overrides.contributors ?? []),
      mostActivePRs: () => Effect.succeed([]),
      prSizeDistribution: () => Effect.succeed(emptySize),
      avgDiffSize: () => Effect.succeed(null),
      diffSizeByContributor: () => Effect.succeed([]),
      stalePRs: () => Effect.succeed([]),
      healthIndicators: () => Effect.succeed(overrides.health ?? emptyHealth),
      filterOptions: () => Effect.succeed(emptyFilterOpts),
      totalComments: () => Effect.succeed(0),
      reviewerData: () => Effect.succeed(overrides.reviewerData ?? emptyReviewer),
      mergeTimeDetails: () => Effect.succeed(overrides.mergeDetails ?? []),
      avgTimeToMerge: () => Effect.succeed(null),
      dataAvailableSince: () => Effect.succeed(null)
    })
  )

// Unused deps — Layer.mock({}) throws UnimplementedError if accidentally called
const testLayer = (overrides?: Parameters<typeof mockStatsRepo>[0]) =>
  StatsService.Default.pipe(
    Layer.provide(Layer.mergeAll(
      mockStatsRepo(overrides),
      Layer.mock(PullRequestRepo, { _tag: "PullRequestRepo" }),
      Layer.mock(ConfigService, {}),
      Layer.mock(AwsClient, {})
    ))
  )

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StatsService", () => {
  // getWeeklyStats fans out 13 repo queries in parallel then assembles
  // derived metrics. These tests verify the orchestration + derivation.

  // reviewCoverage = withComments / total — fraction of PRs that got reviewed
  // Low coverage signals PRs are merging without human review
  it.effect("computes reviewCoverage from health indicators", () =>
    Effect.gen(function*() {
      const svc = yield* StatsService
      const stats = yield* svc.getWeeklyStats("2026-W10", {})
      expect(stats.reviewCoverage).toBe(0.8)
    }).pipe(Effect.provide(testLayer({ health: { total: 10, withComments: 8, approved: 6 } }))))

  // approvalRate = approved / total — fraction of PRs formally approved
  it.effect("computes approvalRate from health indicators", () =>
    Effect.gen(function*() {
      const svc = yield* StatsService
      const stats = yield* svc.getWeeklyStats("2026-W10", {})
      expect(stats.approvalRate).toBe(0.6)
    }).pipe(Effect.provide(testLayer({ health: { total: 10, withComments: 8, approved: 6 } }))))

  // Both metrics must be null when no PRs exist — avoids division by zero
  it.effect("returns null coverage and approval for zero PRs", () =>
    Effect.gen(function*() {
      const svc = yield* StatsService
      const stats = yield* svc.getWeeklyStats("2026-W10", {})
      expect(stats.reviewCoverage).toBeNull()
      expect(stats.approvalRate).toBeNull()
    }).pipe(Effect.provide(testLayer())))

  // busFactor.topContributorShare = top author's PRs / total PRs
  // High share (>0.5) = one person dominates contributions = bus factor risk
  it.effect("computes busFactor from topContributors", () =>
    Effect.gen(function*() {
      const svc = yield* StatsService
      const stats = yield* svc.getWeeklyStats("2026-W10", {})
      expect(stats.busFactor).not.toBeNull()
      expect(stats.busFactor!.topContributorShare).toBe(0.5)
      expect(stats.busFactor!.uniqueContributors).toBe(3)
    }).pipe(Effect.provide(testLayer({
      contributors: [
        { author: "alice", prCount: 5 },
        { author: "bob", prCount: 3 },
        { author: "charlie", prCount: 2 }
      ]
    }))))

  // busFactor is null when no contributors exist (empty week)
  it.effect("returns null busFactor for empty contributor list", () =>
    Effect.gen(function*() {
      const svc = yield* StatsService
      const stats = yield* svc.getWeeklyStats("2026-W10", {})
      expect(stats.busFactor).toBeNull()
    }).pipe(Effect.provide(testLayer())))

  // medianTimeToMerge uses median() on mergeTimeDetails durations
  // Median resists outlier skew better than SQL AVG
  it.effect("computes medianTimeToMerge from mergeTimeDetails", () =>
    Effect.gen(function*() {
      const svc = yield* StatsService
      const stats = yield* svc.getWeeklyStats("2026-W10", {})
      // sorted: [43200000, 86400000, 172800000] -> middle = 86400000
      expect(stats.medianTimeToMerge).toBe(86400000)
    }).pipe(Effect.provide(testLayer({
      mergeDetails: [makeDetail("1", 86400000), makeDetail("2", 43200000), makeDetail("3", 172800000)]
    }))))

  // Empty merge details -> null median, not 0
  // UI shows "-" instead of "0m"
  it.effect("returns null medianTimeToMerge for empty details", () =>
    Effect.gen(function*() {
      const svc = yield* StatsService
      const stats = yield* svc.getWeeklyStats("2026-W10", {})
      expect(stats.medianTimeToMerge).toBeNull()
    }).pipe(Effect.provide(testLayer())))

  // mergeTimeDetails must be sorted longest-first for the drill-down table
  // Users see slowest PRs at top to investigate bottlenecks
  it.effect("sorts mergeTimeDetails longest first", () =>
    Effect.gen(function*() {
      const svc = yield* StatsService
      const stats = yield* svc.getWeeklyStats("2026-W10", {})
      expect(stats.mergeTimeDetails[0]!.durationMs).toBe(300)
      expect(stats.mergeTimeDetails[1]!.durationMs).toBe(200)
      expect(stats.mergeTimeDetails[2]!.durationMs).toBe(100)
    }).pipe(Effect.provide(testLayer({
      mergeDetails: [makeDetail("1", 100), makeDetail("3", 300), makeDetail("2", 200)]
    }))))

  // catchAll: invalid ISO week format -> fallback with zeroed metrics
  // Ensures UI always gets a valid response even with bad input
  it.effect("returns empty fallback for invalid week string", () =>
    Effect.gen(function*() {
      const svc = yield* StatsService
      const stats = yield* svc.getWeeklyStats("not-a-week", {})
      expect(stats.prsCreated).toBe(0)
      expect(stats.prsMerged).toBe(0)
      expect(stats.reviewCoverage).toBeNull()
      expect(stats.busFactor).toBeNull()
      expect(stats.mergeTimeDetails).toEqual([])
    }).pipe(Effect.provide(testLayer())))

  // volume numbers pass through from StatsRepo unmodified
  it.effect("passes through volume counts from StatsRepo", () =>
    Effect.gen(function*() {
      const svc = yield* StatsService
      const stats = yield* svc.getWeeklyStats("2026-W10", {})
      expect(stats.prsCreated).toBe(5)
      expect(stats.prsMerged).toBe(3)
      expect(stats.prsClosed).toBe(1)
    }).pipe(Effect.provide(testLayer({ volume: { prsCreated: 5, prsMerged: 3, prsClosed: 1 } }))))

  // firstReviewDetails from reviewerData are sorted longest-first
  it.effect("sorts firstReviewDetails longest first", () =>
    Effect.gen(function*() {
      const svc = yield* StatsService
      const stats = yield* svc.getWeeklyStats("2026-W10", {})
      expect(stats.firstReviewDetails[0]!.durationMs).toBe(500)
      expect(stats.firstReviewDetails[1]!.durationMs).toBe(100)
    }).pipe(Effect.provide(testLayer({
      reviewerData: {
        ...emptyReviewer,
        firstReviewDetails: [makeDetail("1", 100), makeDetail("2", 500)]
      }
    }))))
})
