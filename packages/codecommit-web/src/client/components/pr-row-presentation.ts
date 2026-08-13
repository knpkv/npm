import * as DateUtils from "@knpkv/codecommit-core/DateUtils.js"
import type { PullRequest } from "@knpkv/codecommit-core/Domain.js"

type DecisionFacts = Pick<PullRequest, "approvedBy" | "isMergeable" | "status">
type TimestampFacts = Pick<PullRequest, "creationDate" | "lastModifiedDate">

export interface PullRequestRowDecision {
  readonly actionLabel: string
  readonly summary: string
}

/** Keep terminal lifecycle rows neutral instead of presenting stale mergeability as an active conflict. */
export const pullRequestRowDecision = (pr: DecisionFacts): PullRequestRowDecision => {
  switch (pr.status) {
    case "MERGED":
      return { actionLabel: "View pull request", summary: "Merged" }
    case "CLOSED":
      return { actionLabel: "View pull request", summary: "Closed" }
    case "OPEN": {
      if (!pr.isMergeable) return { actionLabel: "Inspect conflict", summary: "Merge blocked" }
      const approvedCount = pr.approvedBy.length
      return {
        actionLabel: "Open review",
        summary: `${approvedCount} ${approvedCount === 1 ? "approval" : "approvals"}`
      }
    }
  }
}

/** Machine-readable time must describe the same event as the visible row copy. */
export const pullRequestRowTimestamp = (pr: TimestampFacts, showUpdated: boolean): Date =>
  showUpdated ? pr.lastModifiedDate : pr.creationDate

export const pullRequestRowTimeLabel = (pr: TimestampFacts, showUpdated: boolean, now: Date): string =>
  showUpdated
    ? DateUtils.formatRelativeTime(pr.lastModifiedDate, now)
    : `Opened ${DateUtils.formatDate(pr.creationDate)}`
