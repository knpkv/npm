import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  makeWorkService,
  withActivityProvenance,
  type WorkGoal,
  type WorkPullRequestObservation,
  WorkSnapshots,
  WorkStore
} from "../src/index.js"

// @effect-diagnostics-next-line strictEffectProvide:off
const provideNodeServices = Effect.provide(NodeServices.layer)

const fixture = Effect.gen(function*() {
  yield* TestClock.setTime(100_000)
  const root = mkdtempSync(join(tmpdir(), "herdr-terminal-reconcile-"))
  yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { recursive: true, force: true })))
  const store = yield* Effect.acquireRelease(
    WorkStore.open(join(root, "work.sqlite")),
    (opened) => Effect.sync(() => opened.close())
  )
  const work = yield* makeWorkService(store)
  return { store, work }
}).pipe(provideNodeServices)

const goal = (overrides: Partial<WorkGoal> = {}): WorkGoal => ({
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
  updatedAt: 1_000,
  ...overrides
})

const pullRequest = (overrides: Partial<WorkPullRequestObservation> = {}): WorkPullRequestObservation => ({
  _tag: "pull_request",
  branch: "feat/x",
  checks: "passing",
  closedAt: null,
  head: "a".repeat(40),
  pullRequest: 7,
  repository: "knpkv/npm",
  review: "approved",
  state: "open",
  ...overrides
})

const record = (work: Effect.Success<typeof fixture>["work"], eventId: string, value: WorkGoal) =>
  work.record({ eventId, goal: value, occurredAt: value.updatedAt, version: "herdr.work.event.v1" })

const currentGoal = (work: Effect.Success<typeof fixture>["work"]) =>
  Effect.map(work.snapshots(100_000), (snapshots) => snapshots.now.goals.find(({ id }) => id === "goal-pr7"))

describe("terminal reconcile", () => {
  it.effect("records a merged pull request's goal as completed at the merge time, once", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture
      yield* record(work, "goal-pr7.1", goal())
      yield* work.observe([{ observation: pullRequest({ closedAt: 5_000, state: "merged" }), observedAt: 6_000 }])
      const [outcome] = yield* work.reconcile()
      expect(outcome).toMatchObject({ _tag: "applied", goalId: "goal-pr7", state: "completed" })
      const completed = yield* currentGoal(work)
      expect(completed).toMatchObject({ delivery: "merged", state: "completed", updatedAt: 5_000 })
      expect(completed?.activity?.at(-1)).toMatchObject({
        kind: "shipment",
        occurredAt: 5_000,
        summary: "Observed by the reconciler: https://github.com/knpkv/npm/pull/7 merged"
      })
      expect(outcome?._tag === "applied" && outcome.eventId.startsWith("reconciler.")).toBe(true)
      const history = yield* store.list()
      expect(yield* work.reconcile()).toEqual([])
      expect(yield* store.list()).toEqual(history)
      const now = (yield* work.snapshots(100_000)).now
      expect(now.activityProvenance).toEqual([{
        activityId: outcome?._tag === "applied" ? outcome.eventId : "",
        approvalJobId: null,
        goalId: "goal-pr7",
        provenance: "reconciler"
      }])
      expect(now.activityProvenanceGoals).toEqual(["goal-pr7"])
      expect(now.activityProvenanceOmitted).toBeUndefined()
    })))

  it.effect("covers provenance a whole goal at a time within the response budget, and never guesses the rest", () =>
    Effect.scoped(Effect.gen(function*() {
      const { work } = yield* fixture
      for (const number of [7, 8, 9]) {
        yield* record(
          work,
          `goal-pr${number}.1`,
          goal({
            createdAt: 1_000 + number,
            id: `goal-pr${number}`,
            review: {
              state: "requested",
              summary: null,
              updatedAt: 1_000 + number,
              url: `https://github.com/knpkv/npm/pull/${number}`
            },
            updatedAt: 1_000 + number
          })
        )
        yield* work.observe([{
          observation: pullRequest({ closedAt: 5_000, pullRequest: number, state: "merged" }),
          observedAt: 6_000
        }])
      }
      yield* work.reconcile()
      const snapshots = yield* work.snapshots(100_000)
      const { activityProvenance: _provenance, activityProvenanceGoals: _goals, ...bare } = snapshots.now
      const base = { ...snapshots, now: bare }
      const size = (value: WorkSnapshots) =>
        new TextEncoder().encode(JSON.stringify(Schema.encodeSync(WorkSnapshots)(value))).byteLength
      const full = withActivityProvenance(base, [], 10_000_000)
      expect(full.now.activityProvenanceGoals).toHaveLength(3)
      const budget = size(base) + 128 + Math.floor((size(full) - size(base)) / 2)
      const trimmed = withActivityProvenance(base, [], budget)
      const covered = trimmed.now.activityProvenanceGoals ?? []
      expect(covered.length).toBeGreaterThan(0)
      expect(covered).toEqual(full.now.activityProvenanceGoals?.slice(0, covered.length))
      expect(trimmed.now.activityProvenanceOmitted).toBe(3 - covered.length)
      expect(trimmed.now.activityProvenance?.every(({ goalId }) => covered.includes(goalId))).toBe(true)
      expect(size(trimmed)).toBeLessThanOrEqual(budget)
      // Not even empty lists fit: no provenance at all, so every goal reads as unknown.
      expect(withActivityProvenance(base, [], size(base))).toEqual(base)
    })))

  it.effect("records a pull request closed without merging as abandoned", () =>
    Effect.scoped(Effect.gen(function*() {
      const { work } = yield* fixture
      yield* record(work, "goal-pr7.1", goal({ blocker: { since: 1_000, summary: "Waiting" }, state: "blocked" }))
      yield* work.observe([{ observation: pullRequest({ closedAt: 5_000, state: "closed" }), observedAt: 6_000 }])
      expect((yield* work.reconcile())[0]).toMatchObject({ _tag: "applied", state: "abandoned" })
      expect(yield* currentGoal(work)).toMatchObject({ blocker: null, delivery: "pull_request", state: "abandoned" })
    })))

  it.effect("stamps one millisecond after an owner checkpoint written at or after the close", () =>
    Effect.scoped(Effect.gen(function*() {
      const { work } = yield* fixture
      yield* record(work, "goal-pr7.1", goal())
      yield* record(work, "goal-pr7.2", goal({ updatedAt: 5_000 }))
      yield* work.observe([{ observation: pullRequest({ closedAt: 5_000, state: "merged" }), observedAt: 6_000 }])
      yield* work.reconcile()
      expect((yield* currentGoal(work))?.updatedAt).toBe(5_001)
    })))

  it.effect("never stamps a goal twice, even after its owner writes it open again", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture
      yield* record(work, "goal-pr7.1", goal())
      yield* work.observe([{ observation: pullRequest({ closedAt: 5_000, state: "merged" }), observedAt: 6_000 }])
      const [applied] = yield* work.reconcile()
      yield* record(work, "goal-pr7.3", goal({ state: "working", updatedAt: 7_000 }))
      const history = yield* store.list()
      const [again] = yield* work.reconcile()
      expect(again).toEqual({
        _tag: "recorded",
        eventId: applied?._tag === "applied" ? applied.eventId : "",
        goalId: "goal-pr7"
      })
      expect(yield* store.list()).toEqual(history)
      expect((yield* currentGoal(work))?.state).toBe("working")
    })))

  it.effect("leaves goals with an open pull request or none at all", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture
      yield* record(work, "goal-pr7.1", goal())
      yield* record(work, "goal-none.1", goal({ id: "goal-none", review: null }))
      yield* work.observe([{ observation: pullRequest(), observedAt: 6_000 }])
      const history = yield* store.list()
      expect(yield* work.reconcile()).toEqual([])
      expect(yield* store.list()).toEqual(history)
    })))
})
