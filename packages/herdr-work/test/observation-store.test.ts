import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  makeWorkService,
  type WorkAdmissionTarget,
  type WorkAgentObservation,
  type WorkGoal,
  type WorkObservationEnvelope,
  workObservedFactMaxRecords,
  type WorkPullRequestObservation,
  WorkStore
} from "../src/index.js"

// @effect-diagnostics-next-line strictEffectProvide:off
const provideNodeServices = Effect.provide(NodeServices.layer)

const fixture = Effect.gen(function*() {
  yield* TestClock.setTime(10_000)
  const root = mkdtempSync(join(tmpdir(), "herdr-observation-"))
  yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { recursive: true, force: true })))
  const path = join(root, "work.sqlite")
  const open = Effect.acquireRelease(WorkStore.open(path), (opened) => Effect.sync(() => opened.close()))
  const store = yield* open
  const work = yield* makeWorkService(store)
  return { open, path, store, work }
}).pipe(provideNodeServices)

const pullRequest = (overrides: Partial<WorkPullRequestObservation> = {}): WorkPullRequestObservation => ({
  _tag: "pull_request",
  branch: "feat/x",
  checks: "passing",
  closedAt: null,
  head: "a".repeat(40),
  pullRequest: 7,
  repository: "knpkv/npm",
  review: "requested",
  state: "open",
  ...overrides
})

const agent = (status: WorkAgentObservation["status"], agentId = "agent-owner"): WorkAgentObservation => ({
  _tag: "agent",
  agentId,
  host: "SER8",
  status
})

const at = (observedAt: number, observation: WorkObservationEnvelope["observation"]): WorkObservationEnvelope => ({
  observation,
  observedAt
})

const goal: WorkGoal = {
  blocker: null,
  connectTarget: null,
  createdAt: 1_000,
  delivery: "pull_request",
  detail: "Review checkpoint",
  id: "goal-pr7",
  owner: { id: "owner", name: "Owner" },
  repository: { branch: "feat/x", repository: "knpkv/npm" },
  review: { state: "requested", summary: null, updatedAt: 1_000, url: "https://github.com/knpkv/npm/pull/7" },
  spend: null,
  state: "review",
  summary: "Ship x",
  title: "Ship x",
  updatedAt: 1_000
}

describe("observed facts", () => {
  it.effect("stores the latest fact per subject, keeps the first-seen time for the same facts, and skips older facts", () =>
    Effect.scoped(Effect.gen(function*() {
      const { work } = yield* fixture
      const first = yield* work.observe([at(100, agent("gone"))])
      expect(first.outcomes).toEqual([{ _tag: "stored", subject: "herdr:ser8/agent-owner" }])
      expect((yield* work.observe([at(200, agent("gone"))])).outcomes[0]?._tag).toBe("unchanged")
      expect((yield* work.observe([at(50, agent("working"))])).outcomes[0]?._tag).toBe("stale")
      expect((yield* work.observe([at(300, agent("working"))])).outcomes[0]?._tag).toBe("stored")
      const reopened = yield* work.observe([at(400, agent("gone"))])
      expect(reopened.outcomes[0]?._tag).toBe("stored")
      const unchanged = yield* work.observe([at(500, agent("gone"))])
      expect(unchanged.outcomes[0]?._tag).toBe("unchanged")
    })))

  it.effect("treats the same facts given in a different key order as unchanged", () =>
    Effect.scoped(Effect.gen(function*() {
      const { work } = yield* fixture
      yield* work.observe([at(100, agent("working"))])
      const reordered: WorkAgentObservation = { status: "working", host: "SER8", agentId: "agent-owner", _tag: "agent" }
      expect((yield* work.observe([at(200, reordered)])).outcomes[0]?._tag).toBe("unchanged")
    })))

  it.effect("keeps a failed read beside the last good facts, without replacing them, until a good read", () =>
    Effect.scoped(Effect.gen(function*() {
      const { work } = yield* fixture
      const failed = (observedAt: number, reason: string) =>
        at(observedAt, { _tag: "unknown", reason, source: "github", subject: "github:knpkv/npm#7" })
      const unknownOf = Effect.map(work.snapshots(10_000), (snapshots) => snapshots.now.observed?.[0]?.unknown)
      yield* work.record({ eventId: "goal-pr7.1", goal, occurredAt: 1_000, version: "herdr.work.event.v1" })
      yield* work.observe([at(100, pullRequest())])
      yield* work.observe([at(150, pullRequest())])
      const report = yield* work.observe([failed(200, "gh: rate limited")])
      expect(report.outcomes).toEqual([{ _tag: "unknown", reason: "gh: rate limited", subject: "github:knpkv/npm#7" }])
      yield* work.observe([failed(300, "gh: 502")])
      expect(yield* unknownOf).toEqual({ lastGoodAt: 150, reason: "gh: 502", since: 200, source: "github" })
      const snapshots = yield* work.snapshots(10_000)
      expect(snapshots.now.observed?.[0]?.pullRequest).toEqual({
        confirmedAt: 150,
        fact: pullRequest(),
        observedAt: 100
      })
      expect((yield* work.observe([failed(120, "late")])).outcomes[0]?._tag).toBe("stale")
      yield* work.observe([at(400, pullRequest())])
      expect(yield* unknownOf).toBeNull()
    })))

  it.effect("reports a failure for a subject never read successfully, with no last good read", () =>
    Effect.scoped(Effect.gen(function*() {
      const { work } = yield* fixture
      yield* work.record({ eventId: "goal-pr7.1", goal, occurredAt: 1_000, version: "herdr.work.event.v1" })
      yield* work.observe([
        at(100, { _tag: "unknown", reason: "gh: rate limited", source: "github", subject: "github:knpkv/npm#7" })
      ])
      const observed = (yield* work.snapshots(10_000)).now.observed?.[0]
      expect(observed?.unknown).toEqual({ lastGoodAt: null, reason: "gh: rate limited", since: 100, source: "github" })
      expect(observed?.pullRequest).toBeNull()
    })))

  it.effect("never moves an approval preflight token", () =>
    Effect.scoped(Effect.gen(function*() {
      const { work } = yield* fixture
      const target: WorkAdmissionTarget = {
        baseHead: "d".repeat(40),
        branch: "feat/y",
        expectedWork: "feat/y",
        goalId: "goal-pr8",
        head: "b".repeat(40),
        laneId: "lane-pr8",
        owner: { id: "owner", name: "Owner" },
        pullRequest: 8,
        repository: "knpkv/npm",
        reviewUrl: "https://github.com/knpkv/npm/pull/8",
        sessionId: "01a0ae7d-ed74-73c1-8454-4aed86de10cc",
        worker: { agentId: "agent-y", host: "SER8", name: "Owner", paneId: "w1:p2" },
        worktree: "/tmp/work/feat/y"
      }
      const before = yield* work.admissionPreflight(target)
      yield* work.observe(
        Array.from({ length: 1_000 }, (_, index) => at(100 + index, agent("working", `agent-${index}`)))
      )
      yield* work.observe([at(2_000, pullRequest({ closedAt: 1_900, pullRequest: 8, state: "merged" }))])
      expect(yield* work.admissionPreflight(target)).toEqual(before)
    })))

  it.effect("overlays facts on the now window only, and survives a reopen", () =>
    Effect.scoped(Effect.gen(function*() {
      const { open, work } = yield* fixture
      yield* work.record({ eventId: "goal-pr7.1", goal, occurredAt: 1_000, version: "herdr.work.event.v1" })
      yield* work.observe([at(5_000, pullRequest({ closedAt: 4_900, state: "merged" }))])
      const snapshots = yield* work.snapshots(10_000)
      expect(snapshots.now.goals[0]?.state).toBe("review")
      expect(snapshots.now.observed).toEqual([{
        agent: null,
        displayState: "completed",
        goalId: "goal-pr7",
        pullRequest: { confirmedAt: 5_000, fact: pullRequest({ closedAt: 4_900, state: "merged" }), observedAt: 5_000 },
        stale: false,
        unknown: null
      }])
      expect(snapshots.day.observed).toBeUndefined()
      const reopened = yield* makeWorkService(yield* open.pipe(provideNodeServices))
      expect((yield* reopened.snapshots(10_000)).now.observed?.[0]?.displayState).toBe("completed")
    })))

  it.effect("evicts the oldest facts once the overlay is over its row bound", () =>
    Effect.scoped(Effect.gen(function*() {
      const { work } = yield* fixture
      yield* work.observe(
        Array.from(
          { length: workObservedFactMaxRecords },
          (_, index) => at(100 + index, agent("idle", `agent-${index}`))
        )
      )
      const report = yield* work.observe([at(100_000, agent("idle", "agent-newest"))])
      expect(report.evicted).toBe(1)
      expect((yield* work.observe([at(1, agent("idle", "agent-0"))])).outcomes[0]?._tag).toBe("stored")
    })))
})
