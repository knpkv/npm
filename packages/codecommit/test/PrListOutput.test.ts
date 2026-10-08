import { describe, expect, it } from "@effect/vitest"
import { Domain } from "@knpkv/codecommit-core"
import { Schema } from "effect"
import { renderFlags } from "../src/PrListOutput.js"

const rule = { ruleName: "reviewers", requiredApprovals: 1, poolMembers: [], satisfied: true }

const pr = (approval: {
  readonly isApproved: boolean
  readonly approvalUnknown?: Domain.ApprovalUnknownReason
  readonly rules?: ReadonlyArray<typeof rule>
}) =>
  Schema.decodeSync(Domain.PullRequest)({
    id: "1",
    title: "Fix",
    author: "alice",
    repositoryName: "repo",
    creationDate: new Date(0),
    lastModifiedDate: new Date(0),
    link: "https://example.invalid/pr/1",
    account: { profile: "dev", region: "us-east-1" },
    status: "OPEN",
    sourceBranch: "feature",
    destinationBranch: "main",
    isMergeable: true,
    approvedBy: [],
    commentedBy: [],
    isApproved: approval.isApproved,
    ...(approval.approvalUnknown !== undefined && { approvalUnknown: approval.approvalUnknown }),
    approvalRules: approval.rules ?? [rule]
  })

describe("renderFlags", () => {
  it("says approval is unknown instead of showing a last known approval", () => {
    expect(renderFlags(pr({ isApproved: true, approvalUnknown: { _tag: "NotPermitted" } })))
      .toBe("approval unknown mergeable")
    expect(renderFlags(pr({ isApproved: true }))).toBe("approved mergeable")
    expect(renderFlags(pr({ isApproved: false }))).toBe("mergeable")
    // No rules: CodeCommit reads "approved", but nobody signed off.
    expect(renderFlags(pr({ isApproved: true, rules: [] }))).toBe("no approval required mergeable")
  })
})
