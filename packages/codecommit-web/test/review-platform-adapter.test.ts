import { describe, expect, it } from "@effect/vitest"
import type { ReviewProfileConfig } from "@knpkv/codecommit-core/ReviewProfile.js"

import {
  codeCommitReviewIdentity,
  codeCommitReviewProfile,
  codeCommitReviewThread
} from "../src/client/review-platform-adapter.js"

const profile: ReviewProfileConfig = {
  id: "tests",
  name: "Test review",
  kind: "tests",
  provider: "codex",
  harness: "native-codex",
  model: "gpt-5.6-terra",
  skillIds: ["builtin:pr-review-diff"]
}

const diff = {
  revisionId: "revision-1",
  baseCommit: "a".repeat(40),
  headCommit: "b".repeat(40)
}

describe("CodeCommit review platform adapter", () => {
  it("maps the complete browser-safe execution profile", () => {
    expect(codeCommitReviewProfile(profile)).toEqual(profile)
  })

  it("binds one thread to the account, pull request, and exact revision", () => {
    expect(codeCommitReviewThread("111111111111", "35", diff)).toEqual({
      namespace: "codecommit",
      subjectId: "111111111111/35",
      revisionId: "revision-1",
      baseRevision: "a".repeat(40),
      headRevision: "b".repeat(40)
    })
    expect(codeCommitReviewIdentity("111111111111", "35", diff)).not.toBe(
      codeCommitReviewIdentity("111111111111", "35", { ...diff, headCommit: "c".repeat(40) })
    )
  })
})
