import { describe, expect, it } from "@effect/vitest"
import { Domain } from "@knpkv/codecommit-core"
import { Schema } from "effect"
import { renderFlags } from "../src/PrListOutput.js"

const pr = (approval: { readonly isApproved: boolean; readonly approvalUnknown?: Domain.ApprovalUnknownReason }) =>
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
    ...approval
  })

describe("renderFlags", () => {
  it("says approval is unknown instead of showing a last known approval", () => {
    expect(renderFlags(pr({ isApproved: true, approvalUnknown: { _tag: "NotPermitted" } })))
      .toBe("approval unknown mergeable")
    expect(renderFlags(pr({ isApproved: true }))).toBe("approved mergeable")
    expect(renderFlags(pr({ isApproved: false }))).toBe("mergeable")
  })
})
