import * as DateUtils from "@knpkv/codecommit-core/DateUtils.js"
import {
  approvalNotRequiredLabel,
  approvalOf,
  approvalUnknownLabel,
  type PullRequest
} from "@knpkv/codecommit-core/Domain.js"
import type { RlyStateTone } from "@knpkv/rly/primitives"

type DecisionFacts = Pick<PullRequest, "approvedBy" | "isMergeable" | "status">
type StatusFacts = Pick<PullRequest, "approvalUnknown" | "approvalRules" | "isApproved" | "isMergeable" | "status">
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

export interface PullRequestRowStatus {
  readonly label: string
  readonly tone: RlyStateTone
}

/** The row's state label. An unknown approval is labelled as such, never as approved or pending. */
export const pullRequestRowStatus = (pr: StatusFacts): PullRequestRowStatus => {
  if (pr.status === "MERGED") return { label: "Merged", tone: "progress" }
  if (pr.status === "CLOSED") return { label: "Closed", tone: "neutral" }
  if (!pr.isMergeable) return { label: "Conflict", tone: "critical" }
  const approval = approvalOf(pr)
  if (approval._tag === "Unknown") return { label: approvalUnknownLabel, tone: "neutral" }
  if (approval._tag === "NotRequired") return { label: approvalNotRequiredLabel, tone: "neutral" }
  if (approval._tag === "Approved") return { label: "Approved", tone: "positive" }
  return { label: "Pending", tone: "caution" }
}
