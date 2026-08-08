import { ReadClient } from "@knpkv/codecommit-core"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { makeRelayReviewPrompt } from "../src/RelayReview.js"
import { buildUnifiedDiff } from "../src/tui/details-model.js"
import { safePathSegment } from "../src/WorktreeService.js"

const decodeChangedFile = Schema.decodeUnknownSync(ReadClient.CodeCommitChangedFile)

describe("PR detail workspace", () => {
  it("keeps local path segments bounded, traversal-safe, and identity-sensitive", () => {
    const traversal = safePathSegment("repo", "../../production/secrets")
    const nearby = safePathSegment("repo", "../../production/secretz")

    expect(traversal).not.toContain("/")
    expect(traversal).not.toBe(".")
    expect(traversal).not.toBe("..")
    expect(traversal.length).toBeLessThan(80)
    expect(nearby).not.toBe(traversal)
  })

  it("builds a valid, bounded immutable blob patch", () => {
    const file = decodeChangedFile({
      status: "modified",
      before: { blobId: "before-blob", path: "src/index.ts", mode: "100644" },
      after: { blobId: "after-blob", path: "src/index.ts", mode: "100644" }
    })
    const before = Array.from({ length: 400 }, (_, index) => `old ${index}`).join("\n")
    const after = Array.from({ length: 400 }, (_, index) => `new ${index}`).join("\n")
    const result = buildUnifiedDiff(file, before, after)

    expect(result.diff).toContain("--- a/src/index.ts")
    expect(result.diff).toContain("+++ b/src/index.ts")
    expect(result.diff).toContain("@@ -1,400 +1,400 @@")
    expect(result.diff).toContain("diff preview truncated")
    expect(result.diff.split("\n").length).toBeLessThanOrEqual(504)
    expect(result.truncated).toBe(true)
  })

  it("binds Relay review instructions to the immutable base and head", () => {
    const prompt = makeRelayReviewPrompt({
      baseCommit: "base-123",
      headCommit: "head-456",
      kind: "review",
      pullRequestId: "42",
      repositoryName: "payments",
      title: "Require signed callbacks",
      worktreePath: "/private/worktree"
    })

    expect(prompt).toContain("CodeCommit PR #42")
    expect(prompt).toContain("Immutable base: base-123")
    expect(prompt).toContain("Immutable head: head-456")
    expect(prompt).toContain("Do not modify files")
    expect(prompt).not.toContain("/private/worktree")
  })
})
