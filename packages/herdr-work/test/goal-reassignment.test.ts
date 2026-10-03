import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { agentConnectTarget } from "@knpkv/herdr-fleet/model"
import { Effect, Option } from "effect"
import { TestClock } from "effect/testing"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { makeWorkService, type WorkService, WorkStore } from "../src/index.js"
import type {
  WorkExistingGoalRecovery,
  WorkGoalCheckpoint,
  WorkGoalReassignment,
  WorkLaneClaim,
  WorkRecoveryTarget
} from "../src/model.js"
import { __herdrWorkLaneOperationMaxBytesForTest } from "../src/store.js"

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
  toAgent: { _tag: "set", agent: toAgent },
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
    return { path: join(root, "work.sqlite"), store, work }
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
      expect(result.binding).toBeNull()
    })))

  it.effect("records the rewritten lane in the operation ledger at the new revision", () =>
    Effect.scoped(Effect.gen(function*() {
      const { path, work } = yield* fixture({ lane: true })
      const result = yield* work.reassign(request)
      const sql = new DatabaseSync(path)
      yield* Effect.addFinalizer(() => Effect.sync(() => sql.close()))
      const row = sql.prepare("SELECT revision, record FROM work_lane_operations WHERE operation_id = ?")
        .get(request.approvalJobId)
      expect(row?.revision).toBe(2)
      expect(JSON.parse(String(row?.record))).toEqual(result.lane)
    })))

  it.effect("orders the new checkpoint after a head written ahead of the local clock", () =>
    Effect.scoped(Effect.gen(function*() {
      const { work } = yield* fixture({ lane: false })
      const ahead = {
        ...original,
        eventId: "goal-ahead",
        occurredAt: 5_000,
        goal: { ...original.goal, updatedAt: 5_000 }
      }
      yield* work.record(ahead)
      const result = yield* work.reassign({
        ...request,
        toAgent: { _tag: "keep" },
        expectedGoalEventId: ahead.eventId,
        expectedGoalUpdatedAt: 5_000
      })
      expect(result.checkpoint.occurredAt).toBe(5_001)
      expect(yield* work.recoveryContext(original.goal.id)).toMatchObject({
        expectedGoalEventId: request.approvalJobId
      })
    })))

  it.effect("reassigns a goal without a lane or agent target when asked to keep the absent target", () =>
    Effect.scoped(Effect.gen(function*() {
      const { work } = yield* fixture({ lane: false })
      const result = yield* work.reassign({ ...request, toAgent: { _tag: "keep" } })
      expect(result.lane).toBeNull()
      expect(result.checkpoint.goal.owner).toEqual(to)
      expect(result.checkpoint.goal.connectTarget).toBeNull()
      expect(result.checkpoint.goal.agentHierarchy).toBeUndefined()
    })))

  const targeted = Effect.fn("targeted")(function*(work: WorkService) {
    const oldAgent = { host: "SER8", agentId: "agent-codex-owner", name: "codex", paneId: "w1:p2" }
    const head = {
      ...original,
      eventId: "goal-targeted",
      occurredAt: 600,
      goal: {
        ...original.goal,
        agentHierarchy: { agent: oldAgent },
        connectTarget: agentConnectTarget(oldAgent),
        updatedAt: 600
      }
    } satisfies WorkGoalCheckpoint
    yield* work.record(head)
    return { ...request, expectedGoalEventId: head.eventId, expectedGoalUpdatedAt: 600 } satisfies WorkGoalReassignment
  })

  it.effect("refuses to keep an existing agent target that belongs to the previous owner", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture({ lane: false })
      const expected = yield* targeted(work)
      expect(yield* Effect.flip(work.reassign({ ...expected, toAgent: { _tag: "keep" } }))).toMatchObject({
        _tag: "WorkGoalAgentTargetConflictError",
        goalId: original.goal.id,
        agentId: "agent-codex-owner",
        reason: "keep_existing_target",
        holderId: original.goal.id
      })
      expect(yield* store.list()).toHaveLength(2)
    })))

  it.effect("clears an existing agent target on request", () =>
    Effect.scoped(Effect.gen(function*() {
      const { work } = yield* fixture({ lane: false })
      const expected = yield* targeted(work)
      const result = yield* work.reassign({ ...expected, toAgent: { _tag: "clear" } })
      expect(result.checkpoint.goal.agentHierarchy).toBeNull()
      expect(result.checkpoint.goal.connectTarget).toBeNull()
    })))

  it.effect("reassigns a deployed goal and leaves its shipped lane with the previous owner", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture({ lane: true })
      yield* work.claim({ ...laneClaim, operationId: "lane-shipped", phase: "shipped", expectedRevision: 1 })
      const deployed = {
        ...original,
        eventId: "goal-deployed",
        occurredAt: 700,
        goal: { ...original.goal, state: "deployed", delivery: "deployed", updatedAt: 700 }
      } satisfies WorkGoalCheckpoint
      yield* work.record(deployed)
      const result = yield* work.reassign({
        ...request,
        expectedGoalEventId: deployed.eventId,
        expectedGoalUpdatedAt: 700
      })
      expect(result.checkpoint.goal).toMatchObject({ state: "deployed", owner: to })
      expect(result.lane).toBeNull()
      expect(yield* store.currentClaim(laneClaim.laneId)).toMatchObject({
        value: { owner: from, phase: "shipped", revision: 2 }
      })
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

  const recoveryTarget = {
    repository: "example/npm",
    pullRequest: 433,
    reviewUrl: "https://github.com/example/npm/pull/433",
    goalId: "npm-pr433-release",
    laneId: "npm-pr433-lane",
    head: "a".repeat(40),
    baseHead: "b".repeat(40),
    owner: from,
    sessionId: "01a0ae54-197e-72b2-914f-8d5d22abe522",
    expectedWork: "work:pr433",
    worker: { host: "SER8", agentId: "agent-codex-pr433", name: "codex pr433", paneId: "w1:p4" },
    worktree: "/tmp/pr433",
    branch: "feat/pr433",
    expectedGoalEventId: "pr433-created",
    expectedGoalUpdatedAt: 500
  } satisfies WorkRecoveryTarget

  const bound = Effect.fn("bound")(function*(work: WorkService) {
    yield* work.record({
      version: "herdr.work.event.v1",
      eventId: recoveryTarget.expectedGoalEventId,
      occurredAt: 500,
      goal: {
        ...original.goal,
        id: recoveryTarget.goalId,
        state: "review",
        delivery: "pull_request",
        repository: { repository: recoveryTarget.repository, branch: recoveryTarget.branch },
        goalFamily: { canonicalGoalId: recoveryTarget.goalId, role: "canonical" },
        review: null
      }
    })
    const preflight = yield* work.recoveryPreflight(recoveryTarget)
    if (preflight._tag !== "recoverable") return yield* Effect.die(preflight)
    const recovery: WorkExistingGoalRecovery = {
      ...recoveryTarget,
      kind: "work.recover",
      operationId: "pr433-recovery",
      expectedHistoryToken: preflight.historyToken,
      approvalJobId: "job-recover-433",
      approvalActor: "coord",
      approvalApprovedBy: "andrey",
      approvalApprovedAt: 800,
      approvalHash: "d".repeat(64)
    }
    const link = yield* work.recoverExistingGoal(recovery)
    return {
      ...request,
      goalId: recoveryTarget.goalId,
      expectedGoalEventId: link.goalEventId,
      expectedGoalUpdatedAt: link.goal.updatedAt
    } satisfies WorkGoalReassignment
  })

  it.effect("rebinds a bound lane to the new worker so PR inspection succeeds for it", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture({ lane: false })
      const expected = yield* bound(work)
      const result = yield* work.reassign(expected)
      expect(result.binding?.request).toMatchObject({
        dispatchRequestId: request.approvalJobId,
        worker: toAgent,
        ownerReassignment: {
          previousDispatchRequestId: "pr433-recovery",
          approvalJobId: request.approvalJobId,
          approvalHash: request.approvalHash
        }
      })
      const link = yield* work.inspectPullRequest({
        repository: recoveryTarget.repository,
        pullRequest: recoveryTarget.pullRequest,
        goalId: recoveryTarget.goalId,
        laneId: recoveryTarget.laneId
      })
      expect(link.binding.request.worker).toEqual(toAgent)
      expect(link.lane.owner).toEqual(to)
      expect(link.goal.owner).toEqual(to)
      expect(yield* store.agentBinding(request.approvalJobId)).toEqual(Option.some(result.binding))
      expect(yield* work.reassign(expected)).toEqual(result)
    })))

  const unboundChoices: ReadonlyArray<WorkGoalReassignment["toAgent"]> = [{ _tag: "clear" }, { _tag: "keep" }]
  for (const toAgentChoice of unboundChoices) {
    it.effect(`refuses to ${toAgentChoice._tag} the agent of a bound lane`, () =>
      Effect.scoped(Effect.gen(function*() {
        const { store, work } = yield* fixture({ lane: false })
        const expected = yield* bound(work)
        const before = yield* store.list()
        expect(yield* Effect.flip(work.reassign({ ...expected, toAgent: toAgentChoice }))).toMatchObject({
          _tag: "WorkGoalBindingRequiresAgentError",
          goalId: recoveryTarget.goalId,
          laneId: recoveryTarget.laneId,
          dispatchRequestId: "pr433-recovery"
        })
        expect(yield* store.list()).toEqual(before)
      })))
  }

  it.effect("treats the rebound binding as the lane's authority in admission preflight", () =>
    Effect.scoped(Effect.gen(function*() {
      const { work } = yield* fixture({ lane: false })
      const result = yield* work.reassign(yield* bound(work))
      const preflight = yield* work.admissionPreflight({
        repository: recoveryTarget.repository,
        pullRequest: recoveryTarget.pullRequest,
        reviewUrl: recoveryTarget.reviewUrl,
        goalId: recoveryTarget.goalId,
        laneId: recoveryTarget.laneId,
        head: recoveryTarget.head,
        baseHead: recoveryTarget.baseHead,
        owner: to,
        sessionId: recoveryTarget.sessionId,
        expectedWork: recoveryTarget.expectedWork,
        worker: toAgent,
        worktree: recoveryTarget.worktree,
        branch: recoveryTarget.branch
      })
      expect(preflight._tag).toBe("existing")
      if (preflight._tag !== "existing") return
      expect(preflight.link.binding).toEqual(result.binding)
    })))

  it.effect("rejects an owner whose id matches but whose name differs", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture({ lane: true })
      const renamed = { ...from, name: "Renamed owner" }
      expect(yield* Effect.flip(work.reassign({ ...request, from: renamed }))).toMatchObject({
        _tag: "WorkGoalOwnerMismatchError",
        laneId: null,
        expectedOwner: renamed,
        actualOwner: from
      })
      expect(yield* store.list()).toEqual([original])
    })))

  it.effect("rolls back every earlier write when the final reassignment insert fails", () =>
    Effect.scoped(Effect.gen(function*() {
      const { path, store, work } = yield* fixture({ lane: false })
      const expected = yield* bound(work)
      const before = yield* store.list()
      const lane = yield* store.currentClaim(recoveryTarget.laneId)
      const sql = new DatabaseSync(path)
      yield* Effect.addFinalizer(() => Effect.sync(() => sql.close()))
      sql.exec(`CREATE TRIGGER fail_reassignment BEFORE INSERT ON work_goal_reassignments
        BEGIN SELECT RAISE(ABORT, 'synthetic reassignment failure'); END`)
      expect(yield* Effect.flip(work.reassign(expected))).toMatchObject({
        _tag: "WorkStoreError",
        operation: "reassign.transaction"
      })
      expect(yield* store.list()).toEqual(before)
      expect(yield* store.currentClaim(recoveryTarget.laneId)).toEqual(lane)
      expect(yield* store.agentBinding(request.approvalJobId)).toEqual(Option.none())
      expect(sql.prepare("SELECT 1 FROM work_lane_operations WHERE operation_id = ?").get(request.approvalJobId))
        .toBeUndefined()
      sql.exec("DROP TRIGGER fail_reassignment")
      expect((yield* work.reassign(expected)).binding?.request.dispatchRequestId).toBe(request.approvalJobId)
    })))

  it.effect("rejects a lane rewrite once the lane operation ledger is at its byte cap", () =>
    Effect.scoped(Effect.gen(function*() {
      const { path, store, work } = yield* fixture({ lane: true })
      const sql = new DatabaseSync(path)
      yield* Effect.addFinalizer(() => Effect.sync(() => sql.close()))
      sql.prepare("UPDATE work_lane_operation_totals SET operation_bytes = ? WHERE singleton = 1")
        .run(__herdrWorkLaneOperationMaxBytesForTest)
      expect(yield* Effect.flip(work.reassign(request))).toMatchObject({
        _tag: "WorkProjectionError",
        reason: "capacity_exceeded"
      })
      expect(yield* store.list()).toEqual([original])
      expect(yield* store.currentClaim(laneClaim.laneId)).toMatchObject({ value: { owner: from, revision: 1 } })
    })))

  it.effect("keeps a superseded binding's session id in the new-admission conflict scan", () =>
    Effect.scoped(Effect.gen(function*() {
      const { work } = yield* fixture({ lane: false })
      yield* work.reassign(yield* bound(work))
      const preflight = yield* work.admissionPreflight({
        repository: recoveryTarget.repository,
        pullRequest: 500,
        reviewUrl: "https://github.com/example/npm/pull/500",
        goalId: "npm-pr500-release",
        laneId: "npm-pr500-lane",
        head: "c".repeat(40),
        baseHead: recoveryTarget.baseHead,
        owner: { id: "agent-other-owner", name: "Other owner" },
        sessionId: recoveryTarget.sessionId,
        expectedWork: "work:pr500",
        worker: { host: "SER8", agentId: "agent-pr500", name: "pr500", paneId: "w1:p6" },
        worktree: "/tmp/pr500",
        branch: "feat/pr500"
      })
      expect(preflight._tag).toBe("conflict")
    })))

  it.effect("refuses to set an agent that another goal currently targets, writing nothing", () =>
    Effect.scoped(Effect.gen(function*() {
      const { path, store, work } = yield* fixture({ lane: true })
      const other = {
        ...original,
        eventId: "goal-a-created",
        goal: {
          ...original.goal,
          id: "goal-a",
          owner: { id: "agent-goal-a-owner", name: "Goal A owner" },
          agentHierarchy: { agent: toAgent },
          connectTarget: agentConnectTarget(toAgent)
        }
      } satisfies WorkGoalCheckpoint
      yield* work.record(other)
      const before = yield* store.list()
      expect(yield* Effect.flip(work.reassign(request))).toMatchObject({
        _tag: "WorkGoalAgentTargetConflictError",
        goalId: original.goal.id,
        agentId: toAgent.agentId,
        reason: "held_by_other_goal",
        holderId: "goal-a"
      })
      expect(yield* store.list()).toEqual(before)
      expect(yield* store.currentClaim(laneClaim.laneId)).toMatchObject({ value: { owner: from, revision: 1 } })
      const sql = new DatabaseSync(path)
      yield* Effect.addFinalizer(() => Effect.sync(() => sql.close()))
      expect(sql.prepare("SELECT COUNT(*) AS count FROM work_goal_reassignments").get()).toEqual({ count: 0 })
    })))

  it.effect("refuses to set an agent that another lane's authoritative binding holds", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture({ lane: false })
      const bindingHolder = yield* bound(work)
      const link = yield* work.inspectPullRequest({
        repository: recoveryTarget.repository,
        pullRequest: recoveryTarget.pullRequest,
        goalId: recoveryTarget.goalId,
        laneId: recoveryTarget.laneId
      })
      // The holder goal's own target moves away, while its lane binding still holds the worker.
      yield* work.record({
        version: "herdr.work.event.v1",
        eventId: "pr433-untargeted",
        occurredAt: link.goal.updatedAt + 1,
        goal: { ...link.goal, agentHierarchy: null, connectTarget: null, updatedAt: link.goal.updatedAt + 1 }
      })
      const before = yield* store.list()
      expect(
        yield* Effect.flip(work.reassign({
          ...request,
          toAgent: { _tag: "set", agent: recoveryTarget.worker }
        }))
      ).toMatchObject({
        _tag: "WorkGoalAgentTargetConflictError",
        goalId: original.goal.id,
        agentId: recoveryTarget.worker.agentId,
        reason: "held_by_other_lane",
        holderId: recoveryTarget.laneId
      })
      expect(yield* store.list()).toEqual(before)
      expect(bindingHolder.goalId).toBe(recoveryTarget.goalId)
    })))
})
