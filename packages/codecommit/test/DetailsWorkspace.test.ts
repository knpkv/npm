import { Domain, ReadClient } from "@knpkv/codecommit-core"
import { applyPatch, parsePatch } from "diff"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { makeRelayReviewPrompt } from "../src/RelayReview.js"
import {
  buildUnifiedDiff,
  fileDiffIdentityMatches,
  humanReviewState,
  workspaceIdentityMatches
} from "../src/tui/details-model.js"
import { reviewRevisionSpecifiers, safePathSegment } from "../src/WorktreeService.js"

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

  it("builds a real immutable blob patch without hiding a late changed line", () => {
    const file = decodeChangedFile({
      status: "modified",
      before: { blobId: "before-blob", path: "src/index.ts", mode: "100644" },
      after: { blobId: "after-blob", path: "src/index.ts", mode: "100644" }
    })
    const before = Array.from({ length: 301 }, (_, index) => `shared ${index}`).join("\n")
    const afterLines = Array.from({ length: 301 }, (_, index) => `shared ${index}`)
    afterLines[300] = "changed at the end"
    const after = afterLines.join("\n")
    const result = buildUnifiedDiff(file, before, after)

    expect(result.diff).toContain("--- a/src/index.ts")
    expect(result.diff).toContain("+++ b/src/index.ts")
    expect(result.diff).toContain("-shared 300")
    expect(result.diff).toContain("+changed at the end")
    expect(result.diff).not.toContain("-shared 0")
    expect(applyPatch(before, result.diff)).toBe(after)
    expect(result.truncated).toBe(false)
  })

  it("bounds only at complete parseable hunks and keeps truncation out of source lines", () => {
    const file = decodeChangedFile({
      status: "modified",
      before: { blobId: "before-blob", path: "src/large.ts", mode: "100644" },
      after: { blobId: "after-blob", path: "src/large.ts", mode: "100644" }
    })
    const before = Array.from({ length: 2_000 }, (_, index) => `shared ${index}`).join("\n")
    const after = Array.from(
      { length: 2_000 },
      (_, index) => index % 12 === 0 ? `changed ${index}` : `shared ${index}`
    ).join("\n")
    const result = buildUnifiedDiff(file, before, after)

    expect(result.truncated).toBe(true)
    expect(result.diff.split("\n").length).toBeLessThanOrEqual(500)
    expect(result.diff).not.toContain("preview truncated")
    const parsed = parsePatch(result.diff)
    for (const hunk of parsed[0]?.hunks ?? []) {
      const oldLines = hunk.lines.filter((line) => line.startsWith("-") || line.startsWith(" ")).length
      const newLines = hunk.lines.filter((line) => line.startsWith("+") || line.startsWith(" ")).length
      expect(oldLines).toBe(hunk.oldLines)
      expect(newLines).toBe(hunk.newLines)
    }
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

  it("requires both divergent revisions before a Relay checkout is ready", () => {
    const revisions = reviewRevisionSpecifiers({
      account: new Domain.Account({
        profile: Domain.AwsProfileName.make("production"),
        region: Domain.AwsRegion.make("eu-west-1")
      }),
      destinationCommit: ReadClient.CodeCommitCommitId.make("a".repeat(40)),
      pullRequestId: Domain.PullRequestId.make("42"),
      repositoryName: Domain.RepositoryName.make("payments"),
      sourceCommit: ReadClient.CodeCommitCommitId.make("b".repeat(40))
    })

    expect(revisions).toEqual(["a".repeat(40), "b".repeat(40)])
  })

  it("rejects stale workspace and blob identities across PR transitions", () => {
    const workspaceA = {
      profile: "production",
      pullRequestId: "41",
      region: "eu-west-1",
      repositoryName: "payments"
    }
    const workspaceB = { ...workspaceA, pullRequestId: "42" }
    const fileA = {
      ...workspaceA,
      afterBlobId: "after-a",
      beforeBlobId: "before-a",
      destinationCommit: "base-a",
      sourceCommit: "head-a"
    }
    const fileB = {
      ...workspaceB,
      afterBlobId: "after-b",
      beforeBlobId: "before-b",
      destinationCommit: "base-b",
      sourceCommit: "head-b"
    }

    expect(workspaceIdentityMatches(workspaceA, workspaceB)).toBe(false)
    expect(workspaceIdentityMatches(workspaceB, workspaceB)).toBe(true)
    expect(fileDiffIdentityMatches(fileA, fileB)).toBe(false)
    expect(fileDiffIdentityMatches(fileB, fileB)).toBe(true)
  })

  it("keeps approval and mergeability independent", () => {
    expect(humanReviewState({ isApproved: true, isMergeable: false })).toEqual({
      approval: "APPROVED",
      mergeability: "CONFLICTS"
    })
    expect(humanReviewState({ isApproved: false, isMergeable: true })).toEqual({
      approval: "NEEDS REVIEW",
      mergeability: "MERGEABLE"
    })
  })
})
