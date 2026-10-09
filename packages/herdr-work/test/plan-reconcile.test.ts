import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { Crypto, Deferred, Effect, Fiber, Ref, Schema } from "effect"
import { TestClock } from "effect/testing"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  makeWorkService,
  type WorkGoal,
  type WorkGoalCheckpoint,
  workHistoryMaxEvents,
  type WorkObservationEnvelope,
  type WorkObserveReport,
  type WorkPullRequestObservation,
  type WorkReconcileOptions,
  workReconcilerHeadroom,
  WorkStore
} from "../src/index.js"

const openStoreWith = (configureCrypto: (base: Crypto.Crypto) => Crypto.Crypto) =>
  Effect.gen(function*() {
    yield* TestClock.setTime(100_000)
    const root = mkdtempSync(join(tmpdir(), "herdr-plan-reconcile-"))
    yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
    const cryptoService = configureCrypto(yield* Crypto.Crypto)
    const store = yield* Effect.acquireRelease(
      WorkStore.open(join(root, "work.sqlite")).pipe(Effect.provideService(Crypto.Crypto, cryptoService)),
      (opened) => Effect.sync(() => opened.close())
    )
    return { store, work: yield* makeWorkService(store) }
  })

const openStore = openStoreWith((base) => base)

const goal = (number: number): WorkGoal => ({
  blocker: null,
  connectTarget: null,
  createdAt: 1_000,
  delivery: "pull_request",
  detail: "Review checkpoint",
  id: `goal-pr${String(number)}`,
  owner: { id: "owner", name: "Owner" },
  repository: { branch: `feat/${String(number)}`, repository: "knpkv/npm" },
  review: {
    state: "requested",
    summary: null,
    updatedAt: 1_000,
    url: `https://github.com/knpkv/npm/pull/${String(number)}`
  },
  spend: null,
  state: "review",
  summary: "Ship",
  title: "Ship",
  updatedAt: 1_000
})

const pullRequest = (
  number: number,
  state: WorkPullRequestObservation["state"]
): WorkPullRequestObservation => ({
  _tag: "pull_request",
  branch: `feat/${String(number)}`,
  checks: "passing",
  closedAt: state === "open" ? null : 5_000,
  head: "a".repeat(40),
  pullRequest: number,
  repository: "knpkv/npm",
  review: "approved",
  state
})

const confirmedIn = (report: WorkObserveReport) =>
  report.outcomes.flatMap((outcome) =>
    outcome._tag === "stored" || outcome._tag === "unchanged"
      ? [{ observationId: outcome.observationId, subject: outcome.subject }]
      : []
  )

/** One goal's situation: its PR's state, whether this pass confirms it, and what happened since. */
const Scenario = Schema.Array(
  Schema.Struct({
    state: Schema.Literals(["open", "merged", "closed"]),
    confirmed: Schema.Boolean,
    failedSince: Schema.Boolean,
    alreadyReconciled: Schema.Boolean,
    reopenedByOwner: Schema.Boolean
  })
).check(Schema.isMinLength(1), Schema.isMaxLength(5))

it.layer(NodeServices.layer)("planReconcile", (it) => {
  it.effect("plans a merged pull request's goal as would-complete, from the fact and goal event it read, writing nothing", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* openStore
      yield* work.record({ eventId: "goal-pr7.1", goal: goal(7), occurredAt: 1_000, version: "herdr.work.event.v1" })
      const report = yield* work.observe([{ observation: pullRequest(7, "merged"), observedAt: 6_000 }])
      const confirmed = confirmedIn(report)
      const history = yield* store.list()
      const plan = yield* work.planReconcile({ confirmed })
      expect(plan).toEqual([
        expect.objectContaining({
          _tag: "would_apply",
          goalEventId: "goal-pr7.1",
          goalId: "goal-pr7",
          goalUpdatedAt: 1_000,
          observationId: confirmed[0]?.observationId,
          state: "completed",
          subject: confirmed[0]?.subject
        })
      ])
      expect(yield* store.list()).toEqual(history)
      // The step it planned is the one reconcile then takes.
      const [applied] = yield* work.reconcile({ confirmed })
      expect(applied).toMatchObject({
        _tag: "applied",
        eventId: plan[0]?._tag === "would_apply" ? plan[0].eventId : "",
        goalId: "goal-pr7"
      })
    })))

  it.effect("fails as reconcile does on a confirmation that's no longer the stored fact", () =>
    Effect.scoped(Effect.gen(function*() {
      const { work } = yield* openStore
      yield* work.record({ eventId: "goal-pr7.1", goal: goal(7), occurredAt: 1_000, version: "herdr.work.event.v1" })
      const closed = yield* work.observe([{ observation: pullRequest(7, "closed"), observedAt: 6_000 }])
      yield* work.observe([{ observation: pullRequest(7, "open"), observedAt: 7_000 }])
      expect(yield* Effect.flip(work.planReconcile({ confirmed: confirmedIn(closed) }))).toMatchObject({
        _tag: "WorkStoreError",
        operation: "reconcile.confirmed"
      })
    })))

  it.effect.prop(
    "takes exactly the steps it planned when nothing changes in between",
    [Scenario],
    ([scenario]) =>
      Effect.scoped(Effect.gen(function*() {
        const { store, work } = yield* openStore
        const confirmed: Array<WorkReconcileOptions["confirmed"][number]> = []
        for (const [index, item] of scenario.entries()) {
          const number = index + 1
          yield* work.record({
            eventId: `goal-pr${String(number)}.1`,
            goal: goal(number),
            occurredAt: 1_000,
            version: "herdr.work.event.v1"
          })
          const report = yield* work.observe([{ observation: pullRequest(number, item.state), observedAt: 6_000 }])
          if (item.alreadyReconciled) {
            yield* work.reconcile({ confirmed: confirmedIn(report) })
            // An owner who reopens a goal the reconciler closed keeps it: the
            // reconciler has stamped it already and only reports that.
            if (item.reopenedByOwner) {
              yield* work.record({
                eventId: `goal-pr${String(number)}.reopened`,
                goal: { ...goal(number), updatedAt: 50_000 },
                occurredAt: 50_000,
                version: "herdr.work.event.v1"
              })
            }
          }
          if (item.failedSince) {
            const failed: WorkObservationEnvelope = {
              observation: {
                _tag: "unknown",
                reason: "GitHub returned 502",
                source: "github",
                subject: `github:knpkv/npm#${String(number)}`
              },
              observedAt: 7_000
            }
            yield* work.observe([failed])
          }
          if (item.confirmed) { for (const entry of confirmedIn(report)) confirmed.push(entry) }
        }
        const history = yield* store.list()
        const plan = yield* work.planReconcile({ confirmed })
        expect(yield* store.list()).toEqual(history)
        const applied = yield* work.reconcile({ confirmed })
        expect(applied).toEqual(
          plan.map((step) =>
            step._tag === "would_apply"
              ? { _tag: "applied", eventId: step.eventId, goalId: step.goalId, state: step.state }
              : step._tag === "conflict"
              ? { _tag: "conflict", goalId: step.goalId }
              : step
          )
        )
      })),
    // Each sample opens its own store: a few dozen cover the scenario space.
    { timeout: 60_000, arbitrary: { runs: 30 } }
  )

  it.effect("is advisory: reconcile decides again, against a goal event its owner wrote after the plan", () =>
    Effect.scoped(Effect.gen(function*() {
      const { work } = yield* openStore
      yield* work.record({ eventId: "goal-pr7.1", goal: goal(7), occurredAt: 1_000, version: "herdr.work.event.v1" })
      const report = yield* work.observe([{ observation: pullRequest(7, "merged"), observedAt: 6_000 }])
      const confirmed = confirmedIn(report)
      const [planned] = yield* work.planReconcile({ confirmed })
      yield* work.record({
        eventId: "goal-pr7.2",
        goal: { ...goal(7), updatedAt: 2_000 },
        occurredAt: 2_000,
        version: "herdr.work.event.v1"
      })
      expect(planned).toMatchObject({ _tag: "would_apply", goalEventId: "goal-pr7.1" })
      // Not a conflict: reconcile replans and closes the goal from its new head.
      expect(yield* work.reconcile({ confirmed })).toEqual([
        expect.objectContaining({ _tag: "applied", goalId: "goal-pr7" })
      ])
      // Closed now, so nothing is left to plan.
      expect(yield* work.planReconcile({ confirmed })).toEqual([])
    })))

  /** Two merged goals in a store left with `slots` checkpoints before the reconciler's reserve. */
  const nearCapacity = (slots: number) =>
    Effect.gen(function*() {
      const { store, work } = yield* openStore
      for (const number of [7, 8]) {
        yield* work.record({
          eventId: `goal-pr${String(number)}.1`,
          goal: goal(number),
          occurredAt: 1_000,
          version: "herdr.work.event.v1"
        })
      }
      const filler = workHistoryMaxEvents - workReconcilerHeadroom - slots - 2
      const first = goal(9)
      yield* store.appendMany(
        "fill",
        Array.from({ length: filler }, (_, index): WorkGoalCheckpoint => ({
          eventId: `fill.${String(index)}`,
          goal: { ...first, id: "goal-fill", review: null, updatedAt: 1_000 + index },
          occurredAt: 1_000 + index,
          version: "herdr.work.event.v1"
        }))
      )
      const report = yield* work.observe([
        { observation: pullRequest(7, "merged"), observedAt: 6_000 },
        { observation: pullRequest(8, "merged"), observedAt: 6_000 }
      ])
      return { store, work, confirmed: confirmedIn(report) }
    })

  it.effect(
    "plans against the checkpoints it would already have written, so it fails where reconcile would",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const { confirmed, store, work } = yield* nearCapacity(1)
        const history = yield* store.list()
        expect(yield* Effect.flip(work.planReconcile({ confirmed }))).toMatchObject({
          _tag: "WorkProjectionError",
          reason: "capacity_exceeded"
        })
        expect(yield* store.list()).toEqual(history)
        expect(yield* Effect.flip(work.reconcile({ confirmed }))).toMatchObject({
          _tag: "WorkProjectionError",
          reason: "capacity_exceeded"
        })
      })),
    { timeout: 60_000 }
  )

  it.effect(
    "plans every goal while room remains, writing no checkpoint or reconciler stamp",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const { confirmed, store, work } = yield* nearCapacity(2)
        const history = yield* store.list()
        const plan = yield* work.planReconcile({ confirmed })
        expect(plan.map(({ _tag }) => _tag)).toEqual(["would_apply", "would_apply"])
        expect(yield* store.list()).toEqual(history)
        // No stamp was kept either: reconcile still applies both, rather than reporting them recorded.
        expect((yield* work.reconcile({ confirmed })).map(({ _tag }) => _tag)).toEqual(["applied", "applied"])
      })),
    { timeout: 60_000 }
  )

  it.effect("holds no transaction while it waits, so other store calls run and never see planned checkpoints", () =>
    Effect.scoped(Effect.gen(function*() {
      // Once armed, the second digest (the plan's second step) waits for
      // `release`, after its first step was checked; observing digests too.
      const armed = yield* Ref.make(false)
      const digests = yield* Ref.make(0)
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const { store, work } = yield* openStoreWith((base) => ({
        ...base,
        digest: (algorithm, data) =>
          Effect.gen(function*() {
            if ((yield* Ref.get(armed)) && (yield* Ref.updateAndGet(digests, (count) => count + 1)) === 2) {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
            }
            return yield* base.digest(algorithm, data)
          })
      }))
      for (const number of [7, 8]) {
        yield* work.record({
          eventId: `goal-pr${String(number)}.1`,
          goal: goal(number),
          occurredAt: 1_000,
          version: "herdr.work.event.v1"
        })
      }
      const report = yield* work.observe([
        { observation: pullRequest(7, "merged"), observedAt: 6_000 },
        { observation: pullRequest(8, "merged"), observedAt: 6_000 }
      ])
      const confirmed = confirmedIn(report)
      const before = yield* store.list()
      yield* Ref.set(armed, true)
      const plan = yield* Effect.forkChild(work.planReconcile({ confirmed }))
      yield* Deferred.await(entered)
      // Mid-plan: reads see only what is stored, and an owner can still write.
      expect(yield* store.list()).toEqual(before)
      yield* work.record({ eventId: "goal-pr9.1", goal: goal(9), occurredAt: 1_000, version: "herdr.work.event.v1" })
      yield* Ref.set(armed, false)
      yield* work.observe([{ observation: pullRequest(9, "open"), observedAt: 6_000 }])
      yield* Deferred.succeed(release, undefined)
      const steps = yield* Fiber.join(plan)
      expect(steps.map(({ _tag }) => _tag)).toEqual(["would_apply", "would_apply"])
      expect((yield* store.list()).map(({ eventId }) => eventId)).toEqual([
        ...before.map(({ eventId }) => eventId),
        "goal-pr9.1"
      ])
    })))
})
