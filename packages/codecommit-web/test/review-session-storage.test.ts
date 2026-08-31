// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "@effect/vitest"
import * as Result from "effect/Result"

import {
  readRelayReviewSession,
  type RelayReviewSessionResourceIdentity,
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

const resource: RelayReviewSessionResourceIdentity = {
  accountId: "111111111111",
  pullRequestId: "42",
  repositoryName: "payments"
}

describe("Relay review session storage", () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
  })

  it("restores one durable PR conversation across exact heads", () => {
    const key = relayReviewSessionStorageKey(resource)
    writeRelayReviewSession(window.localStorage, key, {
      identity: "exact-head-1",
      resource,
      review,
      skillIds: ["builtin:pr-review"],
      turns: [{ findingId: "F1", role: "user", message: "Verify this again." }],
      dispositions: { F1: "rejected" }
    })

    const restored = readRelayReviewSession(window.localStorage, key, resource)
    expect(Result.isSuccess(restored)).toBe(true)
    if (Result.isSuccess(restored)) {
      expect(restored.success).toMatchObject({
        skillIds: ["builtin:pr-review"],
        turns: [{ message: "Verify this again." }],
        dispositions: { F1: "rejected" }
      })
    }
  })

  it("rejects malformed stored state", () => {
    const key = relayReviewSessionStorageKey(resource)
    window.sessionStorage.setItem(key, JSON.stringify({ identity: "exact-head-1", turns: "not-an-array" }))

    expect(Result.isFailure(readRelayReviewSession(window.sessionStorage, key, resource))).toBe(true)
  })

  it("rejects a schema-valid conversation stored for another repository identity", () => {
    const key = relayReviewSessionStorageKey(resource)
    writeRelayReviewSession(window.localStorage, key, {
      identity: "exact-head-1",
      resource,
      review,
      skillIds: [],
      turns: [],
      dispositions: {}
    })

    const restored = readRelayReviewSession(window.localStorage, key, {
      ...resource,
      repositoryName: "identity-reassigned"
    })

    expect(Result.isFailure(restored)).toBe(true)
    if (Result.isFailure(restored)) expect(restored.failure._tag).toBe("RelayReviewSessionResourceMismatch")
  })

  it("merges stale tab writes without losing turns or regressing publication state", () => {
    const key = relayReviewSessionStorageKey(resource)
    const staleTab = {
      identity: "exact-head-1",
      resource,
      review,
      skillIds: ["builtin:pr-review"],
      turns: [],
      dispositions: { F1: "pending" }
    }
    writeRelayReviewSession(window.localStorage, key, {
      ...staleTab,
      turns: [{ findingId: "F1", role: "user", message: "First tab" }],
      dispositions: { F1: "posted" }
    })
    writeRelayReviewSession(window.localStorage, key, {
      ...staleTab,
      turns: [{ findingId: "F1", role: "user", message: "Second tab" }]
    })

    const restored = readRelayReviewSession(window.localStorage, key, resource)

    expect(Result.isSuccess(restored)).toBe(true)
    if (Result.isSuccess(restored)) {
      expect(restored.success?.turns.map(({ message }) => message)).toEqual(["First tab", "Second tab"])
      expect(restored.success?.dispositions).toEqual({ F1: "posted" })
      expect(restored.success?.version).toBe(2)
    }
  })

  it("keeps the PR transcript when a new exact head replaces the review", () => {
    const key = relayReviewSessionStorageKey(resource)
    writeRelayReviewSession(window.localStorage, key, {
      identity: "exact-head-1",
      resource,
      review,
      skillIds: ["builtin:pr-review"],
      turns: [{ findingId: "F1", role: "user", message: "Check the first head." }],
      dispositions: { F1: "posted" }
    })
    writeRelayReviewSession(window.localStorage, key, {
      identity: "exact-head-2",
      resource,
      review: { ...review, revisionId: "revision-2" },
      skillIds: ["builtin:pr-review"],
      turns: [],
      dispositions: { F2: "pending" }
    })

    const restored = readRelayReviewSession(window.localStorage, key, resource)

    expect(Result.isSuccess(restored)).toBe(true)
    if (Result.isSuccess(restored)) {
      expect(restored.success?.identity).toBe("exact-head-2")
      expect(restored.success?.review.revisionId).toBe("revision-2")
      expect(restored.success?.turns.map(({ message }) => message)).toEqual(["Check the first head."])
      expect(restored.success?.dispositions).toEqual({ F2: "pending" })
    }
  })

  it("recovers interrupted publications without changing settled dispositions", () => {
    const key = relayReviewSessionStorageKey(resource)
    writeRelayReviewSession(window.sessionStorage, key, {
      identity: "exact-head-1",
      resource,
      review,
      skillIds: [],
      turns: [],
      dispositions: { interrupted: "posting", pending: "pending", posted: "posted" }
    })

    const restored = readRelayReviewSession(window.sessionStorage, key, resource)
    expect(Result.isSuccess(restored)).toBe(true)
    if (Result.isSuccess(restored)) {
      expect(restored.success?.dispositions).toEqual({
        interrupted: "failed",
        pending: "pending",
        posted: "posted"
      })
    }
  })

  it("reports blocked storage instead of silently discarding the durable thread", () => {
    const blocked = {
      getItem: () => {
        throw new DOMException("blocked", "SecurityError")
      }
    }

    const restored = readRelayReviewSession(blocked, relayReviewSessionStorageKey(resource), resource)

    expect(Result.isFailure(restored)).toBe(true)
    if (Result.isFailure(restored)) expect(restored.failure._tag).toBe("RelayReviewSessionStorageUnavailable")
  })
})
