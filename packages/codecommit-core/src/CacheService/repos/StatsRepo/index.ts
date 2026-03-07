/**
 * @module StatsRepo
 *
 * Read-only SQL projection layer for the statistics dashboard.
 * Assembles query methods from `./queries` and `./reviewerData` into
 * a single Effect.Service.
 *
 * @category CacheService
 */
import * as SqlClient from "@effect/sql/SqlClient"
import { Effect } from "effect"
import { DatabaseLive } from "../../Database.js"
import * as Q from "./queries.js"
import { reviewerData } from "./reviewerData.js"

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class StatsRepo extends Effect.Service<StatsRepo>()("StatsRepo", {
  dependencies: [DatabaseLive],
  effect: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    return {
      weeklyVolume: Q.weeklyVolume(sql),
      topContributors: Q.topContributors(sql),
      mostActivePRs: Q.mostActivePRs(sql),
      prSizeDistribution: Q.prSizeDistribution(sql),
      avgDiffSize: Q.avgDiffSize(sql),
      diffSizeByContributor: Q.diffSizeByContributor(sql),
      stalePRs: Q.stalePRs(sql),
      healthIndicators: Q.healthIndicators(sql),
      filterOptions: Q.filterOptions(sql),
      totalComments: Q.totalComments(sql),
      reviewerData: reviewerData(sql),
      mergeTimeDetails: Q.mergeTimeDetails(sql),
      avgTimeToMerge: Q.avgTimeToMerge(sql),
      dataAvailableSince: Q.dataAvailableSince(sql)
    } as const
  })
}) {}

export declare namespace StatsRepo {
  /**
   * @category models
   */
  export interface Filters {
    readonly repo?: string | undefined
    readonly author?: string | undefined
    readonly account?: string | undefined
  }
}
