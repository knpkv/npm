import { describe, expect, it } from "@effect/vitest"
import { approvalOf, ApprovalUnknownReason, approvalUnknownReasonText, ApprovalUnknownTag } from "../src/Domain.js"

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
    expect([...ApprovalUnknownTag.literals].toSorted()).toEqual(Object.keys(ApprovalUnknownReason.cases).toSorted())
  })
})
