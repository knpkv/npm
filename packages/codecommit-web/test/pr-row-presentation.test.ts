import { describe, expect, it } from "@effect/vitest"

import {
  pullRequestRowDecision,
  pullRequestRowStatus,
  pullRequestRowTimeLabel,
  pullRequestRowTimestamp
} from "../src/client/components/pr-row-presentation.js"

describe("pull request row presentation", () => {
  it("uses neutral actions for terminal pull requests regardless of stale mergeability", () => {
    expect(pullRequestRowDecision({ approvedBy: [], isMergeable: false, status: "CLOSED" })).toEqual({
      actionLabel: "View pull request",
      summary: "Closed"
    })
    expect(pullRequestRowDecision({ approvedBy: [], isMergeable: false, status: "MERGED" })).toEqual({
      actionLabel: "View pull request",
      summary: "Merged"
    })
  })

  it("keeps conflict language for an open non-mergeable pull request", () => {
    expect(pullRequestRowDecision({ approvedBy: [], isMergeable: false, status: "OPEN" })).toEqual({
      actionLabel: "Inspect conflict",
      summary: "Merge blocked"
    })
  })

  it("says approvers are unknown instead of counting a last known list", () => {
    expect(pullRequestRowDecision({ approvedBy: ["alice"], approversUnknown: true, isMergeable: true, status: "OPEN" }))
      .toEqual({ actionLabel: "Open review", summary: "Approvers unknown" })
    expect(pullRequestRowDecision({ approvedBy: ["alice"], isMergeable: true, status: "OPEN" })).toEqual({
      actionLabel: "Open review",
      summary: "1 approval"
    })
  })

  it("matches the machine timestamp to the visible event", () => {
    const creationDate = new Date("2026-08-01T09:00:00.000Z")
    const lastModifiedDate = new Date("2026-08-11T17:30:00.000Z")
    const pr = { creationDate, lastModifiedDate }

    expect(pullRequestRowTimestamp(pr, true)).toBe(lastModifiedDate)
    expect(pullRequestRowTimestamp(pr, false)).toBe(creationDate)
    expect(pullRequestRowTimeLabel(pr, true, new Date("2026-08-11T18:30:00.000Z"))).toBe("Updated 1h ago")
    expect(pullRequestRowTimeLabel(pr, false, new Date("2026-08-11T18:30:00.000Z"))).toBe(
      "Opened 01.08.2026"
    )
  })

  it("labels an unknown approval as unknown, whatever its last known value", () => {
    const open = {
      isMergeable: true,
      status: "OPEN",
      approvalRules: [{
        ruleName: "reviewers",
        requiredApprovals: 1,
        poolMembers: [],
        poolMemberArns: [],
        satisfied: true
      }]
    } satisfies Partial<Parameters<typeof pullRequestRowStatus>[0]>
    expect(pullRequestRowStatus({ ...open, isApproved: true, approvalUnknown: { _tag: "NotPermitted" } }))
      .toEqual({
        label: "Approval unknown",
        reason: "Not allowed to check approval rules (codecommit:EvaluatePullRequestApprovalRules).",
        tone: "neutral"
      })
    expect(pullRequestRowStatus({ ...open, isApproved: true })).toEqual({ label: "Approved", tone: "positive" })
    expect(pullRequestRowStatus({ ...open, isApproved: false })).toEqual({ label: "Pending", tone: "caution" })
    expect(pullRequestRowStatus({ ...open, isApproved: true, approvalRules: [] }))
      .toEqual({ label: "No approval required", tone: "neutral" })
  })
})
