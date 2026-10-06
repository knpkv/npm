import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeWorkService, WorkStore } from "../src/index.js"
import type { WorkGoalAbandonment, WorkGoalCheckpoint, WorkLaneClaim } from "../src/model.js"

const owner = { id: "agent-codex-owner", name: "Codex owner" }

const original = {
  version: "herdr.work.event.v1",
  eventId: "goal-created",
  occurredAt: 500,
  goal: {
    id: "fix-iphone-live-ui-polish",
    title: "Polish live UI",
    summary: "iPhone live UI polish",
    detail: "No PR, no branch, no owner",
    state: "blocked",
    owner,
    repository: { repository: "example/npm", branch: "fix/ui" },
    spend: null,
    delivery: "local",
    blocker: { summary: "Waiting on a decision", since: 500 },
    connectTarget: null,
    createdAt: 500,
    updatedAt: 500
  }
} satisfies WorkGoalCheckpoint

const laneClaim = {
  operationId: "lane-first",
  goalId: original.goal.id,
  laneId: "lane-ui",
  worktree: "/tmp/ui-worktree",
  branch: "fix/ui",
  head: "a".repeat(40),
  owner,
  parent: null,
  phase: "implementation",
  expectedRevision: 0
} satisfies WorkLaneClaim

const request = {
  kind: "work.abandon",
  goalId: original.goal.id,
  owner,
  reason: "abandoned by Andrey 2026-10-06: no PR, no branch, no owner",
  expectedGoalEventId: original.eventId,
  expectedGoalUpdatedAt: original.goal.updatedAt,
  approvalJobId: "job-abandon-1",
  approvalActor: "coord",
  approvalApprovedBy: "andrey",
  approvalApprovedAt: 900,
  approvalHash: "c".repeat(64)
} satisfies WorkGoalAbandonment

const fixture = Effect.fn("fixture")(
  function*(options: { readonly lane: boolean }) {
    yield* TestClock.setTime(1_000)
    const root = mkdtempSync(join(tmpdir(), "herdr-goal-abandon-"))
    yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { recursive: true, force: true })))
    const store = yield* Effect.acquireRelease(
      WorkStore.open(join(root, "work.sqlite")),
      (opened) => Effect.sync(() => opened.close())
    )
    const work = yield* makeWorkService(store)
    yield* work.record(original)
    if (options.lane) yield* work.claim(laneClaim)
    return { store, work }
  },
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.provide(NodeServices.layer)
)

describe("approved goal abandonment", () => {
  it.effect("abandons the goal, clears its blocker and credits the activity to the approval", () =>
    Effect.scoped(Effect.gen(function*() {
      const { work } = yield* fixture({ lane: false })
      const result = yield* work.abandon(request)
      expect(result.checkpoint).toMatchObject({ eventId: request.approvalJobId, occurredAt: 1_000 })
      expect(result.checkpoint.goal).toMatchObject({ state: "abandoned", blocker: null, owner, updatedAt: 1_000 })
      expect(result.checkpoint.goal.activity).toEqual([{
        id: request.approvalJobId,
        kind: "status",
        summary:
          `Abandoned: ${request.reason} (approved Fleet job ${request.approvalJobId}, hash ${request.approvalHash})`,
        occurredAt: 1_000
      }])
      const now = (yield* work.snapshots()).now
      expect(now.goals.find(({ id }) => id === original.goal.id)?.state).toBe("abandoned")
      expect(now.activityProvenance).toEqual([{
        activityId: request.approvalJobId,
        approvalJobId: request.approvalJobId,
        goalId: original.goal.id,
        provenance: "approval"
      }])
    })))

  it.effect("replays the exact job and refuses a changed payload under the same job id", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture({ lane: false })
      const first = yield* work.abandon(request)
      expect(yield* work.abandon(request)).toEqual(first)
      expect(yield* Effect.result(work.abandon({ ...request, reason: "another reason" }))).toMatchObject({
        failure: { _tag: "WorkGoalAbandonmentConflictError", reason: "payload_mismatch" }
      })
      expect((yield* store.list()).length).toBe(2)
    })))

  it.effect("refuses a job id another durable record already uses", () =>
    Effect.scoped(Effect.gen(function*() {
      const { work } = yield* fixture({ lane: false })
      expect(yield* Effect.result(work.abandon({ ...request, approvalJobId: original.eventId }))).toMatchObject({
        failure: { _tag: "WorkGoalAbandonmentConflictError", reason: "identifier_in_use" }
      })
    })))

  it.effect("refuses a stale head and a different owner without writing", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture({ lane: false })
      expect(yield* Effect.result(work.abandon({ ...request, expectedGoalUpdatedAt: 499 }))).toMatchObject({
        failure: { _tag: "WorkGoalRevisionConflictError", actualEventId: original.eventId }
      })
      expect(
        yield* Effect.result(work.abandon({ ...request, owner: { id: "someone-else", name: "Someone else" } }))
      ).toMatchObject({ failure: { _tag: "WorkGoalOwnerMismatchError" } })
      expect((yield* store.list()).length).toBe(1)
    })))

  it.effect("refuses a goal with an active lane, naming the lane", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture({ lane: true })
      expect(yield* Effect.result(work.abandon(request))).toEqual(
        expect.objectContaining({
          failure: expect.objectContaining({
            _tag: "WorkGoalLaneActiveError",
            goalId: original.goal.id,
            laneId: laneClaim.laneId
          })
        })
      )
      expect((yield* store.list()).length).toBe(1)
    })))

  it.effect("abandons a goal whose only lane has shipped", () =>
    Effect.scoped(Effect.gen(function*() {
      const { work } = yield* fixture({ lane: true })
      yield* work.claim({ ...laneClaim, operationId: "lane-shipped", phase: "shipped", expectedRevision: 1 })
      expect((yield* work.abandon(request)).checkpoint.goal.state).toBe("abandoned")
    })))

  it.effect("refuses a goal that has already finished", () =>
    Effect.scoped(Effect.gen(function*() {
      const { work } = yield* fixture({ lane: false })
      yield* work.record({
        ...original,
        eventId: "goal-completed",
        occurredAt: 600,
        goal: { ...original.goal, state: "completed", blocker: null, updatedAt: 600 }
      })
      expect(
        yield* Effect.result(
          work.abandon({ ...request, expectedGoalEventId: "goal-completed", expectedGoalUpdatedAt: 600 })
        )
      ).toMatchObject({ failure: { _tag: "WorkGoalTerminalError", state: "completed" } })
    })))
})
