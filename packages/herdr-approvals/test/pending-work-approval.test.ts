import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { JobHash, JobRecord, JobStore } from "@knpkv/herdr-fleet"
import { Effect, Schema } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hasPendingWorkApproval } from "../src/internal/pending-work-approval.js"

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

const pending = (id: string, createdAt: number, payload: unknown) =>
  Schema.decodeUnknownEffect(JobRecord)({
    acceptedReceipt: null,
    actor: "owner",
    approvalExpiresAt: null,
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
    status: "pending_approval",
    updatedAt: createdAt
  })

const delegate = { kind: "agent.delegate", mode: "consult", prompt: "look", repository: "/repo" }

const admit = {
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

describe("hasPendingWorkApproval", () => {
  it.effect("is false when nothing, or only non-Work jobs, wait for approval", () =>
    Effect.scoped(Effect.gen(function*() {
      const store = yield* openStore
      expect(yield* hasPendingWorkApproval(store)).toBe(false)
      yield* store.put(yield* pending("job-delegate", 1_000, delegate))
      expect(yield* hasPendingWorkApproval(store)).toBe(false)
    })))

  it.effect("finds a pending Work job past the first page of other pending jobs", () =>
    Effect.scoped(Effect.gen(function*() {
      const store = yield* openStore
      yield* store.put(yield* pending("job-admit", 1_000, admit))
      for (let index = 0; index < 150; index += 1) {
        yield* store.put(yield* pending(`job-delegate-${index}`, 2_000 + index, delegate))
      }
      expect(yield* hasPendingWorkApproval(store)).toBe(true)
    })))
})
