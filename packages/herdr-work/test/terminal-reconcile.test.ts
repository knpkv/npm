import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Crypto, Deferred, Effect, Fiber, Ref, Result, Schema } from "effect"
import { Hex } from "effect/encoding"
import { TestClock } from "effect/testing"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  makeWorkService,
  withActivityProvenance,
  type WorkActivity,
  type WorkGoal,
  type WorkGoalCheckpoint,
  workHistoryMaxEvents,
  type WorkObservationEnvelope,
  type WorkObserveReport,
  type WorkPullRequestObservation,
  workReconcilerHeadroom,
  WorkSnapshots,
  WorkStore
} from "../src/index.js"

// @effect-diagnostics-next-line strictEffectProvide:off
const provideNodeServices = Effect.provide(NodeServices.layer)

const fixtureWith = (configureCrypto?: (base: Crypto.Crypto) => Crypto.Crypto) =>
  Effect.gen(function*() {
    yield* TestClock.setTime(100_000)
    const root = mkdtempSync(join(tmpdir(), "herdr-terminal-reconcile-"))
    yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { recursive: true, force: true })))
    const baseCrypto = yield* Crypto.Crypto
    const path = join(root, "work.sqlite")
    const store = yield* Effect.acquireRelease(
      WorkStore.open(path).pipe(
        Effect.provideService(Crypto.Crypto, configureCrypto?.(baseCrypto) ?? baseCrypto)
      ),
      (opened) => Effect.sync(() => opened.close())
    )
    const work = yield* makeWorkService(store)
    return { path, store, work }
  }).pipe(provideNodeServices)

const fixture = fixtureWith()

/** Crypto that, while `suspend` is set, parks each digest until `release`, after signalling `entered`. */
const suspendingFixture = Effect.gen(function*() {
  const suspend = yield* Ref.make(false)
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const opened = yield* fixtureWith((baseCrypto) => ({
    ...baseCrypto,
    digest: (algorithm, data) =>
      Effect.gen(function*() {
        if (yield* Ref.get(suspend)) {
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
        }
        return yield* baseCrypto.digest(algorithm, data)
      })
  }))
  return { ...opened, entered, release, suspend }
})

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

/** What an observe pass confirmed: the stored or unchanged facts, by subject and observation id. */
const confirmedIn = (report: WorkObserveReport) =>
  report.outcomes.flatMap((outcome) =>
    outcome._tag === "stored" || outcome._tag === "unchanged"
      ? [{ observationId: outcome.observationId, subject: outcome.subject }]
      : []
  )

const record = (work: Effect.Success<typeof fixture>["work"], eventId: string, value: WorkGoal) =>
  work.record({ eventId, goal: value, occurredAt: value.updatedAt, version: "herdr.work.event.v1" })

const currentGoal = (work: Effect.Success<typeof fixture>["work"]) =>
  Effect.map(work.snapshots(100_000), (snapshots) => snapshots.now.goals.find(({ id }) => id === "goal-pr7"))

/** Confirms every stored fact, as a pass that has just re-read them all would, then reconciles. */
const reconcileConfirmed = (
  store: { readonly snapshotInput: WorkStore["snapshotInput"] },
  work: { readonly reconcile: WorkStore["reconcile"] }
) =>
  store.snapshotInput().pipe(
    Effect.flatMap(({ facts }) =>
      work.reconcile({ confirmed: facts.map(({ observationId, subject }) => ({ observationId, subject })) })
    )
  )

describe("terminal reconcile", () => {
  it.effect("records a merged pull request's goal as completed at the merge time, once", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture
      yield* record(work, "goal-pr7.1", goal())
      yield* work.observe([{ observation: pullRequest({ closedAt: 5_000, state: "merged" }), observedAt: 6_000 }])
      const [outcome] = yield* reconcileConfirmed(store, work)
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
      expect(yield* reconcileConfirmed(store, work)).toEqual([])
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
      const { store, work } = yield* fixture
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
      yield* reconcileConfirmed(store, work)
      const snapshots = yield* work.snapshots(100_000)
      const { activityOrigins, reconcilerEvents } = yield* store.snapshotInput()
      const { activityProvenance: _provenance, activityProvenanceGoals: _goals, ...bare } = snapshots.now
      const base = { ...snapshots, now: bare }
      const size = (value: WorkSnapshots) =>
        new TextEncoder().encode(JSON.stringify(Schema.encodeSync(WorkSnapshots)(value))).byteLength
      const full = withActivityProvenance(base, [], reconcilerEvents, activityOrigins, 10_000_000)
      expect(full.now.activityProvenanceGoals).toHaveLength(3)
      const budget = size(base) + 128 + Math.floor((size(full) - size(base)) / 2)
      const trimmed = withActivityProvenance(base, [], reconcilerEvents, activityOrigins, budget)
      const covered = trimmed.now.activityProvenanceGoals ?? []
      expect(covered.length).toBeGreaterThan(0)
      expect(covered).toEqual(full.now.activityProvenanceGoals?.slice(0, covered.length))
      expect(trimmed.now.activityProvenanceOmitted).toBe(3 - covered.length)
      expect(trimmed.now.activityProvenance?.every(({ goalId }) => covered.includes(goalId))).toBe(true)
      expect(size(trimmed)).toBeLessThanOrEqual(budget)
      // Not even empty lists fit: no provenance at all, so every goal reads as unknown.
      expect(withActivityProvenance(base, [], reconcilerEvents, activityOrigins, size(base))).toEqual(base)
    })))

  it.effect("never acts on a fact a newer failed read has put in doubt", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture
      yield* record(work, "goal-pr7.1", goal())
      yield* work.observe([{ observation: pullRequest({ closedAt: 5_000, state: "closed" }), observedAt: 6_000 }])
      yield* work.observe([{
        observation: {
          _tag: "unknown",
          reason: "GitHub returned 502",
          source: "github",
          subject: "github:knpkv/npm#7"
        },
        observedAt: 7_000
      }])
      expect(yield* reconcileConfirmed(store, work)).toEqual([])
      expect((yield* currentGoal(work))?.state).toBe("review")
    })))

  it.effect("with confirmed, acts only on facts the caller read and the store accepted in this pass", () =>
    Effect.scoped(Effect.gen(function*() {
      const { work } = yield* fixture
      yield* record(work, "goal-pr7.1", goal())
      const report = yield* work.observe([{
        observation: pullRequest({ closedAt: 5_000, state: "closed" }),
        observedAt: 6_000
      }])
      expect(yield* work.reconcile({ confirmed: [] })).toEqual([])
      expect((yield* currentGoal(work))?.state).toBe("review")
      expect((yield* work.reconcile({ confirmed: confirmedIn(report) }))[0]?._tag).toBe("applied")
      expect((yield* currentGoal(work))?.state).toBe("abandoned")
    })))

  it.effect("a reopen the store refuses as stale confirms nothing, so the stored close is not acted on", () =>
    Effect.scoped(Effect.gen(function*() {
      const { work } = yield* fixture
      yield* record(work, "goal-pr7.1", goal())
      yield* work.observe([{ observation: pullRequest({ closedAt: 5_000, state: "closed" }), observedAt: 8_000 }])
      const reread = yield* work.observe([{
        observation: pullRequest({ closedAt: null, state: "open" }),
        observedAt: 7_500
      }])
      expect(reread.outcomes.map(({ _tag }) => _tag)).toEqual(["stale"])
      expect(yield* work.reconcile({ confirmed: confirmedIn(reread) })).toEqual([])
      expect((yield* currentGoal(work))?.state).toBe("review")
    })))

  it.effect("rejects a confirmation that is no longer the subject's stored fact", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture
      yield* record(work, "goal-pr7.1", goal())
      const closed = yield* work.observe([{
        observation: pullRequest({ closedAt: 5_000, state: "closed" }),
        observedAt: 6_000
      }])
      yield* work.observe([{ observation: pullRequest({ closedAt: null, state: "open" }), observedAt: 7_000 }])
      const history = yield* store.list()
      expect(yield* Effect.result(work.reconcile({ confirmed: confirmedIn(closed) }))).toMatchObject({
        failure: { _tag: "WorkStoreError", operation: "reconcile.confirmed" }
      })
      expect(yield* store.list()).toEqual(history)
    })))

  it.effect("re-checks failures in the write: a failed read during planning stops the close", () =>
    Effect.scoped(Effect.gen(function*() {
      const { entered, release, suspend, work } = yield* suspendingFixture
      yield* record(work, "goal-pr7.1", goal())
      const report = yield* work.observe([{
        observation: pullRequest({ closedAt: 5_000, state: "closed" }),
        observedAt: 6_000
      }])
      yield* Ref.set(suspend, true)
      const running = yield* Effect.forkChild(work.reconcile({ confirmed: confirmedIn(report) }))
      yield* Deferred.await(entered)
      yield* Ref.set(suspend, false)
      yield* work.observe([{
        observation: {
          _tag: "unknown",
          reason: "GitHub returned 502",
          source: "github",
          subject: "github:knpkv/npm#7"
        },
        observedAt: 7_000
      }])
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(running)).toEqual([{ _tag: "conflict", goalId: "goal-pr7" }])
      expect((yield* currentGoal(work))?.state).toBe("review")
    })))

  it.effect("refuses a malformed confirmation instead of ignoring it", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture
      yield* record(work, "goal-pr7.1", goal())
      yield* work.observe([{ observation: pullRequest({ closedAt: 5_000, state: "closed" }), observedAt: 6_000 }])
      const history = yield* store.list()
      expect(
        yield* Effect.result(
          work.reconcile({ confirmed: [{ observationId: "not-a-digest", subject: "github:knpkv/npm#7" }] })
        )
      ).toMatchObject({
        failure: { _tag: "WorkStoreError", operation: "reconcile.options" }
      })
      expect(yield* store.list()).toEqual(history)
    })))

  it.effect("evicting a failed read never makes an unconfirmed fact actionable", () =>
    Effect.scoped(Effect.gen(function*() {
      const { work } = yield* fixture
      yield* record(work, "goal-pr7.1", goal())
      yield* work.observe([{ observation: pullRequest({ closedAt: 5_000, state: "closed" }), observedAt: 6_000 }])
      const failed = yield* work.observe([{
        observation: {
          _tag: "unknown",
          reason: "GitHub returned 502",
          source: "github",
          subject: "github:knpkv/npm#7"
        },
        observedAt: 7_000
      }])
      // Enough newer failures elsewhere to evict this subject's failure row.
      yield* work.observe(Array.from({ length: 4_096 }, (_, index): WorkObservationEnvelope => ({
        observation: {
          _tag: "unknown",
          reason: "GitHub returned 502",
          source: "github",
          subject: `github:knpkv/other#${String(index + 1)}`
        },
        observedAt: 8_000
      })))
      expect(yield* work.reconcile({ confirmed: confirmedIn(failed) })).toEqual([])
      expect((yield* currentGoal(work))?.state).toBe("review")
    })))

  it.effect("records a pull request closed without merging as abandoned", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture
      yield* record(work, "goal-pr7.1", goal({ blocker: { since: 1_000, summary: "Waiting" }, state: "blocked" }))
      yield* work.observe([{ observation: pullRequest({ closedAt: 5_000, state: "closed" }), observedAt: 6_000 }])
      expect((yield* reconcileConfirmed(store, work))[0]).toMatchObject({ _tag: "applied", state: "abandoned" })
      expect(yield* currentGoal(work)).toMatchObject({ blocker: null, delivery: "pull_request", state: "abandoned" })
    })))

  it.effect("stamps one millisecond after an owner checkpoint written at or after the close", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture
      yield* record(work, "goal-pr7.1", goal())
      yield* record(work, "goal-pr7.2", goal({ updatedAt: 5_000 }))
      yield* work.observe([{ observation: pullRequest({ closedAt: 5_000, state: "merged" }), observedAt: 6_000 }])
      yield* reconcileConfirmed(store, work)
      expect((yield* currentGoal(work))?.updatedAt).toBe(5_001)
    })))

  it.effect("never stamps a goal twice, even after its owner writes it open again", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture
      yield* record(work, "goal-pr7.1", goal())
      yield* work.observe([{ observation: pullRequest({ closedAt: 5_000, state: "merged" }), observedAt: 6_000 }])
      const [applied] = yield* reconcileConfirmed(store, work)
      yield* record(work, "goal-pr7.3", goal({ state: "working", updatedAt: 7_000 }))
      const history = yield* store.list()
      const [again] = yield* reconcileConfirmed(store, work)
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
      expect(yield* reconcileConfirmed(store, work)).toEqual([])
      expect(yield* store.list()).toEqual(history)
    })))

  it.effect("keeps the reconciler's ids to itself and never credits it with an owner's activity", () =>
    Effect.scoped(Effect.gen(function*() {
      const { work } = yield* fixture
      expect(yield* Effect.flip(record(work, "reconciler.forged", goal()))).toMatchObject({
        _tag: "WorkProjectionError",
        reason: "malformed"
      })
      yield* record(
        work,
        "goal-pr7.1",
        goal({
          activity: [{ id: "reconciler.owner-note", kind: "note", occurredAt: 1_000, summary: "Owner note" }]
        })
      )
      const now = (yield* work.snapshots(100_000)).now
      expect(now.activityProvenance).toEqual([])
      expect(now.activityProvenanceGoals).toEqual(["goal-pr7"])
    })))

  it.effect("stamps a goal once even after its pull request's checks change", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture
      yield* record(work, "goal-pr7.1", goal())
      yield* work.observe([{
        observation: pullRequest({ checks: "pending", closedAt: 5_000, state: "merged" }),
        observedAt: 6_000
      }])
      const [applied] = yield* reconcileConfirmed(store, work)
      yield* record(work, "goal-pr7.3", goal({ state: "working", updatedAt: 7_000 }))
      yield* work.observe([{
        observation: pullRequest({ checks: "passing", closedAt: 5_000, state: "merged" }),
        observedAt: 8_000
      }])
      const history = yield* store.list()
      expect(yield* reconcileConfirmed(store, work)).toEqual([{
        _tag: "recorded",
        eventId: applied?._tag === "applied" ? applied.eventId : "",
        goalId: "goal-pr7"
      }])
      expect(yield* store.list()).toEqual(history)
    })))

  it.effect("reports a conflict, not a stale stamp, when the fact changes while it plans", () =>
    Effect.scoped(Effect.gen(function*() {
      const { entered, release, store, suspend, work } = yield* suspendingFixture
      yield* record(work, "goal-pr7.1", goal())
      yield* work.observe([{ observation: pullRequest({ closedAt: 5_000, state: "closed" }), observedAt: 6_000 }])
      const history = yield* store.list()
      yield* Ref.set(suspend, true)
      const pending = yield* reconcileConfirmed(store, work).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      yield* Ref.set(suspend, false)
      yield* work.observe([{ observation: pullRequest(), observedAt: 7_000 }])
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(pending)).toEqual([{ _tag: "conflict", goalId: "goal-pr7" }])
      expect(yield* store.list()).toEqual(history)
    })))

  it.effect("reports a conflict when an owner writes at the planned time while it plans", () =>
    Effect.scoped(Effect.gen(function*() {
      const { entered, release, store, suspend, work } = yield* suspendingFixture
      yield* record(work, "goal-pr7.1", goal())
      yield* work.observe([{ observation: pullRequest({ closedAt: 5_000, state: "merged" }), observedAt: 6_000 }])
      yield* Ref.set(suspend, true)
      const pending = yield* reconcileConfirmed(store, work).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      yield* Ref.set(suspend, false)
      yield* record(work, "goal-pr7.2", goal({ updatedAt: 5_000 }))
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(pending)).toEqual([{ _tag: "conflict", goalId: "goal-pr7" }])
      expect((yield* currentGoal(work))?.state).toBe("review")
    })))

  it.effect(
    "leaves the reserved history free: a pass at the reserve boundary writes nothing",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const { store, work } = yield* fixture
        const filler = Array.from(
          { length: workHistoryMaxEvents - workReconcilerHeadroom - 1 },
          (_, index): WorkGoalCheckpoint => {
            const at = 1_000 + index
            return {
              eventId: `filler.${index}`,
              goal: goal({ id: "goal-filler", review: null, updatedAt: at }),
              occurredAt: at,
              version: "herdr.work.event.v1"
            }
          }
        )
        yield* work.recordMany("filler", filler)
        yield* record(work, "goal-pr7.1", goal())
        yield* work.observe([{ observation: pullRequest({ closedAt: 5_000, state: "merged" }), observedAt: 6_000 }])
        const before = (yield* store.list()).length
        expect(before).toBe(workHistoryMaxEvents - workReconcilerHeadroom)
        expect(yield* Effect.flip(reconcileConfirmed(store, work))).toMatchObject({
          _tag: "WorkProjectionError",
          reason: "capacity_exceeded"
        })
        expect((yield* store.list()).length).toBe(before)
      })),
    120_000
  )

  it.effect("accepts activity provenance only on the now window and only for covered goals", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture
      yield* record(work, "goal-pr7.1", goal())
      yield* work.observe([{ observation: pullRequest({ closedAt: 5_000, state: "merged" }), observedAt: 6_000 }])
      yield* reconcileConfirmed(store, work)
      const valid = Schema.encodeSync(WorkSnapshots)(yield* work.snapshots(100_000))
      const decode = Schema.decodeUnknownResult(WorkSnapshots)
      expect(Result.isSuccess(decode(valid))).toBe(true)
      expect(Result.isFailure(decode({ ...valid, week: { ...valid.week, activityProvenanceGoals: [] } }))).toBe(true)
      expect(Result.isFailure(decode({ ...valid, now: { ...valid.now, activityProvenanceGoals: [] } }))).toBe(true)
    })))

  it.effect("ignores a forged reconciler id: neither a stamp that blocks reconcile nor credited authorship", () =>
    Effect.scoped(Effect.gen(function*() {
      const { path, store, work } = yield* fixture
      yield* record(work, "goal-pr7.1", goal())
      const forged = goal({
        activity: [{ id: "reconciler.forged", kind: "note", occurredAt: 1_500, summary: "Not the reconciler" }],
        updatedAt: 1_500
      })
      const database = new DatabaseSync(path)
      database.prepare("INSERT INTO work_goal_events (event_id, goal_id, occurred_at, record) VALUES (?, ?, ?, ?)").run(
        "reconciler.forged",
        "goal-pr7",
        1_500,
        JSON.stringify({
          eventId: "reconciler.forged",
          goal: forged,
          occurredAt: 1_500,
          version: "herdr.work.event.v1"
        })
      )
      database.close()
      expect((yield* work.snapshots(100_000)).now.activityProvenance).toEqual([])
      yield* work.observe([{ observation: pullRequest({ closedAt: 5_000, state: "merged" }), observedAt: 6_000 }])
      expect((yield* reconcileConfirmed(store, work))[0]).toMatchObject({ _tag: "applied", goalId: "goal-pr7" })
    })))

  it.effect("credits the reconciler only while its activity still reads as it wrote it", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture
      yield* record(work, "goal-pr7.1", goal())
      yield* work.observe([{ observation: pullRequest({ closedAt: 5_000, state: "merged" }), observedAt: 6_000 }])
      yield* reconcileConfirmed(store, work)
      const stamped = yield* currentGoal(work)
      const shipment = stamped?.activity?.at(-1)
      if (stamped === undefined || shipment === undefined) return expect.unreachable()
      yield* record(work, "goal-pr7.2", { ...stamped, updatedAt: 7_000 })
      expect((yield* work.snapshots(100_000)).now.activityProvenance?.map(({ provenance }) => provenance)).toEqual([
        "reconciler"
      ])
      yield* record(work, "goal-pr7.3", {
        ...stamped,
        activity: [...(stamped.activity ?? []).slice(0, -1), { ...shipment, summary: "Rewritten by the owner" }],
        updatedAt: 8_000
      })
      expect((yield* work.snapshots(100_000)).now.activityProvenance).toEqual([])
    })))

  it.effect("never stamps past the store's clock, whatever close time the provider reports", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture
      yield* record(work, "goal-pr7.1", goal())
      yield* work.observe([{
        observation: pullRequest({ closedAt: 9_000_000_000, state: "merged" }),
        observedAt: 6_000
      }])
      yield* reconcileConfirmed(store, work)
      expect((yield* currentGoal(work))?.updatedAt).toBe(100_000)
    })))

  it.effect("keeps every owner activity when the goal's activity is full", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture
      const activity = Array.from({ length: 128 }, (_, index): WorkActivity => ({
        id: `owner-${index}`,
        kind: "note",
        occurredAt: 1_000,
        summary: `Owner note ${index}`
      }))
      yield* record(work, "goal-pr7.1", goal({ activity }))
      yield* work.observe([{ observation: pullRequest({ closedAt: 5_000, state: "merged" }), observedAt: 6_000 }])
      expect((yield* reconcileConfirmed(store, work))[0]?._tag).toBe("applied")
      const completed = yield* currentGoal(work)
      expect(completed?.state).toBe("completed")
      expect(completed?.activity?.map(({ id }) => id)).toEqual(activity.map(({ id }) => id))
    })))

  it.effect("does not credit the reconciler with an activity its owner removed and later wrote again", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture
      yield* record(work, "goal-pr7.1", goal())
      yield* work.observe([{ observation: pullRequest({ closedAt: 5_000, state: "merged" }), observedAt: 6_000 }])
      yield* reconcileConfirmed(store, work)
      const stamped = yield* currentGoal(work)
      const shipment = stamped?.activity?.at(-1)
      if (stamped === undefined || shipment === undefined) return expect.unreachable()
      yield* record(work, "goal-pr7.2", {
        ...stamped,
        activity: (stamped.activity ?? []).slice(0, -1),
        updatedAt: 7_000
      })
      yield* record(work, "goal-pr7.3", { ...stamped, updatedAt: 8_000 })
      expect((yield* work.snapshots(100_000)).now.activityProvenance).toEqual([])
    })))

  it.effect("reports a conflict, not a failed run, when an owner activity already holds the reconciler's id", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture
      yield* work.observe([{ observation: pullRequest({ closedAt: 5_000, state: "merged" }), observedAt: 6_000 }])
      const fact = (yield* store.snapshotInput()).facts[0]
      if (fact === undefined) return expect.unreachable()
      const digest = yield* Crypto.Crypto.pipe(
        Effect.flatMap((service) =>
          service.digest("SHA-256", new TextEncoder().encode(`${fact.observationId}\u0000goal-pr7`))
        ),
        provideNodeServices
      )
      const id = `reconciler.${Hex.encode(digest)}`
      yield* record(
        work,
        "goal-pr7.1",
        goal({ activity: [{ id, kind: "note", occurredAt: 1_000, summary: "Squatting" }] })
      )
      expect(yield* reconcileConfirmed(store, work)).toEqual([{ _tag: "conflict", goalId: "goal-pr7" }])
    })))
})
