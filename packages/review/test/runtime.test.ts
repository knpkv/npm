import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  presentReviewResult,
  resolveReviewProfile,
  ReviewExecutionProfile,
  type ReviewThreadIdentity
} from "../src/index.js"

const profile = Schema.decodeSync(ReviewExecutionProfile)({
  id: "security",
  name: "Security review",
  kind: "security",
  provider: "codex",
  harness: "native-codex",
  model: "gpt-5.6-sol",
  skillIds: ["builtin:pr-review-diff"]
})

const identity: ReviewThreadIdentity = {
  namespace: "codecommit",
  subjectId: "account-a/pr-35",
  revisionId: "revision-1",
  baseRevision: "base-1",
  headRevision: "head-1"
}

describe("review runtime", () => {
  it("rejects an unknown explicit profile instead of mixing it with the default", () => {
    expect(resolveReviewProfile([profile], "missing", profile.id)).toEqual({
      _tag: "Unknown",
      profileId: "missing"
    })
  })

  it("retains the exact profile metadata and labels output previous after a failed rerun", () => {
    const completed = { identity, profile, result: { verdict: "No issues" } }
    expect(presentReviewResult(identity, completed, true)).toEqual({ _tag: "Previous", completed })
  })

  it("marks a result from another immutable revision stale", () => {
    const completed = { identity, profile, result: { verdict: "No issues" } }
    expect(
      presentReviewResult({ ...identity, headRevision: "head-2", revisionId: "revision-2" }, completed, false)
    ).toEqual({ _tag: "Stale", completed })
  })
})
