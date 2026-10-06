import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { JobHash, type JobPayload, JobRecord, JobStore } from "@knpkv/herdr-fleet"
import { Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hasOutstandingWorkJob } from "../src/internal/outstanding-work-job.js"

// @effect-diagnostics-next-line strictEffectProvide:off
const provideNodeServices = Effect.provide(NodeServices.layer)

const openStore = Effect.gen(function*() {
  const root = mkdtempSync(join(tmpdir(), "herdr-pending-work-"))
  yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
  return yield* Effect.acquireRelease(
    JobStore.open(join(root, "jobs.sqlite")),
    (store) => Effect.sync(() => store.close())
  )
}).pipe(provideNodeServices)

const job = (
  id: string,
  createdAt: number,
  payload: JobPayload,
  approvalExpiresAt: number | null = null,
  status: "pending_approval" | "queued" | "running" | "succeeded" = "pending_approval"
) =>
  Schema.decodeUnknownEffect(JobRecord)({
    acceptedReceipt: null,
    actor: "owner",
    approvalExpiresAt,
    approvalNonce: `nonce-${id}`,
    approvedAt: null,
    approvedBy: null,
    createdAt,
    durableOperation: true,
    error: null,
    expiredAt: null,
    hash: Schema.decodeUnknownSync(JobHash)("a".repeat(64)),
    id,
    payload,
    rejectedAt: null,
    rejectedBy: null,
    result: null,
    status,
    updatedAt: createdAt
  })

const delegate: JobPayload = { kind: "agent.delegate", mode: "consult", prompt: "look", repository: "/repo" }

const admit: JobPayload = {
  kind: "work.admit",
  repository: "knpkv/npm",
  pullRequest: 433,
  reviewUrl: "https://github.com/knpkv/npm/pull/433",
  goalId: "goal-433",
  laneId: "lane-433",
  operationId: "admit-433",
  expectedAbsenceToken: "a".repeat(64),
  head: "b".repeat(40),
  baseHead: "c".repeat(40),
  owner: { id: "owner-1", name: "Owner" },
  sessionId: "01a0ae7d-ed74-73c1-8454-4aed86de10cc",
  expectedWork: "feat/guided-review-rly",
  worker: { host: "SER8", agentId: "agent-433", name: "Owner", paneId: "w1:p3" },
  worktree: "/worktrees/npm/feat/guided-review-rly",
  branch: "feat/guided-review-rly",
  title: "Review PR 433",
  summary: "Guided review",
  detail: "Admit the running owner"
}

describe("hasOutstandingWorkJob", () => {
  it.effect("is false when nothing, or only non-Work jobs, wait for approval", () =>
    Effect.scoped(Effect.gen(function*() {
      const store = yield* openStore
      expect(yield* hasOutstandingWorkJob(store)).toBe(false)
      yield* store.put(yield* job("job-delegate", 1_000, delegate))
      expect(yield* hasOutstandingWorkJob(store)).toBe(false)
    })))

  it.effect("finds a pending Work job past the first page of other pending jobs", () =>
    Effect.scoped(Effect.gen(function*() {
      const store = yield* openStore
      yield* store.put(yield* job("job-admit", 1_000, admit))
      for (let index = 0; index < 150; index += 1) {
        yield* store.put(yield* job(`job-delegate-${index}`, 2_000 + index, delegate))
      }
      expect(yield* hasOutstandingWorkJob(store)).toBe(true)
    })))

  it.effect("does not count a Work approval whose expiry has passed but is still stored as pending", () =>
    Effect.scoped(Effect.gen(function*() {
      yield* TestClock.setTime(5_000)
      const store = yield* openStore
      yield* store.put(yield* job("job-admit-expired", 1_000, admit, 4_000))
      expect(yield* hasOutstandingWorkJob(store)).toBe(false)
      yield* store.put(yield* job("job-admit-live", 1_001, admit, 6_000))
      expect(yield* hasOutstandingWorkJob(store)).toBe(true)
    })))

  it.effect("counts an approved Work job until it has run", () =>
    Effect.scoped(Effect.gen(function*() {
      const store = yield* openStore
      yield* store.put(yield* job("job-admit-queued", 1_000, admit, null, "queued"))
      expect(yield* hasOutstandingWorkJob(store)).toBe(true)
    })))

  it.effect("stops counting a Work job once it has run", () =>
    Effect.scoped(Effect.gen(function*() {
      const store = yield* openStore
      yield* store.put(yield* job("job-admit-done", 1_000, admit, null, "succeeded"))
      expect(yield* hasOutstandingWorkJob(store)).toBe(false)
    })))
})
