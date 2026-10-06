import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { platform, tmpdir } from "node:os"
import { join } from "node:path"
import {
  makeWorkService,
  withObservedFacts,
  type WorkAdmissionTarget,
  type WorkAgentObservation,
  type WorkGoal,
  type WorkObservationEnvelope,
  workObservedFactMaxRecords,
  type WorkPullRequestObservation,
  WorkSnapshots,
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

  it.effect("keeps the latest failure's reason and the earliest failure's start, whatever order they arrive in", () =>
    Effect.scoped(Effect.gen(function*() {
      const { work } = yield* fixture
      const failed = (observedAt: number, reason: string) =>
        at(observedAt, { _tag: "unknown", reason, source: "github", subject: "github:knpkv/npm#7" })
      yield* work.record({ eventId: "goal-pr7.1", goal, occurredAt: 1_000, version: "herdr.work.event.v1" })
      yield* work.observe([failed(300, "gh: 502")])
      yield* work.observe([failed(100, "gh: rate limited")])
      expect((yield* work.snapshots(10_000)).now.observed?.[0]?.unknown).toEqual({
        lastGoodAt: null,
        reason: "gh: 502",
        since: 100,
        source: "github"
      })
    })))

  it.effect("stores the longest valid agent subject and rejects a subject past its bound without writing", () =>
    Effect.scoped(Effect.gen(function*() {
      const { work } = yield* fixture
      const longest = { ...agent("idle", "a".repeat(256)), host: "h".repeat(256) }
      expect((yield* work.observe([at(100, longest)])).outcomes[0]?._tag).toBe("stored")
      yield* work.snapshots(10_000)
      const tooLong = at(200, {
        _tag: "pull_request",
        branch: "feat/x",
        checks: "none",
        closedAt: null,
        head: "a".repeat(40),
        pullRequest: 7,
        repository: `${"o".repeat(600)}/${"r".repeat(600)}`,
        review: "requested",
        state: "open"
      })
      expect(yield* Effect.flip(work.observe([at(150, agent("working")), tooLong]))).toMatchObject({
        _tag: "WorkStoreError",
        operation: "observe.subject"
      })
      expect((yield* work.observe([at(160, agent("working"))])).outcomes[0]?._tag).toBe("stored")
    })))

  it.effect("matches a pull request whatever the letter case of its repository", () =>
    Effect.scoped(Effect.gen(function*() {
      const { work } = yield* fixture
      yield* work.record({
        eventId: "goal-pr7.1",
        goal: { ...goal, review: { ...goal.review!, url: "https://github.com/Knpkv/NPM/pull/7" } },
        occurredAt: 1_000,
        version: "herdr.work.event.v1"
      })
      yield* work.observe([at(5_000, pullRequest({ closedAt: 4_900, state: "merged" }))])
      expect((yield* work.snapshots(10_000)).now.observed?.[0]?.displayState).toBe("completed")
    })))

  it.effect("keeps the database's WAL siblings private after an observation", () =>
    Effect.scoped(Effect.gen(function*() {
      if (platform() === "win32") return
      const { path, work } = yield* fixture
      yield* work.observe([at(100, agent("idle"))])
      expect(existsSync(`${path}-wal`)).toBe(true)
      for (const sibling of [`${path}-wal`, `${path}-shm`].filter((file) => existsSync(file))) {
        chmodSync(sibling, 0o644)
      }
      yield* work.observe([at(200, agent("working"))])
      for (const file of [path, `${path}-wal`, `${path}-shm`].filter((candidate) => existsSync(candidate))) {
        expect(statSync(file).mode & 0o777, file).toBe(0o600)
      }
    })))

  it.effect("keeps observed entries within the response budget, most recently updated goals first, and counts the rest", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture
      for (const number of [7, 8, 9]) {
        yield* work.record({
          eventId: `goal-pr${number}.1`,
          goal: {
            ...goal,
            id: `goal-pr${number}`,
            review: { ...goal.review!, updatedAt: 1_000 + number, url: `https://github.com/knpkv/npm/pull/${number}` },
            updatedAt: 1_000 + number,
            createdAt: 1_000 + number
          },
          occurredAt: 1_000 + number,
          version: "herdr.work.event.v1"
        })
        yield* work.observe([at(5_000, pullRequest({ pullRequest: number }))])
      }
      // Goals that nothing was observed about get no entry at all.
      yield* work.record({
        eventId: "goal-quiet.1",
        goal: { ...goal, createdAt: 1_001, id: "goal-quiet", review: null, updatedAt: 1_001 },
        occurredAt: 1_001,
        version: "herdr.work.event.v1"
      })
      const full = yield* work.snapshots(10_000)
      expect(full.now.observed?.map(({ goalId }) => goalId)).toEqual(["goal-pr9", "goal-pr8", "goal-pr7"])
      const { facts, failures } = yield* store.snapshotInput()
      const { observed: _observed, ...now } = full.now
      const base: WorkSnapshots = { ...full, now }
      const size = (snapshots: WorkSnapshots) =>
        new TextEncoder().encode(JSON.stringify(Schema.encodeSync(WorkSnapshots)(snapshots))).byteLength
      const budget = size(base) + 64 + 2 * (size(withObservedFacts(base, facts, failures, 10_000_000)) - size(base)) / 3
      const trimmed = withObservedFacts(base, facts, failures, budget)
      expect(trimmed.now.observed?.map(({ goalId }) => goalId)).toEqual(["goal-pr9", "goal-pr8"])
      expect(trimmed.now.observedOmitted).toBe(1)
      expect(size(trimmed)).toBeLessThanOrEqual(budget)
      const countOnly = withObservedFacts(base, facts, failures, size(base) + 24)
      expect(countOnly.now.observed).toBeUndefined()
      expect(countOnly.now.observedOmitted).toBe(3)
      expect(size(countOnly)).toBeLessThanOrEqual(size(base) + 24)
      // Not even the count fits: the snapshots come back unchanged, never over budget.
      expect(withObservedFacts(base, facts, failures, size(base))).toEqual(base)
    })))

  it.effect("keeps a failure newer than a delayed good read, and ends it only with a newer good read", () =>
    Effect.scoped(Effect.gen(function*() {
      const { work } = yield* fixture
      const failed = (observedAt: number, reason: string) =>
        at(observedAt, { _tag: "unknown", reason, source: "github", subject: "github:knpkv/npm#7" })
      const unknownOf = Effect.map(work.snapshots(10_000), (snapshots) => snapshots.now.observed?.[0]?.unknown)
      yield* work.record({ eventId: "goal-pr7.1", goal, occurredAt: 1_000, version: "herdr.work.event.v1" })
      yield* work.observe([at(50, pullRequest())])
      yield* work.observe([failed(100, "failed 100")])
      yield* work.observe([failed(300, "failed 300")])
      yield* work.observe([at(200, pullRequest())])
      expect(yield* unknownOf).toEqual({ lastGoodAt: 200, reason: "failed 300", since: 201, source: "github" })
      yield* work.observe([at(400, pullRequest())])
      expect(yield* unknownOf).toBeNull()
    })))

  it.effect("shows a historical snapshot only what was known by its time", () =>
    Effect.scoped(Effect.gen(function*() {
      const { work } = yield* fixture
      yield* work.record({ eventId: "goal-pr7.1", goal, occurredAt: 1_000, version: "herdr.work.event.v1" })
      yield* work.observe([at(3_000, pullRequest())])
      yield* work.observe([at(5_000, pullRequest({ closedAt: 4_900, state: "merged" }))])
      yield* work.observe([
        at(6_000, { _tag: "unknown", reason: "gh: 502", source: "github", subject: "github:knpkv/npm#7" })
      ])
      expect((yield* work.snapshots(2_000)).now.observed).toBeUndefined()
      const atMerge = (yield* work.snapshots(5_500)).now.observed?.[0]
      expect(atMerge?.displayState).toBe("completed")
      expect(atMerge?.unknown).toBeNull()
      expect((yield* work.snapshots(7_000)).now.observed?.[0]?.unknown?.since).toBe(6_000)
    })))

  it.effect("treats a host or repository spelled in another letter case as the same facts", () =>
    Effect.scoped(Effect.gen(function*() {
      const { work } = yield* fixture
      yield* work.observe([at(100, agent("gone"))])
      expect((yield* work.observe([at(200, { ...agent("gone"), host: "ser8" })])).outcomes[0]?._tag).toBe("unchanged")
      yield* work.observe([at(300, pullRequest())])
      expect((yield* work.observe([at(400, pullRequest({ repository: "KNPKV/npm" }))])).outcomes[0]?._tag)
        .toBe("unchanged")
    })))
})
