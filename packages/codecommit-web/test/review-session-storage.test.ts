import { beforeEach, describe, expect, it } from "@effect/vitest"
import * as Result from "effect/Result"

import {
  readRelayReviewSession,
  type RelayReviewSessionLock,
  type RelayReviewSessionResourceIdentity,
  relayReviewSessionStorageKey,
  type RelayReviewSessionWrite,
  writeRelayReviewSession
} from "../src/client/review-session-storage.js"
import type { PullRequestRelayReviewResponse, RelayReviewConversationTurn } from "../src/server/Api.js"

const review: PullRequestRelayReviewResponse = {
  pullRequestId: "42",
  revisionId: "revision-1",
  baseCommit: "a".repeat(40),
  headCommit: "b".repeat(40),
  kind: "review",
  profile: {
    id: "thorough",
    name: "Thorough review",
    kind: "review",
    provider: "codex",
    harness: "native-codex",
    model: "configured-default",
    skillIds: ["builtin:pr-review"]
  },
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
  region: "eu-central-1",
  repositoryName: "payments"
}

interface MemoryStorage {
  readonly clear: () => void
  readonly getItem: (key: string) => string | null
  readonly setItem: (key: string, value: string) => void
}

const makeStorage = (): MemoryStorage => {
  const entries = new Map<string, string>()
  return {
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value)
  }
}

const localStorage = makeStorage()
const sessionStorage = makeStorage()

const immediateLock: RelayReviewSessionLock = {
  request: async (_name, effect) => effect()
}

const writeSession = (
  storage: MemoryStorage,
  key: string,
  session: Omit<RelayReviewSessionWrite, "expectedIdentity" | "expectedVersion"> & {
    readonly expectedIdentity?: string
    readonly expectedVersion?: number
  }
) =>
  writeRelayReviewSession(storage, key, {
    ...session,
    expectedIdentity: session.expectedIdentity ?? session.identity,
    expectedVersion: session.expectedVersion ?? 0
  }, immediateLock)

describe("Relay review session storage", () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  it("restores one durable PR conversation across exact heads", async () => {
    const key = relayReviewSessionStorageKey(resource)
    await writeSession(localStorage, key, {
      identity: "exact-head-1",
      resource,
      review,
      skillIds: ["builtin:pr-review"],
      turns: [{ findingId: "F1", role: "user", message: "Verify this again." }],
      dispositions: { F1: "rejected" }
    })

    const restored = readRelayReviewSession(localStorage, key, resource)
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
    sessionStorage.setItem(key, JSON.stringify({ identity: "exact-head-1", turns: "not-an-array" }))

    expect(Result.isFailure(readRelayReviewSession(sessionStorage, key, resource))).toBe(true)
  })

  it("rejects a schema-valid conversation stored for another repository identity", async () => {
    const key = relayReviewSessionStorageKey(resource)
    await writeSession(localStorage, key, {
      identity: "exact-head-1",
      resource,
      review,
      skillIds: [],
      turns: [],
      dispositions: {}
    })

    const restored = readRelayReviewSession(localStorage, key, {
      ...resource,
      repositoryName: "identity-reassigned"
    })

    expect(Result.isFailure(restored)).toBe(true)
    if (Result.isFailure(restored)) expect(restored.failure._tag).toBe("RelayReviewSessionResourceMismatch")
  })

  it("keeps regional PR sessions under distinct durable identities", async () => {
    const euKey = relayReviewSessionStorageKey(resource)
    const usResource: RelayReviewSessionResourceIdentity = { ...resource, region: "us-east-1" }
    const usKey = relayReviewSessionStorageKey(usResource)

    expect(euKey).not.toBe(usKey)

    await writeSession(localStorage, euKey, {
      identity: "exact-head-1",
      resource,
      review,
      skillIds: [],
      turns: [],
      dispositions: {}
    })

    expect(Result.isSuccess(readRelayReviewSession(localStorage, usKey, usResource))).toBe(true)
    const restored = readRelayReviewSession(localStorage, usKey, usResource)
    if (Result.isSuccess(restored)) expect(restored.success).toBeNull()
  })

  it("merges stale tab writes without losing turns or regressing publication state", async () => {
    const key = relayReviewSessionStorageKey(resource)
    const staleTab = {
      identity: "exact-head-1",
      resource,
      review,
      skillIds: ["builtin:pr-review"],
      turns: [],
      dispositions: { F1: "pending" }
    }
    await writeSession(localStorage, key, {
      ...staleTab,
      turns: [{ findingId: "F1", role: "user", message: "First tab" }],
      dispositions: { F1: "posted" }
    })
    await writeSession(localStorage, key, {
      ...staleTab,
      turns: [{ findingId: "F1", role: "user", message: "Second tab" }]
    })

    const restored = readRelayReviewSession(localStorage, key, resource)

    expect(Result.isSuccess(restored)).toBe(true)
    if (Result.isSuccess(restored)) {
      expect(restored.success?.turns.map(({ message }) => message)).toEqual(["First tab", "Second tab"])
      expect(restored.success?.dispositions).toEqual({ F1: "posted" })
      expect(restored.success?.version).toBe(2)
    }
  })

  it("keeps the PR transcript when a new exact head replaces the review", async () => {
    const key = relayReviewSessionStorageKey(resource)
    await writeSession(localStorage, key, {
      identity: "exact-head-1",
      resource,
      review,
      skillIds: ["builtin:pr-review"],
      turns: [{ findingId: "F1", role: "user", message: "Check the first head." }],
      dispositions: { F1: "posted" }
    })
    await writeSession(localStorage, key, {
      expectedIdentity: "exact-head-1",
      expectedVersion: 1,
      identity: "exact-head-2",
      resource,
      review: { ...review, revisionId: "revision-2" },
      skillIds: ["builtin:pr-review"],
      turns: [],
      dispositions: { F2: "pending" }
    })

    const restored = readRelayReviewSession(localStorage, key, resource)

    expect(Result.isSuccess(restored)).toBe(true)
    if (Result.isSuccess(restored)) {
      expect(restored.success?.identity).toBe("exact-head-2")
      expect(restored.success?.review.revisionId).toBe("revision-2")
      expect(restored.success?.turns.map(({ message }) => message)).toEqual(["Check the first head."])
      expect(restored.success?.dispositions).toEqual({ F2: "pending" })
    }
  })

  it("recovers interrupted publications without changing settled dispositions", async () => {
    const key = relayReviewSessionStorageKey(resource)
    await writeSession(sessionStorage, key, {
      identity: "exact-head-1",
      resource,
      review,
      skillIds: [],
      turns: [],
      dispositions: { interrupted: "posting", pending: "pending", posted: "posted" }
    })

    const restored = readRelayReviewSession(sessionStorage, key, resource)
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

  it("preserves repeated turns with different stable IDs and deduplicates one replayed ID", async () => {
    const key = relayReviewSessionStorageKey(resource)
    const repeatedTurn = (id: string): RelayReviewConversationTurn => ({
      id,
      findingId: "F1",
      role: "user",
      message: "Check again."
    })
    await writeSession(localStorage, key, {
      identity: "exact-head-1",
      resource,
      review,
      skillIds: [],
      turns: [repeatedTurn("turn-1"), repeatedTurn("turn-2")],
      dispositions: {}
    })
    await writeSession(localStorage, key, {
      identity: "exact-head-1",
      resource,
      review,
      skillIds: [],
      turns: [repeatedTurn("turn-2")],
      dispositions: {}
    })

    const restored = readRelayReviewSession(localStorage, key, resource)

    expect(Result.isSuccess(restored)).toBe(true)
    if (Result.isSuccess(restored)) {
      expect(restored.success?.turns.map(({ id }) => id)).toEqual(["turn-1", "turn-2"])
    }
  })

  it("keeps a newer exact-head review when an older tab writes later", async () => {
    const key = relayReviewSessionStorageKey(resource)
    await writeSession(localStorage, key, {
      identity: "exact-head-1",
      resource,
      review,
      skillIds: ["old-skill"],
      turns: [],
      dispositions: { F1: "pending" }
    })
    await writeSession(localStorage, key, {
      expectedIdentity: "exact-head-1",
      expectedVersion: 1,
      identity: "exact-head-2",
      resource,
      review: { ...review, headCommit: "c".repeat(40), revisionId: "revision-2" },
      skillIds: ["new-skill"],
      turns: [],
      dispositions: { F2: "posted" }
    })
    const staleWrite = await writeSession(localStorage, key, {
      identity: "exact-head-1",
      resource,
      review,
      skillIds: ["old-skill"],
      turns: [{ findingId: "F1", id: "stale-turn", role: "user", message: "Old tab" }],
      dispositions: { F1: "rejected" }
    })

    expect(Result.isSuccess(staleWrite)).toBe(true)
    if (Result.isSuccess(staleWrite)) expect(staleWrite.success._tag).toBe("stale-review-preserved")
    const restored = readRelayReviewSession(localStorage, key, resource)
    expect(Result.isSuccess(restored)).toBe(true)
    if (Result.isSuccess(restored)) {
      expect(restored.success).toMatchObject({
        identity: "exact-head-2",
        review: { headCommit: "c".repeat(40), revisionId: "revision-2" },
        skillIds: ["new-skill"],
        dispositions: { F2: "posted" }
      })
      expect(restored.success?.turns.map(({ id }) => id)).toContain("stale-turn")
    }
  })

  it("does not bind stale finding state to a reused finding id", async () => {
    const key = relayReviewSessionStorageKey(resource)
    const revisedReview: PullRequestRelayReviewResponse = {
      ...review,
      revisionId: "revision-2",
      result: {
        ...review.result,
        findings: review.result.findings.map((finding) => ({ ...finding, summary: "A different finding." }))
      }
    }
    await writeSession(localStorage, key, {
      identity: "exact-head-1",
      resource,
      review,
      skillIds: [],
      turns: [{ findingId: "F1", id: "old-finding-turn", role: "user", message: "Old finding." }],
      dispositions: { F1: "posted" }
    })
    await writeSession(localStorage, key, {
      expectedIdentity: "exact-head-1",
      expectedVersion: 1,
      identity: "exact-head-2",
      resource,
      review: revisedReview,
      skillIds: [],
      turns: [{ findingId: "PR", id: "pr-turn", role: "user", message: "PR-level context." }],
      dispositions: { F1: "pending" }
    })
    await writeSession(localStorage, key, {
      expectedVersion: 2,
      identity: "exact-head-2",
      resource,
      review: revisedReview,
      skillIds: [],
      turns: [{ findingId: "F1", id: "new-finding-turn", role: "user", message: "Current finding." }],
      dispositions: { F1: "pending" }
    })

    const staleWrite = await writeSession(localStorage, key, {
      identity: "exact-head-1",
      resource,
      review,
      skillIds: [],
      turns: [{ findingId: "F1", id: "stale-finding-turn", role: "user", message: "Stale finding." }],
      dispositions: { F1: "posted" }
    })

    expect(Result.isSuccess(staleWrite)).toBe(true)
    const restored = readRelayReviewSession(localStorage, key, resource)
    expect(Result.isSuccess(restored)).toBe(true)
    if (Result.isSuccess(restored)) {
      expect(restored.success?.turns.map(({ id }) => id)).toEqual(["pr-turn", "new-finding-turn"])
      expect(restored.success?.dispositions).toEqual({ F1: "pending" })
      expect(restored.success?.review.revisionId).toBe("revision-2")
    }
  })

  it("keeps the winning bounded turn window when an older tab writes later", async () => {
    const key = relayReviewSessionStorageKey(resource)
    const turn = (index: number): RelayReviewConversationTurn => ({
      id: `turn-${index}`,
      findingId: "F1",
      role: "user",
      message: `Turn ${index}`
    })
    const window = (first: number, last: number): ReadonlyArray<RelayReviewConversationTurn> =>
      Array.from({ length: last - first + 1 }, (_, offset) => turn(first + offset))

    await writeSession(localStorage, key, {
      expectedVersion: 0,
      identity: "exact-head-1",
      resource,
      review,
      skillIds: [],
      turns: window(1, 40),
      dispositions: {}
    })
    await writeSession(localStorage, key, {
      expectedVersion: 1,
      identity: "exact-head-1",
      resource,
      review,
      skillIds: [],
      turns: window(1, 41),
      dispositions: {}
    })

    const staleOlderWindow = await writeSession(localStorage, key, {
      expectedVersion: 1,
      identity: "exact-head-1",
      resource,
      review,
      skillIds: [],
      turns: window(1, 40),
      dispositions: {}
    })

    expect(Result.isSuccess(staleOlderWindow)).toBe(true)
    const afterOlderWindow = readRelayReviewSession(localStorage, key, resource)
    expect(Result.isSuccess(afterOlderWindow)).toBe(true)
    if (Result.isSuccess(afterOlderWindow)) {
      expect(afterOlderWindow.success?.turns.map(({ id }) => id)).toEqual(
        Array.from({ length: 40 }, (_, offset) => `turn-${offset + 2}`)
      )
    }

    const staleNewerTurn = await writeSession(localStorage, key, {
      expectedVersion: 1,
      identity: "exact-head-1",
      resource,
      review,
      skillIds: [],
      turns: window(2, 42),
      dispositions: {}
    })

    expect(Result.isSuccess(staleNewerTurn)).toBe(true)
    const restored = readRelayReviewSession(localStorage, key, resource)
    expect(Result.isSuccess(restored)).toBe(true)
    if (Result.isSuccess(restored)) {
      expect(restored.success?.turns.map(({ id }) => id)).toEqual(
        Array.from({ length: 40 }, (_, offset) => `turn-${offset + 3}`)
      )
    }
  })

  it("does not resurrect a disjoint evicted window from a stale tab", async () => {
    const key = relayReviewSessionStorageKey(resource)
    const turn = (index: number): RelayReviewConversationTurn => ({
      id: `turn-${index}`,
      findingId: "F1",
      role: "user",
      message: `Turn ${index}`
    })
    const window = (first: number, last: number): ReadonlyArray<RelayReviewConversationTurn> =>
      Array.from({ length: last - first + 1 }, (_, offset) => turn(first + offset))

    await writeSession(localStorage, key, {
      identity: "exact-head-1",
      resource,
      review,
      skillIds: [],
      turns: window(41, 80),
      dispositions: {}
    })
    await writeSession(localStorage, key, {
      expectedVersion: 1,
      identity: "exact-head-1",
      resource,
      review,
      skillIds: [],
      turns: window(41, 80),
      dispositions: {}
    })
    const staleWrite = await writeSession(localStorage, key, {
      expectedVersion: 1,
      identity: "exact-head-1",
      resource,
      review,
      skillIds: [],
      turns: window(1, 40),
      dispositions: {}
    })

    expect(Result.isSuccess(staleWrite)).toBe(true)
    const restored = readRelayReviewSession(localStorage, key, resource)
    expect(Result.isSuccess(restored)).toBe(true)
    if (Result.isSuccess(restored)) {
      expect(restored.success?.turns.map(({ id }) => id)).toEqual(
        Array.from({ length: 40 }, (_, offset) => `turn-${offset + 41}`)
      )
    }
  })

  it("serializes cross-tab writes through the session lock", async () => {
    const key = relayReviewSessionStorageKey(resource)
    let tail = Promise.resolve()
    const lock: RelayReviewSessionLock = {
      request: async (_name, effect) => {
        const previous = tail
        let release = (): void => undefined
        tail = new Promise<void>((resolve) => {
          release = resolve
        })
        await previous
        try {
          return await effect()
        } finally {
          release()
        }
      }
    }
    const first = writeRelayReviewSession(localStorage, key, {
      expectedIdentity: "exact-head-1",
      expectedVersion: 0,
      identity: "exact-head-1",
      resource,
      review,
      skillIds: [],
      turns: [{ id: "first", findingId: "F1", role: "user", message: "First" }],
      dispositions: {}
    }, lock)
    const second = writeRelayReviewSession(localStorage, key, {
      expectedIdentity: "exact-head-1",
      expectedVersion: 0,
      identity: "exact-head-1",
      resource,
      review,
      skillIds: [],
      turns: [{ id: "second", findingId: "F1", role: "user", message: "Second" }],
      dispositions: {}
    }, lock)

    const results = await Promise.all([first, second])
    expect(results.every(Result.isSuccess)).toBe(true)
    const restored = readRelayReviewSession(localStorage, key, resource)
    expect(Result.isSuccess(restored)).toBe(true)
    if (Result.isSuccess(restored)) {
      expect(restored.success?.turns.map(({ id }) => id)).toEqual(["first", "second"])
      expect(restored.success?.version).toBe(2)
    }
  })

  it("preserves a same-head review when a stale tab writes after a newer version", async () => {
    const key = relayReviewSessionStorageKey(resource)
    const initial = await writeSession(localStorage, key, {
      expectedVersion: 0,
      identity: "exact-head-1",
      resource,
      review,
      skillIds: ["old-skill"],
      turns: [],
      dispositions: { F1: "pending" }
    })
    expect(Result.isSuccess(initial)).toBe(true)

    const current = await writeSession(localStorage, key, {
      expectedVersion: 1,
      identity: "exact-head-1",
      resource,
      review: { ...review, revisionId: "revision-2" },
      skillIds: ["new-skill"],
      turns: [],
      dispositions: { F1: "posted" }
    })
    expect(Result.isSuccess(current)).toBe(true)

    const stale = await writeSession(localStorage, key, {
      expectedVersion: 1,
      identity: "exact-head-1",
      resource,
      review,
      skillIds: ["old-skill"],
      turns: [{ id: "stale-turn", findingId: "F1", role: "user", message: "Keep this turn." }],
      dispositions: { F1: "pending" }
    })

    expect(Result.isSuccess(stale)).toBe(true)
    if (Result.isSuccess(stale)) expect(stale.success._tag).toBe("stale-review-preserved")
    const restored = readRelayReviewSession(localStorage, key, resource)
    expect(Result.isSuccess(restored)).toBe(true)
    if (Result.isSuccess(restored)) {
      expect(restored.success).toMatchObject({
        identity: "exact-head-1",
        review: { revisionId: "revision-2" },
        skillIds: ["new-skill"],
        dispositions: { F1: "posted" },
        version: 3
      })
      expect(restored.success?.turns.map(({ id }) => id)).toEqual(["stale-turn"])
    }
  })

  it("accepts a same-head write only when its observed version is current", async () => {
    const key = relayReviewSessionStorageKey(resource)
    await writeSession(localStorage, key, {
      expectedVersion: 0,
      identity: "exact-head-1",
      resource,
      review,
      skillIds: ["old-skill"],
      turns: [],
      dispositions: {}
    })

    const written = await writeSession(localStorage, key, {
      expectedVersion: 1,
      identity: "exact-head-1",
      resource,
      review: { ...review, revisionId: "revision-2" },
      skillIds: ["new-skill"],
      turns: [],
      dispositions: {}
    })

    expect(Result.isSuccess(written)).toBe(true)
    if (Result.isSuccess(written)) {
      expect(written.success._tag).toBe("stored")
      expect(written.success.session.review.revisionId).toBe("revision-2")
      expect(written.success.session.version).toBe(2)
    }
  })

  it("persists current-head reconciliations without rank-merging them away", async () => {
    const key = relayReviewSessionStorageKey(resource)
    await writeSession(localStorage, key, {
      identity: "exact-head-1",
      resource,
      review,
      skillIds: [],
      turns: [],
      dispositions: { F1: "posted" }
    })
    const replaced = await writeSession(localStorage, key, {
      identity: "exact-head-1",
      expectedVersion: 1,
      resource,
      review: { ...review, revisionId: "revision-2" },
      skillIds: [],
      turns: [],
      dispositions: { F1: "posted-stale" }
    })

    expect(Result.isSuccess(replaced)).toBe(true)
    const restored = readRelayReviewSession(localStorage, key, resource)
    expect(Result.isSuccess(restored)).toBe(true)
    if (Result.isSuccess(restored)) {
      expect(restored.success?.review.revisionId).toBe("revision-2")
      expect(restored.success?.dispositions).toEqual({ F1: "posted-stale" })
    }
  })
})
