import { expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { PullRequestRelayReviewResponse } from "../src/server/Api.js"
import { reviewRunOfResponse } from "../src/server/review/review-run-projection.js"

const response = Schema.decodeUnknownSync(PullRequestRelayReviewResponse)({
  pullRequestId: "35",
  revisionId: "revision-1",
  baseCommit: "base-1",
  headCommit: "head-1",
  kind: "review",
  profile: {
    id: "review",
    name: "Review",
    kind: "review",
    provider: "codex",
    harness: "native-codex",
    model: "configured-default",
    skillIds: []
  },
  result: {
    verdict: "Check the storage boundary",
    findings: [{
      id: "F1",
      priority: "P0",
      title: "A draft crosses agents",
      summary: "Storage lacks the agent identity.",
      details: "Changing agents restores the previous draft.",
      recommendation: "Include the agent in the key.",
      verification: "Switch agents with a draft open.",
      publicationTarget: "line-comment",
      location: { scope: "line", filePath: "src/main.ts", line: 42, side: "after" }
    }]
  }
})

it.effect("legacy review output retains its anchor and prose without fabricated patch or provenance", () =>
  Effect.gen(function*() {
    const run = yield* reviewRunOfResponse("pr-35", response, "run-1", 1_000)
    const [thread] = run.threads
    expect(thread?.anchor).toEqual({ _tag: "Line", path: "src/main.ts", line: 42, side: "after", outdated: false })
    expect(thread?.finding).toMatchObject({
      severity: "P0",
      summary: "Storage lacks the agent identity.",
      axis: null,
      confidence: null,
      patch: null,
      disposition: { _tag: "Open" }
    })
    expect(run.rules).toBeNull()
    expect(run.risks).toBeNull()
    expect(run.identity.headRevision).toBe("head-1")
  }))

it.effect("retains Explain output independently of findings", () =>
  Effect.gen(function*() {
    const explain = Schema.decodeUnknownSync(PullRequestRelayReviewResponse)({
      ...response,
      kind: "explain",
      profile: { ...response.profile, kind: "explain" },
      result: { verdict: "Storage keys changed", findings: [], explanation: "The key now includes the selected agent." }
    })
    const run = yield* reviewRunOfResponse("pr-35", explain, "run-2", 2_000)
    expect(run.explanation).toBe(explain.result.explanation)
    expect(run.threads).toEqual([])
  }))
