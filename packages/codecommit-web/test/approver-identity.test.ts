import { describe, expect, it } from "@effect/vitest"

import { normalizeApproverIdentity, refreshFailureDescription } from "../src/client/components/pr-detail.js"
import { fileIndexForFinding } from "../src/client/components/pr-review-workspace.js"
import type { PullRequestDiffResponse, RelayReviewFinding } from "../src/server/Api.js"

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

describe("pull request review client guardrails", () => {
  it("falls back when a refresh Error has no usable message", () => {
    expect(refreshFailureDescription(new Error("   "))).toBe("Try the refresh again.")
    expect(refreshFailureDescription(new Error("Provider unavailable"))).toBe("Provider unavailable")
  })

  it("selects line findings using the path on their exact diff side", () => {
    const files = [{
      index: 0,
      status: "deleted",
      path: "src/retry.ts",
      previousPath: null,
      beforeMode: "100644",
      afterMode: null
    }, {
      index: 1,
      status: "renamed",
      path: "src/retry.ts",
      previousPath: "src/old-retry.ts",
      beforeMode: "100644",
      afterMode: "100644"
    }] satisfies PullRequestDiffResponse["files"]
    const finding = {
      id: "F1",
      priority: "P2",
      title: "After-side finding",
      summary: "Select the renamed file.",
      details: "The deleted file has no after side.",
      recommendation: "Match the requested diff side.",
      verification: "Exact path fixture.",
      publicationTarget: "line-comment",
      location: { scope: "line", filePath: "src/retry.ts", line: 1, side: "after" }
    } satisfies RelayReviewFinding

    expect(fileIndexForFinding(files, finding)).toBe(1)
    expect(fileIndexForFinding(files, {
      ...finding,
      location: { scope: "line", filePath: "src/old-retry.ts", line: 1, side: "before" }
    })).toBe(1)
  })
})
