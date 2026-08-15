// @vitest-environment happy-dom

import { describe, expect, it } from "@effect/vitest"

import {
  readRelayReviewSession,
  relayReviewSessionStorageKey,
  writeRelayReviewSession
} from "../src/client/review-session-storage.js"
import type { PullRequestRelayReviewResponse } from "../src/server/Api.js"

const review: PullRequestRelayReviewResponse = {
  pullRequestId: "42",
  revisionId: "revision-1",
  baseCommit: "a".repeat(40),
  headCommit: "b".repeat(40),
  kind: "review",
  result: {
    verdict: "One finding.",
    findings: [{
      id: "F1",
      priority: "P2",
      title: "Retry amplification",
      summary: "Retries can duplicate a request.",
      details: "The retry path lacks an idempotency key.",
      recommendation: "Require an idempotency key.",
      verification: "Static review.",
      publicationTarget: "line-comment",
      location: { scope: "line", filePath: "src/retry.ts", line: 1, side: "after" }
    }]
  }
}

describe("Relay review session storage", () => {
  it("restores a bounded conversation only for the exact review identity", () => {
    const key = relayReviewSessionStorageKey("111111111111", "42")
    writeRelayReviewSession(window.sessionStorage, key, {
      identity: "exact-head-1",
      review,
      turns: [{ findingId: "F1", role: "user", message: "Verify this again." }],
      dispositions: { F1: "rejected" }
    })

    expect(readRelayReviewSession(window.sessionStorage, key, "exact-head-1")).toMatchObject({
      turns: [{ message: "Verify this again." }],
      dispositions: { F1: "rejected" }
    })
    expect(readRelayReviewSession(window.sessionStorage, key, "exact-head-2")).toBeNull()
  })

  it("rejects malformed stored state", () => {
    const key = relayReviewSessionStorageKey("111111111111", "42")
    window.sessionStorage.setItem(key, JSON.stringify({ identity: "exact-head-1", turns: "not-an-array" }))

    expect(readRelayReviewSession(window.sessionStorage, key, "exact-head-1")).toBeNull()
  })
})
