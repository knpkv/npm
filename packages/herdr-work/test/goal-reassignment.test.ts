import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeWorkService, WorkStore } from "../src/index.js"
import type { WorkGoalCheckpoint, WorkGoalReassignment, WorkLaneClaim } from "../src/model.js"

const from = { id: "agent-codex-owner", name: "Codex owner" }
const to = { id: "agent-claude-coord", name: "Claude coordinator" }
const toAgent = {
  host: "SER8",
  agentId: "agent-claude-coord",
  name: "coord",
  paneId: "w1J:p9"
}

const original = {
  version: "herdr.work.event.v1",
  eventId: "goal-created",
  occurredAt: 500,
  goal: {
    id: "fix-iphone-live-ui-polish",
    title: "Polish live UI",
    summary: "iPhone live UI polish",
    detail: "Owned by a Codex identity",
    state: "working",
    owner: from,
    repository: { repository: "example/npm", branch: "fix/ui" },
    spend: null,
    delivery: "local",
    blocker: null,
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
  owner: from,
  parent: null,
  phase: "implementation",
  expectedRevision: 0
} satisfies WorkLaneClaim

const request = {
  kind: "work.reassign",
  goalId: original.goal.id,
  from,
  to,
  toAgent,
  reason: "Codex identities retired; Claude coordinator takes over",
  expectedGoalEventId: original.eventId,
  expectedGoalUpdatedAt: original.goal.updatedAt,
  approvalJobId: "job-reassign-1",
  approvalActor: "coord",
  approvalApprovedBy: "andrey",
  approvalApprovedAt: 900,
  approvalHash: "c".repeat(64)
} satisfies WorkGoalReassignment

const fixture = Effect.fn("fixture")(
  function*(options: { readonly lane: boolean }) {
    yield* TestClock.setTime(1_000)
    const root = mkdtempSync(join(tmpdir(), "herdr-goal-reassignment-"))
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

describe("approved goal reassignment", () => {
  it.effect("moves the goal and its active lane to the new owner with attributed activity", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture({ lane: true })
      const result = yield* work.reassign(request)
      expect(result.checkpoint).toMatchObject({ eventId: request.approvalJobId, occurredAt: 1_000 })
      expect(result.checkpoint.goal.owner).toEqual(to)
      expect(result.checkpoint.goal.agentHierarchy).toEqual({ agent: toAgent })
      expect(result.checkpoint.goal.connectTarget).toMatchObject({ host: "SER8", agentId: toAgent.agentId })
      expect(result.checkpoint.goal.activity).toEqual([{
        id: request.approvalJobId,
        kind: "status",
        summary: `Reassigned from ${from.name} (${from.id}) to ${to.name} (${to.id}): ${request.reason} ` +
          `(approved Fleet job ${request.approvalJobId}, hash ${request.approvalHash})`,
        occurredAt: 1_000
      }])
      expect(result.lane).toEqual({
        ...laneClaim,
        operationId: request.approvalJobId,
        owner: to,
        expectedRevision: 1,
        revision: 2
      })
      expect(yield* store.currentClaim(laneClaim.laneId)).toMatchObject({ value: result.lane })
      expect((yield* store.list()).map(({ eventId }) => eventId)).toEqual([original.eventId, request.approvalJobId])
    })))

  it.effect("reassigns a goal without a lane and keeps its agent target when toAgent is null", () =>
    Effect.scoped(Effect.gen(function*() {
      const { work } = yield* fixture({ lane: false })
      const result = yield* work.reassign({ ...request, toAgent: null })
      expect(result.lane).toBeNull()
      expect(result.checkpoint.goal.owner).toEqual(to)
      expect(result.checkpoint.goal.connectTarget).toBeNull()
      expect(result.checkpoint.goal.agentHierarchy).toBeUndefined()
    })))

  it.effect("rejects a goal whose owner is not the approved source owner", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture({ lane: true })
      const failure = yield* Effect.flip(work.reassign({ ...request, from: { ...from, id: "agent-someone-else" } }))
      expect(failure).toMatchObject({
        _tag: "WorkGoalOwnerMismatchError",
        goalId: original.goal.id,
        laneId: null,
        expectedOwner: { ...from, id: "agent-someone-else" },
        actualOwner: from
      })
      expect(yield* store.list()).toEqual([original])
    })))

  it.effect("rejects a stale expected goal event or update time", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture({ lane: true })
      expect(yield* Effect.flip(work.reassign({ ...request, expectedGoalEventId: "older-event" }))).toMatchObject({
        _tag: "WorkGoalRevisionConflictError",
        expectedEventId: "older-event",
        actualEventId: original.eventId
      })
      expect(yield* Effect.flip(work.reassign({ ...request, expectedGoalUpdatedAt: 499 }))).toMatchObject({
        _tag: "WorkGoalRevisionConflictError",
        expectedUpdatedAt: 499,
        actualUpdatedAt: original.goal.updatedAt
      })
      expect(yield* Effect.flip(work.reassign({ ...request, goalId: "missing-goal" }))).toMatchObject({
        _tag: "WorkGoalRevisionConflictError",
        actualEventId: null,
        actualUpdatedAt: null
      })
      expect(yield* store.list()).toEqual([original])
    })))

  it.effect("rejects an active lane owned by someone other than the goal owner", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture({ lane: false })
      const foreign = { id: "agent-lane-owner", name: "Lane owner" }
      const lane = yield* work.claim({ ...laneClaim, owner: foreign })
      expect(yield* Effect.flip(work.reassign(request))).toMatchObject({
        _tag: "WorkGoalOwnerMismatchError",
        laneId: laneClaim.laneId,
        expectedOwner: from,
        actualOwner: foreign
      })
      expect(yield* store.list()).toEqual([original])
      expect(yield* store.currentClaim(laneClaim.laneId)).toMatchObject({ value: lane })
    })))

  it.effect("returns the prior result for an identical replay after the goal head moved", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture({ lane: true })
      const first = yield* work.reassign(request)
      yield* TestClock.adjust(5_000)
      expect(yield* work.reassign(request)).toEqual(first)
      expect(yield* store.list()).toHaveLength(2)
    })))

  it.effect("rejects a different payload replayed under the same approval job", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture({ lane: true })
      yield* work.reassign(request)
      expect(yield* Effect.flip(work.reassign({ ...request, reason: "different reason" }))).toMatchObject({
        _tag: "WorkGoalReassignmentConflictError",
        approvalJobId: request.approvalJobId,
        reason: "payload_mismatch"
      })
      expect(yield* store.list()).toHaveLength(2)
    })))

  it.effect("rejects an approval job id already used by another durable record", () =>
    Effect.scoped(Effect.gen(function*() {
      const { work } = yield* fixture({ lane: true })
      expect(yield* Effect.flip(work.reassign({ ...request, approvalJobId: laneClaim.operationId }))).toMatchObject({
        _tag: "WorkGoalReassignmentConflictError",
        reason: "identifier_in_use"
      })
      expect(yield* Effect.flip(work.reassign({ ...request, approvalJobId: original.eventId }))).toMatchObject({
        _tag: "WorkGoalReassignmentConflictError",
        reason: "identifier_in_use"
      })
    })))
})
