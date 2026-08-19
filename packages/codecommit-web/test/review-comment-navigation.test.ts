import { describe, expect, it } from "@effect/vitest"

import {
  fileIndexForComment,
  isCommentOnExactRevision,
  reviewCommentNavigationTarget
} from "../src/client/review-comment-navigation.js"

const location = {
  beforeCommitId: "a".repeat(40),
  afterCommitId: "b".repeat(40),
  filePath: "src/retry.ts",
  relativeFileVersion: "AFTER"
} satisfies Parameters<typeof reviewCommentNavigationTarget>[0]

describe("review comment navigation", () => {
  it("builds and resolves an exact-head line target", () => {
    const target = reviewCommentNavigationTarget(location, {
      id: "comment-1",
      author: "reviewer",
      content: "Keep this idempotent.",
      lineNumber: 7
    })

    expect(target).not.toBeNull()
    if (target === null) return
    expect(isCommentOnExactRevision(target, { baseCommit: "a".repeat(40), headCommit: "b".repeat(40) })).toBe(true)
    expect(fileIndexForComment([
      { index: 0, status: "modified", path: "src/retry.ts", previousPath: null }
    ], target)).toBe(0)
  })

  it("rejects general comments and stale revisions", () => {
    expect(reviewCommentNavigationTarget(location, {
      id: "comment-1",
      author: "reviewer",
      content: "General feedback."
    })).toBeNull()

    const target = reviewCommentNavigationTarget(location, {
      id: "comment-1",
      author: "reviewer",
      content: "Keep this idempotent.",
      lineNumber: 7
    })
    expect(target).not.toBeNull()
    if (target === null) return
    expect(isCommentOnExactRevision(target, { baseCommit: "a".repeat(40), headCommit: "c".repeat(40) })).toBe(false)
  })

  it("maps before-side comments to the previous renamed path", () => {
    const target = reviewCommentNavigationTarget({ ...location, relativeFileVersion: "BEFORE" }, {
      id: "comment-2",
      author: "reviewer",
      content: "Removed behavior.",
      filePath: "src/old-retry.ts",
      lineNumber: 3
    })

    expect(target).not.toBeNull()
    if (target === null) return
    expect(fileIndexForComment([
      { index: 4, status: "renamed", path: "src/retry.ts", previousPath: "src/old-retry.ts" }
    ], target)).toBe(4)
  })
})
