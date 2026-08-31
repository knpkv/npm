import { beforeEach, describe, expect, it } from "@effect/vitest"
import * as Result from "effect/Result"

import {
  migrateRelayReviewSession,
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

  it("migrates a credential-keyed session when repository identity is enriched", async () => {
    const sourceResource: RelayReviewSessionResourceIdentity = { ...resource, accountKind: "credential" }
    const sourceKey = relayReviewSessionStorageKey(sourceResource)
    const targetResource: RelayReviewSessionResourceIdentity = {
      ...resource,
      accountId: "222222222222",
      accountKind: "repository"
    }
    const targetKey = relayReviewSessionStorageKey(targetResource)
    await writeSession(localStorage, sourceKey, {
      identity: "exact-head-1",
      resource: sourceResource,
      review,
      skillIds: ["builtin:pr-review"],
      turns: [{ findingId: "F1", role: "user", message: "Keep this review." }],
      dispositions: { F1: "acknowledged" }
    })

    const migrated = await migrateRelayReviewSession(
      localStorage,
      sourceKey,
      sourceResource,
      targetKey,
      targetResource,
      "exact-head-2",
      immediateLock
    )

    expect(Result.isSuccess(migrated)).toBe(true)
    const restored = readRelayReviewSession(localStorage, targetKey, targetResource)
    expect(Result.isSuccess(restored)).toBe(true)
    if (Result.isSuccess(restored)) {
      expect(restored.success?.identity).toBe("exact-head-2")
      expect(restored.success?.resource).toEqual(targetResource)
      expect(restored.success?.turns).toEqual([{ findingId: "F1", role: "user", message: "Keep this review." }])
      expect(restored.success?.dispositions).toEqual({ F1: "acknowledged" })
    }
  })

  it("redirects a legacy writer to the canonical resource after migration", async () => {
    const sourceResource: RelayReviewSessionResourceIdentity = { ...resource, accountKind: "credential" }
    const sourceKey = relayReviewSessionStorageKey(sourceResource)
    const targetResource: RelayReviewSessionResourceIdentity = {
      ...resource,
      accountId: "222222222222",
      accountKind: "repository"
    }
    const targetKey = relayReviewSessionStorageKey(targetResource)
    await writeSession(localStorage, sourceKey, {
      identity: "exact-head-1",
      resource: sourceResource,
      review,
      skillIds: [],
      turns: [],
      dispositions: {}
    })
    await migrateRelayReviewSession(
      localStorage,
      sourceKey,
      sourceResource,
      targetKey,
      targetResource,
      "exact-head-2",
      immediateLock
    )

    const redirected = await writeSession(localStorage, sourceKey, {
      identity: "exact-head-1",
      resource: sourceResource,
      review,
      skillIds: [],
      turns: [{ id: "legacy-turn", findingId: "F1", role: "user", message: "Keep this turn." }],
      dispositions: {}
    })

    expect(Result.isSuccess(redirected)).toBe(true)
    const restored = readRelayReviewSession(localStorage, targetKey, targetResource)
    expect(Result.isSuccess(restored)).toBe(true)
    if (Result.isSuccess(restored)) expect(restored.success?.turns.map(({ id }) => id)).toEqual(["legacy-turn"])
  })

  it("keeps a current canonical rerun when migration finishes after it", async () => {
    const sourceResource: RelayReviewSessionResourceIdentity = { ...resource, accountKind: "credential" }
    const sourceKey = relayReviewSessionStorageKey(sourceResource)
    const targetResource: RelayReviewSessionResourceIdentity = {
      ...resource,
      accountId: "222222222222",
      accountKind: "repository"
    }
    const targetKey = relayReviewSessionStorageKey(targetResource)
    await writeSession(localStorage, sourceKey, {
      identity: "exact-head-1",
      resource: sourceResource,
      review,
      skillIds: [],
      turns: [],
      dispositions: {}
    })
    const migrationGate = Promise.withResolvers<void>()
    let lockCalls = 0
    const lock: RelayReviewSessionLock = {
      request: async (_name, effect) => {
        lockCalls++
        if (lockCalls === 1) await migrationGate.promise
        return effect()
      }
    }
    const migration = migrateRelayReviewSession(
      localStorage,
      sourceKey,
      sourceResource,
      targetKey,
      targetResource,
      "exact-head-2",
      lock
    )
    await Promise.resolve()
    const rerun = await writeRelayReviewSession(localStorage, targetKey, {
      expectedIdentity: "exact-head-2",
      expectedVersion: 0,
      identity: "exact-head-2",
      resource: targetResource,
      review: { ...review, revisionId: "revision-2" },
      skillIds: ["rerun"],
      turns: [],
      dispositions: {}
    }, lock)
    expect(Result.isSuccess(rerun)).toBe(true)
    migrationGate.resolve()
    await migration

    const restored = readRelayReviewSession(localStorage, targetKey, targetResource)
    expect(Result.isSuccess(restored)).toBe(true)
    if (Result.isSuccess(restored)) {
      expect(restored.success?.review.revisionId).toBe("revision-2")
      expect(restored.success?.skillIds).toEqual(["rerun"])
    }
  })

  it("fails closed when a legacy session has no account provenance", async () => {
    const sourceKey = relayReviewSessionStorageKey(resource)
    const targetResource: RelayReviewSessionResourceIdentity = {
      ...resource,
      accountId: "222222222222",
      accountKind: "repository"
    }
    await writeSession(localStorage, sourceKey, {
      identity: "exact-head-1",
      resource,
      review,
      skillIds: [],
      turns: [],
      dispositions: {}
    })

    const migrated = await migrateRelayReviewSession(
      localStorage,
      sourceKey,
      resource,
      relayReviewSessionStorageKey(targetResource),
      targetResource,
      "exact-head-2",
      immediateLock
    )

    expect(Result.isFailure(migrated)).toBe(true)
    if (Result.isFailure(migrated)) expect(migrated.failure._tag).toBe("RelayReviewSessionMigrationAmbiguous")
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
      turns: window(1, 40).map((item, index) => index === 0 ? { ...item, findingId: "PR" } : item),
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

  it("retains an identified new turn from a disjoint stale window", async () => {
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
      appendedTurnIds: ["turn-81"],
      expectedVersion: 1,
      identity: "exact-head-1",
      resource,
      review,
      skillIds: [],
      turns: [...window(2, 40), turn(81)],
      dispositions: {}
    })

    expect(Result.isSuccess(staleWrite)).toBe(true)
    const restored = readRelayReviewSession(localStorage, key, resource)
    expect(Result.isSuccess(restored)).toBe(true)
    if (Result.isSuccess(restored)) {
      expect(restored.success?.turns.map(({ id }) => id)).toEqual([
        ...Array.from({ length: 39 }, (_, offset) => `turn-${offset + 42}`),
        "turn-81"
      ])
    }
  })

  it("retains the complete appended exchange from a disjoint stale window", async () => {
    const key = relayReviewSessionStorageKey(resource)
    const turn = (id: string, role: "user" | "assistant"): RelayReviewConversationTurn => ({
      id,
      findingId: "F1",
      role,
      message: id
    })
    const currentTurns = Array.from({ length: 40 }, (_, index) => turn(`turn-${String(index + 41)}`, "user"))
    await writeSession(localStorage, key, {
      identity: "exact-head-1",
      resource,
      review,
      skillIds: [],
      turns: currentTurns,
      dispositions: {}
    })
    await writeSession(localStorage, key, {
      expectedVersion: 1,
      identity: "exact-head-1",
      resource,
      review,
      skillIds: [],
      turns: currentTurns,
      dispositions: {}
    })

    const staleWrite = await writeSession(localStorage, key, {
      appendedTurnIds: ["turn-81", "turn-82"],
      expectedVersion: 1,
      identity: "exact-head-1",
      resource,
      review,
      skillIds: [],
      turns: [
        ...Array.from({ length: 38 }, (_, index) => turn(`turn-${String(index + 2)}`, "user")),
        turn("turn-81", "user"),
        turn("turn-82", "assistant")
      ],
      dispositions: {}
    })

    expect(Result.isSuccess(staleWrite)).toBe(true)
    const restored = readRelayReviewSession(localStorage, key, resource)
    expect(Result.isSuccess(restored)).toBe(true)
    if (Result.isSuccess(restored)) {
      expect(restored.success?.turns.slice(-2).map(({ id }) => id)).toEqual(["turn-81", "turn-82"])
      expect(restored.success?.turns).toHaveLength(40)
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
