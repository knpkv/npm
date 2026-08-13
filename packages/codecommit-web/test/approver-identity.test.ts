import { describe, expect, it } from "@effect/vitest"

import { normalizeApproverIdentity } from "../src/client/components/pr-detail.js"

describe("normalizeApproverIdentity", () => {
  it("rejects bare usernames when the repository account is unavailable", () => {
    expect(normalizeApproverIdentity("andrey", "")).toBeUndefined()
  })

  it("creates and preserves complete CodeCommit approver identities", () => {
    expect(normalizeApproverIdentity("andrey", "123456789012")).toBe(
      "CodeCommitApprovers:123456789012:andrey"
    )
    expect(normalizeApproverIdentity("CodeCommitApprovers:123456789012:andrey", "123456789012")).toBe(
      "CodeCommitApprovers:123456789012:andrey"
    )
  })
})
