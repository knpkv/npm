import { describe, expect, it } from "@effect/vitest"
import { Domain, ReadClient } from "@knpkv/codecommit-core"
import {
  makeRelayReviewConversationPrompt,
  makeRelayReviewVerificationPrompt,
  parseRelayReviewConversationResult,
  parseRelayReviewVerificationResult,
  relayFindingPublicationOptions,
  type RelayReviewConversationRequest,
  type RelayReviewFinding,
  type RelayReviewResult,
  type RelayReviewVerificationRequest
} from "../src/RelayReview.js"
import {
  adjacentFindingIndex,
  consistentRelayVerificationOutcome,
  nextPendingFindingIndex,
  reconcileRelayReviewSession,
  relayReviewReconciliationLabel
} from "../src/tui/review-session.js"

const finding = (
  id: string,
  title: string,
  location: RelayReviewFinding["location"],
  publicationTarget: RelayReviewFinding["publicationTarget"]
): RelayReviewFinding => ({
  id,
  priority: "P2",
  title,
  summary: `${title} summary`,
  details: `${title} details`,
  recommendation: `${title} recommendation`,
  verification: "Static patch review only.",
  publicationTarget,
  location
})

const initialReview: RelayReviewResult = {
  findings: [
    finding("F1", "Guard authorization", {
      scope: "line",
      filePath: "src/auth.ts",
      line: 42,
      side: "after"
    }, "line-comment"),
    finding("F2", "Explain rollout", { scope: "general" }, "description")
  ],
  verdict: "Two findings need review."
}

describe("Relay review session", () => {
  it("offers only publication targets supported by the evidence coordinate", () => {
    expect(relayFindingPublicationOptions(initialReview.findings[0]!)).toEqual([
      "description",
      "pr-comment",
      "file-comment",
      "line-comment"
    ])
    expect(relayFindingPublicationOptions(initialReview.findings[1]!)).toEqual([
      "description",
      "pr-comment"
    ])
  })

  it("wraps card navigation and jumps directly to the next unresolved finding", () => {
    const ids = ["F1", "F2", "F3"]
    expect(adjacentFindingIndex(ids.length, 0, -1)).toBe(2)
    expect(adjacentFindingIndex(ids.length, 2, 1)).toBe(0)
    expect(nextPendingFindingIndex(ids, { F1: "acknowledged", F2: "posted" }, 0)).toBe(2)
    expect(nextPendingFindingIndex(ids, { F1: "pending", F2: "posted", F3: "rejected" }, 2)).toBe(0)
  })

  it("reopens changed decisions and never pretends an already-posted copy was updated", () => {
    const previous: RelayReviewResult = {
      findings: [
        finding("F1", "One", { scope: "general" }, "pr-comment"),
        finding("F2", "Two", { scope: "file", filePath: "src/two.ts" }, "file-comment"),
        finding("F4", "Removed", { scope: "general" }, "description")
      ],
      verdict: "Before"
    }
    const next: RelayReviewResult = {
      findings: [
        finding("F1", "One revised", { scope: "general" }, "description"),
        finding("F2", "Two revised", { scope: "file", filePath: "src/two.ts" }, "file-comment"),
        finding("F3", "Added", { scope: "general" }, "pr-comment")
      ],
      verdict: "After"
    }
    const result = reconcileRelayReviewSession(previous, next, {
      F1: "posted",
      F2: "acknowledged",
      F4: "rejected"
    })

    expect(result.dispositions).toEqual({ F1: "posted-stale", F2: "pending", F3: "pending" })
    expect(result.reconciliation).toEqual({
      added: ["F3"],
      changed: ["F1", "F2"],
      removed: ["F4"],
      reopened: ["F2"]
    })
    expect(relayReviewReconciliationLabel(result.reconciliation)).toBe("+1 · ~2 · -1 · 1 reopened")
  })

  it("keeps one finding conversation attached while asking the agent to reconcile the full deck", () => {
    const request: RelayReviewConversationRequest = {
      baseCommit: ReadClient.CodeCommitCommitId.make("a".repeat(40)),
      currentReview: initialReview,
      headCommit: ReadClient.CodeCommitCommitId.make("b".repeat(40)),
      kind: "review",
      message: "Does the existing authorization layer already cover this?",
      pullRequestId: Domain.PullRequestId.make("35"),
      repositoryName: Domain.RepositoryName.make("control-center"),
      selectedFindingId: "F1",
      skills: ["pr-review-diff"],
      turns: [{ findingId: "F1", role: "user", message: "Check the authorization layer." }],
      worktreePath: "/review/worktree"
    }
    const prompt = makeRelayReviewConversationPrompt(request, "+const guarded = true")

    expect(prompt).toContain("discussing finding F1")
    expect(prompt).toContain("review-session-wide in effect")
    expect(prompt).toContain("may revise, add, merge, or withdraw other findings")
    expect(prompt).toContain("Guard authorization")
    expect(prompt).toContain("No conversation turn authorizes publishing")

    const decoded = parseRelayReviewConversationResult(
      JSON.stringify({
        reply: "The layer does not cover this path.",
        review: initialReview
      }),
      { findings: [], verdict: "fallback" }
    )
    expect(decoded.reply).toBe("The layer does not cover this path.")
    expect(decoded.review.findings.map((item) => item.id)).toEqual(["F1", "F2"])
  })

  it("verifies one finding on the latest head while reconciling the complete deck", () => {
    const request: RelayReviewVerificationRequest = {
      baseCommit: ReadClient.CodeCommitCommitId.make("c".repeat(40)),
      currentReview: initialReview,
      headCommit: ReadClient.CodeCommitCommitId.make("d".repeat(40)),
      kind: "review",
      previousBaseCommit: ReadClient.CodeCommitCommitId.make("a".repeat(40)),
      previousHeadCommit: ReadClient.CodeCommitCommitId.make("b".repeat(40)),
      pullRequestId: Domain.PullRequestId.make("35"),
      repositoryName: Domain.RepositoryName.make("control-center"),
      selectedFindingId: "F1",
      skills: ["pr-review", "pr-review-diff"],
      turns: [{ findingId: "F1", role: "assistant", message: "Authorization is bypassed." }],
      worktreePath: "/review/latest-worktree"
    }
    const prompt = makeRelayReviewVerificationPrompt(request, "+const guarded = true")

    expect(prompt).toContain("Verify finding F1")
    expect(prompt).toContain(`Previously reviewed head: ${"b".repeat(40)}`)
    expect(prompt).toContain(`Latest immutable head: ${"d".repeat(40)}`)
    expect(prompt).toContain("review-session-wide in effect")
    expect(prompt).toContain("No verification authorizes publishing")

    const resolvedReview: RelayReviewResult = {
      findings: [initialReview.findings[1]!],
      verdict: "The authorization concern is resolved."
    }
    const decoded = parseRelayReviewVerificationResult(
      JSON.stringify({
        outcome: "resolved",
        reply: "The author moved authorization before the early return.",
        review: resolvedReview
      }),
      initialReview
    )
    expect(decoded.outcome).toBe("resolved")
    expect(consistentRelayVerificationOutcome("F1", decoded.review, decoded.outcome)).toBe("resolved")
    expect(consistentRelayVerificationOutcome("F2", decoded.review, "resolved")).toBe("inconclusive")

    const malformed = parseRelayReviewVerificationResult("not-json", initialReview)
    expect(malformed.outcome).toBe("inconclusive")
    expect(malformed.review).toBe(initialReview)
  })
})
