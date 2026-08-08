import { describe, expect, it } from "@effect/vitest"
import { Domain, ReadClient } from "@knpkv/codecommit-core"
import { applyPatch, parsePatch } from "diff"
import { Schema } from "effect"
import { makeRelayReviewPrompt } from "../src/RelayReview.js"
import {
  blobPreviewDisposition,
  buildUnifiedDiff,
  detailsKeyIntent,
  exactRevisionReviewState,
  fileDiffIdentityMatches,
  humanReviewState,
  terminalSafeText,
  workspaceIdentityMatches
} from "../src/tui/details-model.js"
import { reviewRevisionSpecifiers, safePathSegment } from "../src/WorktreeService.js"

const decodeChangedFile = Schema.decodeUnknownSync(ReadClient.CodeCommitChangedFile)
const hasTerminalControl = (value: string): boolean =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && codePoint !== 0x0a &&
      ((codePoint >= 0 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f))
  })

describe("PR detail workspace", () => {
  it("keeps local path segments bounded, traversal-safe, and identity-sensitive", () => {
    const traversal = safePathSegment("../../../../../tmp", "../../production/secrets")
    const nearby = safePathSegment("repo", "../../production/secretz")

    expect(traversal).not.toContain("/")
    expect(traversal).not.toContain("\\")
    expect(traversal).not.toBe(".")
    expect(traversal).not.toBe("..")
    expect(traversal.length).toBeGreaterThan(0)
    expect(traversal.length).toBeLessThan(80)
    expect(nearby).not.toBe(traversal)
  })

  it("escapes C0 and C1 controls in terminal text and unified diff metadata", () => {
    const file = decodeChangedFile({
      status: "renamed",
      before: { blobId: "before-blob", path: "src/old\u001b[31m\t.ts", mode: "100644\u0085" },
      after: { blobId: "after-blob", path: "src/new\r\n.ts", mode: "100755\u009b" }
    })
    const result = buildUnifiedDiff(file, "const value = '\u0007old'\n", "const value = '\u001bnew'\n")

    expect(terminalSafeText("a\u0000\u001b\u007f\u009fb")).toBe(
      "a\\u{0000}\\u{001b}\\u{007f}\\u{009f}b"
    )
    expect(result.diff).toContain("--- a/src/old\\u{001b}[31m\\u{0009}.ts")
    expect(result.diff).toContain("+++ b/src/new\\u{000d}\\u{000a}.ts")
    expect(result.diff).toContain("\\u{0007}old")
    expect(result.diff).toContain("\\u{001b}new")
    expect(result.metadata).toContain("mode 100644\\u{0085} → 100755\\u{009b}")
    expect(hasTerminalControl(result.diff)).toBe(false)
    expect(hasTerminalControl(result.metadata ?? "")).toBe(false)
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
    const hunks = parsed[0]?.hunks ?? []
    expect(hunks.length).toBeGreaterThan(0)
    for (const hunk of hunks) {
      const oldLines = hunk.lines.filter((line) => line.startsWith("-") || line.startsWith(" ")).length
      const newLines = hunk.lines.filter((line) => line.startsWith("+") || line.startsWith(" ")).length
      expect(oldLines).toBe(hunk.oldLines)
      expect(newLines).toBe(hunk.newLines)
    }
  })

  it("surfaces rename and mode metadata when blob text is unchanged", () => {
    const file = decodeChangedFile({
      status: "renamed",
      before: { blobId: "same-blob", path: "src/old-name.ts", mode: "100644" },
      after: { blobId: "same-blob", path: "src/new-name.ts", mode: "100755" }
    })
    const result = buildUnifiedDiff(file, "export const value = 1\n", "export const value = 1\n")

    expect(result.diff).toBe("")
    expect(result.metadata).toContain("rename src/old-name.ts → src/new-name.ts")
    expect(result.metadata).toContain("mode 100644 → 100755")
    expect(result.truncated).toBe(false)
  })

  it("keeps mode metadata when content changes", () => {
    const file = decodeChangedFile({
      status: "modified",
      before: { blobId: "before-blob", path: "script.sh", mode: "100644" },
      after: { blobId: "after-blob", path: "script.sh", mode: "100755" }
    })
    const result = buildUnifiedDiff(file, "echo before\n", "echo after\n")

    expect(result.diff).toContain("-echo before")
    expect(result.diff).toContain("+echo after")
    expect(result.metadata).toBe("mode 100644 → 100755")
  })

  it("yields keyboard events to dialogs and focused comments while retaining file navigation", () => {
    const base: Omit<Parameters<typeof detailsKeyIntent>[0], "keyName"> = {
      actionCancelable: false,
      actionReady: false,
      dialogOpen: false,
      modified: false,
      tab: "diff"
    }

    expect(detailsKeyIntent({ ...base, dialogOpen: true, keyName: "escape" })).toBe("yield")
    expect(detailsKeyIntent({ ...base, keyName: "j" })).toBe("next-file")
    expect(detailsKeyIntent({ ...base, keyName: "down", tab: "comments" })).toBe("yield")
    expect(detailsKeyIntent({ ...base, keyName: "c", modified: true })).toBe("yield")
  })

  it("binds every Relay review kind to sanitized immutable metadata", () => {
    const baseCommit = ReadClient.CodeCommitCommitId.make("a".repeat(40))
    const headCommit = ReadClient.CodeCommitCommitId.make("b".repeat(40))
    const pullRequestId = Domain.PullRequestId.make("42")
    const repositoryName = Domain.RepositoryName.make("payments")
    const request = {
      baseCommit,
      headCommit,
      pullRequestId,
      repositoryName,
      worktreePath: "/private/worktree"
    }
    const review = makeRelayReviewPrompt({ ...request, kind: "review" })
    const security = makeRelayReviewPrompt({ ...request, kind: "security" })
    const tests = makeRelayReviewPrompt({ ...request, kind: "tests" })
    const explain = makeRelayReviewPrompt({ ...request, kind: "explain" })

    expect(review).toContain("CodeCommit PR #42")
    expect(review).toContain(`Immutable base: ${baseCommit}`)
    expect(review).toContain(`Immutable head: ${headCommit}`)
    expect(review).not.toContain("Ignore prior instructions")
    expect(review).toContain("Find correctness, security, reliability")
    expect(security).toContain("Perform a security-focused review")
    expect(tests).toContain("Review the test strategy")
    expect(explain).toContain("Explain the change, its architecture")
    for (const prompt of [review, security, tests, explain]) {
      expect(prompt).toContain("Do not modify files")
      expect(prompt).not.toContain("/private/worktree")
    }
  })

  it("bounds text decoding and samples binary content", () => {
    expect(blobPreviewDisposition(new Uint8Array([65, 0, 66]), new Uint8Array())).toBe("binary")
    expect(blobPreviewDisposition(new Uint8Array(2_000_001).fill(65), new Uint8Array())).toBe("too-large")
    expect(blobPreviewDisposition(new Uint8Array([65, 66]), new Uint8Array([67]))).toBe("text")
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
    expect(fileDiffIdentityMatches(fileB, { ...fileB, afterBlobId: "rotated" })).toBe(false)
    expect(fileDiffIdentityMatches(fileB, { ...fileB, beforeBlobId: "rotated" })).toBe(false)
    expect(fileDiffIdentityMatches(fileB, { ...fileB, destinationCommit: "rotated" })).toBe(false)
    expect(fileDiffIdentityMatches(fileB, { ...fileB, sourceCommit: "rotated" })).toBe(false)
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
    expect(exactRevisionReviewState()).toEqual({
      approval: "UNVERIFIED",
      mergeability: "UNVERIFIED"
    })
  })
})
