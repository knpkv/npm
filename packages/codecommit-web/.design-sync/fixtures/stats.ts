// Fixtures from packages/codecommit-core/test/StatsService.test.ts and packages/codecommit-web/test/stats-page.test.ts.
import type { WeeklyStats } from "@knpkv/codecommit-core/StatsService/WeeklyStats.js"

export const noop = () => {}
export const contributors = [
  { author: "alice", prCount: 5 },
  { author: "bob", prCount: 3 },
  { author: "charlie", prCount: 2 }
]
export const activePRs: WeeklyStats["mostActivePRs"] = ["eu-west-1", "us-east-1"].map((accountRegion) => ({
  id: "42", title: `Payments ${accountRegion}`, author: "alice", repositoryName: "payments",
  accountRegion, commentCount: 2, awsAccountId: "111"
}))
export const stalePRs: WeeklyStats["stalePRs"] = ["eu-west-1", "us-east-1"].map((accountRegion) => ({
  id: "42", title: `Payments ${accountRegion}`, author: "alice", repositoryName: "payments",
  accountRegion, daysSinceActivity: 8, awsAccountId: "111"
}))
export const emptySize = { small: 0, medium: 0, large: 0, extraLarge: 0 }
export const emptyStats: WeeklyStats = {
  week: "2026-W10", weekStart: "2026-03-02", weekEnd: "2026-03-08", dataAvailableSince: null,
  prsCreated: 0, prsMerged: 0, prsClosed: 0, totalComments: 0,
  topContributors: [], topReviewers: [], topApprovers: [],
  medianTimeToMerge: null, medianTimeToFirstReview: null, medianTimeToAddressFeedback: null,
  mergeTimeDetails: [], firstReviewDetails: [], feedbackDetails: [],
  mostActivePRs: [], prSizeDistribution: emptySize, avgDiffSize: null, diffSizeByContributor: [],
  stalePRs: [], reviewCoverage: null, approvalRate: null, busFactor: null,
  availableRepos: [], availableAuthors: [], availableAccounts: []
}
export const healthStats: WeeklyStats = { ...emptyStats, reviewCoverage: 0.8, approvalRate: 0.6 }
export const contributorStats: WeeklyStats = {
  ...emptyStats, prsCreated: 10, topContributors: contributors,
  busFactor: { topContributorShare: 0.5, uniqueContributors: 3 }
}
