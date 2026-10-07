import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import {
  approvalNotRequiredLabel,
  approvalOf,
  ApprovalRule,
  ApprovalUnknownReason,
  approvalUnknownReasonText,
  ApprovalUnknownTag,
  needsMyReview
} from "../src/Domain.js"

describe("approval", () => {
  const rules = [
    Schema.decodeSync(ApprovalRule)({ ruleName: "r", requiredApprovals: 1, poolMembers: [], satisfied: true })
  ]

  it("reads Unknown whenever the last evaluation failed, whatever the last known approval says", () => {
    expect(approvalOf({ isApproved: true, approvalRules: rules, approvalUnknown: { _tag: "Throttled" } }))
      .toEqual({ _tag: "Unknown", reason: { _tag: "Throttled" } })
    expect(approvalOf({ isApproved: true, approvalRules: rules })).toEqual({ _tag: "Approved" })
    expect(approvalOf({ isApproved: false, approvalRules: rules })).toEqual({ _tag: "Pending" })
  })

  // CodeCommit evaluates a pull request with no approval rules as approved: nothing to satisfy, and
  // nobody signed off. That is not "Approved".
  it("reads NotRequired for an approved evaluation with no approval rules", () => {
    expect(approvalOf({ isApproved: true, approvalRules: [] })).toEqual({ _tag: "NotRequired" })
    expect(approvalNotRequiredLabel).toBe("No approval required")
  })

  it("explains every reason in its own words", () => {
    const texts = ApprovalUnknownTag.literals.map((tag) => approvalUnknownReasonText({ _tag: tag }))
    expect(new Set(texts).size).toBe(3)
    expect(texts[0]).toContain("codecommit:EvaluatePullRequestApprovalRules")
  })

  it("names exactly the reasons' tags in the flat tag schema", () => {
    expect([...ApprovalUnknownTag.literals].toSorted()).toEqual(Object.keys(ApprovalUnknownReason.cases).toSorted())
  })

  it("does not claim a review is needed while approval is unknown", () => {
    const rules = [
      Schema.decodeSync(ApprovalRule)({ ruleName: "r", requiredApprovals: 1, poolMembers: ["alice"], satisfied: false })
    ]
    expect(needsMyReview({ approvalRules: rules, approvedBy: [] }, "alice")).toBe(true)
    expect(needsMyReview({ approvalRules: rules, approvedBy: [], approvalUnknown: { _tag: "NotPermitted" } }, "alice"))
      .toBe(false)
  })
})
