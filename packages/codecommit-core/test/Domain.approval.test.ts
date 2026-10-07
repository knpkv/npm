import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import {
  approvalOf,
  ApprovalRule,
  ApprovalUnknownReason,
  approvalUnknownReasonText,
  ApprovalUnknownTag,
  needsMyReview
} from "../src/Domain.js"

describe("approval", () => {
  it("reads Unknown whenever the last evaluation failed, whatever the last known approval says", () => {
    expect(approvalOf({ isApproved: true, approvalUnknown: { _tag: "Throttled" } }))
      .toEqual({ _tag: "Unknown", reason: { _tag: "Throttled" } })
    expect(approvalOf({ isApproved: true })).toEqual({ _tag: "Approved" })
    expect(approvalOf({ isApproved: false })).toEqual({ _tag: "Pending" })
  })

  it("explains every reason in its own words", () => {
    const texts = ApprovalUnknownTag.literals.map((tag) => approvalUnknownReasonText({ _tag: tag }))
    expect(new Set(texts).size).toBe(3)
    expect(texts[0]).toContain("codecommit:EvaluatePullRequestApprovalRules")
  })

  it("names exactly the reasons' tags in the flat tag schema", () => {
    expect([...ApprovalUnknownTag.literals].sort()).toEqual(Object.keys(ApprovalUnknownReason.cases).sort())
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
