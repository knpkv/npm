import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeWorkService, type WorkGoalCheckpoint, type WorkPullRequestAttach, WorkStore } from "../src/index.js"

const original: WorkGoalCheckpoint = {
  version: "herdr.work.event.v1",
  eventId: "created",
  occurredAt: 1_000,
  goal: {
    id: "goal-attach",
    title: "Attach a pull request",
    summary: "Preserve coordinator updates",
    detail: "Existing goal",
    state: "working",
    owner: { id: "coordinator", name: "Coordinator" },
    repository: { repository: "example/project", branch: "feat/attach" },
    spend: { currency: "EUR", minorUnits: 500 },
    delivery: "local",
    blocker: null,
    connectTarget: null,
    activity: [{ id: "note", kind: "note", summary: "Keep this note", occurredAt: 1_000 }],
    createdAt: 1_000,
    updatedAt: 1_000
  }
}
const input: WorkPullRequestAttach = {
  goalId: original.goal.id,
  expectedGoalEventId: original.eventId,
  repository: original.goal.repository.repository,
  branch: original.goal.repository.branch,
  head: "a".repeat(40),
  reviewUrl: "https://github.com/example/project/pull/7",
  eventId: "attached",
  occurredAt: 3_000
}

const fixture = Effect.gen(function*() {
  const root = mkdtempSync(join(tmpdir(), "work-attach-"))
  yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
  const store = yield* Effect.acquireRelease(
    WorkStore.open(join(root, "work.sqlite")),
    (opened) => Effect.sync(() => opened.close())
  )
  const work = yield* makeWorkService(store)
  yield* work.record(original)
  return { work, store }
})

describe("atomic pull request attachment", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("attaches on the expected event and preserves every unrelated field", () =>
      Effect.gen(function*() {
        const { store, work } = yield* fixture
        const attached = yield* work.attachPullRequest(input)
        expect(attached).toEqual({
          version: original.version,
          eventId: input.eventId,
          occurredAt: input.occurredAt,
          goal: {
            ...original.goal,
            updatedAt: input.occurredAt,
            review: { state: "requested", url: input.reviewUrl, summary: null, updatedAt: input.occurredAt }
          }
        })
        expect(yield* store.list()).toEqual([original, attached])
      }))

    it.effect("refuses a stale event without writing", () =>
      Effect.gen(function*() {
        const { store, work } = yield* fixture
        expect(yield* Effect.result(work.attachPullRequest({ ...input, expectedGoalEventId: "stale" })))
          .toMatchObject({
            failure: {
              _tag: "WorkPullRequestAttachConflict",
              goalId: input.goalId,
              expectedGoalEventId: "stale",
              actualGoalEventId: original.eventId,
              reason: "stale_event"
            }
          })
        expect(yield* store.list()).toEqual([original])
      }))

    it.effect("refuses an update between the caller's read and attach at distinct timestamps", () =>
      Effect.gen(function*() {
        const { store, work } = yield* fixture
        const read = yield* Deferred.make<void>()
        const updated = yield* Deferred.make<void>()
        const caller = yield* Effect.gen(function*() {
          const latest = (yield* store.list()).at(-1)
          expect(latest).toEqual(original)
          yield* Deferred.succeed(read, undefined)
          yield* Deferred.await(updated)
          return yield* Effect.result(work.attachPullRequest({ ...input, expectedGoalEventId: latest?.eventId ?? "" }))
        }).pipe(Effect.forkScoped)
        yield* Deferred.await(read)
        const reassigned: WorkGoalCheckpoint = {
          ...original,
          eventId: "reassigned",
          occurredAt: 2_000,
          goal: { ...original.goal, owner: { id: "reviewer", name: "Reviewer" }, updatedAt: 2_000 }
        }
        yield* work.record(reassigned)
        yield* Deferred.succeed(updated, undefined)
        expect(yield* Fiber.join(caller)).toMatchObject({
          failure: {
            _tag: "WorkPullRequestAttachConflict",
            actualGoalEventId: "reassigned"
          }
        })
        expect(yield* store.list()).toEqual([original, reassigned])
      }))

    it.effect("refuses branch and repository mismatches", () =>
      Effect.gen(function*() {
        const { store, work } = yield* fixture
        for (
          const mismatch of [
            { ...input, branch: "feat/other" },
            { ...input, repository: "example/other", reviewUrl: "https://github.com/example/other/pull/7" }
          ]
        ) {
          expect(yield* Effect.result(work.attachPullRequest(mismatch))).toMatchObject({
            failure: {
              _tag: "WorkPullRequestAttachConflict",
              reason: "identity_mismatch"
            }
          })
        }
        expect(yield* store.list()).toEqual([original])
      }))

    it.effect("retries the same URL idempotently and refuses a different attached URL", () =>
      Effect.gen(function*() {
        const { store, work } = yield* fixture
        const attached = yield* work.attachPullRequest(input)
        expect(yield* work.attachPullRequest(input)).toEqual(attached)
        expect(yield* work.attachPullRequest({ ...input, eventId: "retry", occurredAt: 4_000 })).toEqual(attached)
        expect(
          yield* Effect.result(work.attachPullRequest({
            ...input,
            expectedGoalEventId: attached.eventId,
            eventId: "other",
            occurredAt: 4_000,
            reviewUrl: "https://github.com/example/project/pull/8"
          }))
        ).toMatchObject({ failure: { _tag: "WorkPullRequestAttachConflict", reason: "already_attached" } })
        expect(yield* store.list()).toEqual([original, attached])
      }))

    it.effect("a same-URL retry returns later owner and terminal updates without writing", () =>
      Effect.gen(function*() {
        const { store, work } = yield* fixture
        const attached = yield* work.attachPullRequest(input)
        const completed: WorkGoalCheckpoint = {
          ...attached,
          eventId: "completed",
          occurredAt: 4_000,
          goal: { ...attached.goal, state: "completed", owner: { id: "reviewer", name: "Reviewer" }, updatedAt: 4_000 }
        }
        yield* work.record(completed)
        expect(yield* work.attachPullRequest(input)).toEqual(completed)
        expect(yield* store.list()).toEqual([original, attached, completed])
      }))

    it.effect("refuses inactive and missing goals", () =>
      Effect.gen(function*() {
        const { store, work } = yield* fixture
        for (
          const state of ["completed", "abandoned", "deployed"] satisfies ReadonlyArray<
            WorkGoalCheckpoint["goal"]["state"]
          >
        ) {
          const terminal: WorkGoalCheckpoint = {
            ...original,
            eventId: state,
            occurredAt: 2_000,
            goal: { ...original.goal, id: state, state, updatedAt: 2_000, createdAt: 2_000, activity: [] }
          }
          yield* work.record(terminal)
          const before = yield* store.list()
          expect(
            yield* Effect.result(work.attachPullRequest({
              ...input,
              goalId: state,
              expectedGoalEventId: state
            }))
          ).toMatchObject({ failure: { _tag: "WorkPullRequestAttachConflict", reason: "inactive_goal" } })
          expect(yield* store.list()).toEqual(before)
        }
        expect(yield* Effect.result(work.attachPullRequest({ ...input, goalId: "missing" })))
          .toMatchObject({ failure: { _tag: "WorkPullRequestAttachConflict", actualGoalEventId: null } })
      }))

    it.effect("refuses caller-supplied goal fields at the service boundary", () =>
      Effect.gen(function*() {
        const { store, work } = yield* fixture
        const widened = { ...input, ...original, goal: { ...original.goal, title: "Injected title" } }
        expect(yield* Effect.result(work.attachPullRequest(widened))).toMatchObject({
          failure: { _tag: "WorkStoreError", operation: "attachPullRequest.decode" }
        })
        expect(yield* store.list()).toEqual([original])
      }))

    it.effect("validates URL, exact SHA, reserved IDs and advancing timestamps", () =>
      Effect.gen(function*() {
        const { store, work } = yield* fixture
        for (
          const invalid of [
            { ...input, head: "main" },
            { ...input, reviewUrl: "https://example.test/pull/7" },
            { ...input, reviewUrl: "https://github.com/example/other/pull/7" },
            { ...input, eventId: "reconciler.attach" },
            { ...input, occurredAt: 500 },
            { ...input, occurredAt: original.occurredAt }
          ]
        ) expect((yield* Effect.result(work.attachPullRequest(invalid)))._tag).toBe("Failure")
        expect(yield* store.list()).toEqual([original])
      }))
  })
})
