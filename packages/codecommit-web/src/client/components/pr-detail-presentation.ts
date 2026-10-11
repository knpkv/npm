import type * as Domain from "@knpkv/codecommit-core/Domain.js"
import {
  approvalOf,
  approvalUnknownLabel,
  approvalUnknownReasonText,
  currentApprovers,
  identityMatches
} from "@knpkv/codecommit-core/Domain.js"
import type { CategoryStatus, getScoreTier } from "@knpkv/codecommit-core/HealthScore.js"
import type { RlyNoticeTone, RlyStateTone } from "@knpkv/rly/primitives"
import * as Predicate from "effect/Predicate"

export const healthTone = (tier: ReturnType<typeof getScoreTier>): RlyStateTone =>
  tier === "green" ? "positive" : tier === "yellow" ? "caution" : "critical"

export const categoryTone = (status: CategoryStatus): RlyStateTone =>
  status === "positive" ? "positive" : status === "neutral" ? "neutral" : "critical"

export const refreshFailureDescription = (cause: unknown): string => {
  const message = Predicate.isError(cause) ? cause.message.trim() : ""
  return message.length > 0 ? message : "Try the refresh again."
}

/** Why the first read of a pull request that is not cached failed, and whether Settings → Accounts fixes it. */
export interface PullRequestLoadFailure {
  readonly message: string
  readonly fixInSettings: boolean
}

export const pullRequestLoadFailure = (cause: unknown): PullRequestLoadFailure => ({
  message: refreshFailureDescription(cause),
  fixInSettings: Predicate.isTagged(cause, "AccountSwitchedOffApiError") ||
    Predicate.isTagged(cause, "AccountUnknownApiError")
})

/**
 * Whether someone other than the author signed off, as review evidence for time to first review. Any
 * sign-off counts: one of two required, or a voluntary one where no rules apply. An unknown approval
 * holds only a last known one, so it doesn't; nor do approvers that couldn't be read.
 */
export const signedOffByOthers = (pr: Domain.PullRequest): boolean =>
  approvalOf(pr)._tag !== "Unknown" && currentApprovers(pr).some((approver) => !identityMatches(approver, pr.author))

export const normalizeApproverIdentity = (input: string, repoAccountId: string): string | undefined => {
  const trimmed = input.trim()
  if (trimmed.length === 0 || repoAccountId.length === 0) return undefined
  return trimmed.startsWith("CodeCommitApprovers:") ? trimmed : `CodeCommitApprovers:${repoAccountId}:${trimmed}`
}

interface PullRequestDecisionPresentation {
  readonly reason: string
  readonly tone: RlyNoticeTone
  readonly verdict: string
}

export const pullRequestDecision = (pr: Domain.PullRequest): PullRequestDecisionPresentation => {
  switch (pr.status) {
    case "MERGED":
      return {
        reason: `CodeCommit reports this pull request merged into ${pr.destinationBranch}.`,
        tone: "positive",
        verdict: "Merged."
      }
    case "CLOSED":
      return {
        reason: "CodeCommit reports this pull request closed without a merge.",
        tone: "neutral",
        verdict: "Closed."
      }
    case "OPEN": {
      const approval = approvalOf(pr)
      if (!pr.isMergeable) {
        const conflict = `Resolve the conflict between ${pr.sourceBranch} and ${pr.destinationBranch} before merging.`
        return {
          // The conflict decides the verdict; an unknown approval still says why.
          reason: approval._tag === "Unknown" ? `${conflict} ${approvalUnknownReasonText(approval.reason)}` : conflict,
          tone: "critical",
          verdict: "Resolve conflicts."
        }
      }
      if (approval._tag === "Unknown") {
        return {
          reason: approvalUnknownReasonText(approval.reason),
          tone: "caution",
          verdict: `${approvalUnknownLabel}.`
        }
      }
      if (approval._tag === "Pending") {
        return {
          reason: "The branch is mergeable, but its provider approval is still pending.",
          tone: "caution",
          verdict: "Review pending."
        }
      }
      return {
        reason: approval._tag === "NotRequired"
          ? "CodeCommit reports a clean merge, and no approval rules apply to this pull request."
          : "CodeCommit reports a clean merge and the provider approval is satisfied.",
        tone: "positive",
        verdict: "Ready to merge."
      }
    }
  }
}

export const pullRequestStatusTone = (status: Domain.PullRequest["status"]): RlyStateTone =>
  status === "MERGED" ? "positive" : status === "CLOSED" ? "neutral" : "progress"
