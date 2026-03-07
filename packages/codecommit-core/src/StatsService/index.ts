/**
 * @module StatsService
 *
 * Mental model: this is an **orchestration layer** — it doesn't own data,
 * it assembles a `WeeklyStats` view-model by fanning out to StatsRepo
 * queries and reviewer analysis in parallel, then shaping the results for
 * the client.
 *
 * - All repo queries run with `{ concurrency: "unbounded" }` for max throughput.
 * - `getWeeklyStats` is a read path; `syncWeek` is a write path that back-fills
 *   historical PR data into the cache.
 * - A `catchAll` fallback returns an empty `WeeklyStats` so the UI always gets
 *   a valid response, even when the cache is cold.
 *
 * @category Service
 */
import { Data, Effect, Layer, Option, type SubscriptionRef } from "effect"
import { AwsClient } from "../AwsClient/index.js"
import { PullRequestRepo } from "../CacheService/repos/PullRequestRepo/index.js"
import { StatsRepo } from "../CacheService/repos/StatsRepo/index.js"
import { ConfigService } from "../ConfigService/index.js"
import { median, parseISOWeek, toISOWeek } from "../DateUtils.js"
import type { AppState } from "../Domain.js"
import { syncWeek as syncWeekImpl } from "../PRService/refreshHistory.js"
import type { WeeklyStats as _WeeklyStats } from "./WeeklyStats.js"

export { WeeklyStats } from "./WeeklyStats.js"
type WeeklyStats = _WeeklyStats

class InvalidISOWeek extends Data.TaggedError("InvalidISOWeek")<{
  readonly week: string
}> {}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class StatsService extends Effect.Service<StatsService>()("@knpkv/codecommit-core/StatsService", {
  effect: Effect.gen(function*() {
    const statsRepo = yield* StatsRepo
    const prRepo = yield* PullRequestRepo
    const configService = yield* ConfigService
    const awsClient = yield* AwsClient

    const depsLayer = Layer.mergeAll(
      Layer.succeed(ConfigService, configService),
      Layer.succeed(AwsClient, awsClient),
      Layer.succeed(PullRequestRepo, prRepo)
    )

    const getWeeklyStats = Effect.fn("StatsService.getWeeklyStats")(
      function*(week: string, filters: StatsRepo.Filters) {
        const range = yield* Option.match(parseISOWeek(week), {
          onNone: () => Effect.fail(new InvalidISOWeek({ week })),
          onSome: Effect.succeed
        })
        const weekStart = range.start.toISOString()
        const weekEnd = range.end.toISOString()
        const nowISO = new Date().toISOString()

        const [
          volume,
          topContributors,
          mostActivePRs,
          prSizeDistribution,
          avgDiffSize,
          diffSizeByContributor,
          stalePRs,
          health,
          filterOptions,
          totalComments,
          reviewerData,
          mergeTimeDetails,
          dataAvailableSince
        ] = yield* Effect.all([
          statsRepo.weeklyVolume(weekStart, weekEnd, filters),
          statsRepo.topContributors(weekStart, weekEnd, filters),
          statsRepo.mostActivePRs(weekStart, weekEnd, filters),
          statsRepo.prSizeDistribution(weekStart, weekEnd, filters),
          statsRepo.avgDiffSize(weekStart, weekEnd, filters),
          statsRepo.diffSizeByContributor(weekStart, weekEnd, filters),
          statsRepo.stalePRs(nowISO, filters),
          statsRepo.healthIndicators(weekStart, weekEnd, filters),
          statsRepo.filterOptions(),
          statsRepo.totalComments(weekStart, weekEnd, filters),
          statsRepo.reviewerData(weekStart, weekEnd, filters),
          statsRepo.mergeTimeDetails(weekStart, weekEnd, filters),
          statsRepo.dataAvailableSince()
        ], { concurrency: "unbounded" })

        const reviewCoverage = health.total > 0 ? health.withComments / health.total : null
        const approvalRate = health.total > 0 ? health.approved / health.total : null

        const busFactor = topContributors.length > 0
          ? (() => {
            const totalPRs = topContributors.reduce((s, c) => s + c.prCount, 0)
            return {
              topContributorShare: totalPRs > 0 ? topContributors[0]!.prCount / totalPRs : 0,
              uniqueContributors: topContributors.length
            }
          })()
          : null

        return {
          week,
          weekStart,
          weekEnd,
          dataAvailableSince,
          prsCreated: volume.prsCreated,
          prsMerged: volume.prsMerged,
          prsClosed: volume.prsClosed,
          totalComments,
          topContributors: [...topContributors],
          topReviewers: reviewerData.topReviewers,
          topApprovers: reviewerData.topApprovers,
          medianTimeToMerge: median(mergeTimeDetails.map((d) => d.durationMs)),
          medianTimeToFirstReview: median(reviewerData.firstReviewDetails.map((d) => d.durationMs)),
          medianTimeToAddressFeedback: median(reviewerData.feedbackDetails.map((d) => d.durationMs)),
          mergeTimeDetails: [...mergeTimeDetails].sort((a, b) => b.durationMs - a.durationMs),
          firstReviewDetails: [...reviewerData.firstReviewDetails].sort((a, b) => b.durationMs - a.durationMs),
          feedbackDetails: [...reviewerData.feedbackDetails].sort((a, b) => b.durationMs - a.durationMs),
          mostActivePRs: mostActivePRs.map((p) => ({
            ...p,
            commentCount: p.commentCount ?? 0
          })),
          prSizeDistribution,
          avgDiffSize,
          diffSizeByContributor: [...diffSizeByContributor],
          stalePRs: [...stalePRs],
          reviewCoverage,
          approvalRate,
          busFactor,
          availableRepos: filterOptions.repos,
          availableAuthors: filterOptions.authors,
          availableAccounts: filterOptions.accounts
        } satisfies WeeklyStats
      }
    )

    return {
      getWeeklyStats: (week: string, filters: StatsRepo.Filters): Effect.Effect<WeeklyStats> =>
        getWeeklyStats(week, filters).pipe(
          Effect.catchAll((e) => {
            const fallback: WeeklyStats = {
              week,
              weekStart: "",
              weekEnd: "",
              dataAvailableSince: null,
              prsCreated: 0,
              prsMerged: 0,
              prsClosed: 0,
              totalComments: 0,
              topContributors: [],
              topReviewers: [],
              topApprovers: [],
              medianTimeToMerge: null,
              medianTimeToFirstReview: null,
              medianTimeToAddressFeedback: null,
              mergeTimeDetails: [],
              firstReviewDetails: [],
              feedbackDetails: [],
              mostActivePRs: [],
              prSizeDistribution: { small: 0, medium: 0, large: 0, extraLarge: 0 },
              avgDiffSize: null,
              diffSizeByContributor: [],
              stalePRs: [],
              reviewCoverage: null,
              approvalRate: null,
              busFactor: null,
              availableRepos: [],
              availableAuthors: [],
              availableAccounts: []
            }
            return Effect.logWarning("StatsService.getWeeklyStats failed", e).pipe(
              Effect.as(fallback)
            )
          })
        ),

      syncWeek: (week: string, state: SubscriptionRef.SubscriptionRef<AppState>): Effect.Effect<void> =>
        syncWeekImpl(state, week).pipe(Effect.provide(depsLayer)),

      currentWeek: () => toISOWeek(new Date())
    } as const
  })
}) {}

export declare namespace StatsService {
  /**
   * @category models
   */
  export interface Service {
    readonly getWeeklyStats: (week: string, filters: StatsRepo.Filters) => Effect.Effect<WeeklyStats>
    readonly syncWeek: (week: string, state: SubscriptionRef.SubscriptionRef<AppState>) => Effect.Effect<void>
    readonly currentWeek: () => string
  }
}
