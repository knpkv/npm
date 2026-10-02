import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { makeWorkService, WorkStore } from "../src/index.js"
import type { WorkExistingGoalRecovery, WorkGoalCheckpoint, WorkLaneClaim, WorkRecoveryTarget } from "../src/model.js"

const target = {
  repository: "example/npm",
  pullRequest: 376,
  reviewUrl: "https://github.com/example/npm/pull/376",
  goalId: "jcf-ai-review-85170486",
  laneId: "jcf-pr376-release",
  head: "a".repeat(40),
  baseHead: "b".repeat(40),
  owner: { id: "original-owner", name: "Original JCF owner" },
  sessionId: "01a0ae54-197e-72b2-914f-8d5d22abe522",
  expectedWork: "work:85170486-375a-4dab-91c4-b5f39c974156",
  worker: {
    host: "TEST-HOST",
    agentId: "agent-original-jcf",
    name: "Original JCF owner",
    paneId: "w1K:p1",
    relationship: { parentAgentId: "agent-parent", relation: "delegated" }
  },
  worktree: "/tmp/jcf-owner/feat/pr376",
  branch: "feat/pr376",
  expectedGoalEventId: "original-jcf-event",
  expectedGoalUpdatedAt: 500
} satisfies WorkRecoveryTarget

const fixtureForRepository = Effect.fn("fixtureForRepository")(
  function*(repository: string, branch: string) {
    yield* TestClock.setTime(1_000)
    const root = mkdtempSync(join(tmpdir(), "herdr-existing-goal-recovery-"))
    yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { recursive: true, force: true })))
    const path = join(root, "work.sqlite")
    const store = yield* Effect.acquireRelease(WorkStore.open(path), (opened) => Effect.sync(() => opened.close()))
    const work = yield* makeWorkService(store)
    const original = {
      version: "herdr.work.event.v1",
      eventId: target.expectedGoalEventId,
      occurredAt: target.expectedGoalUpdatedAt,
      goal: {
        id: target.goalId,
        title: "Review PR376",
        summary: "Existing JCF review goal",
        detail: "Retained original goal",
        state: "blocked",
        owner: target.owner,
        repository: { repository, branch },
        spend: null,
        delivery: "pull_request",
        blocker: { summary: "Awaiting supported linkage", since: 500 },
        connectTarget: null,
        goalFamily: {
          canonicalGoalId: target.goalId,
          role: "canonical"
        },
        review: null,
        createdAt: 500,
        updatedAt: 500
      }
    } satisfies WorkGoalCheckpoint
    yield* work.record(original)
    return { original, path, store, work }
  },
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.provide(NodeServices.layer)
)

const fixture = fixtureForRepository(target.repository, target.branch)

const unrelatedClaim = {
  operationId: "unrelated-first",
  goalId: "unrelated-goal",
  laneId: "unrelated-lane",
  worktree: "/tmp/unrelated-worktree",
  branch: "feat/unrelated",
  head: "d".repeat(40),
  owner: { id: "unrelated-owner", name: "Unrelated owner" },
  parent: null,
  phase: "claim",
  expectedRevision: 0
} satisfies WorkLaneClaim

describe("existing canonical goal recovery", () => {
  it.effect("recovers exact legacy worktree history without rewriting its original checkpoint", () =>
    Effect.scoped(Effect.gen(function*() {
      const { original, store, work } = yield* fixtureForRepository(target.worktree, target.branch)
      const preflight = yield* work.recoveryPreflight(target)
      expect(preflight._tag).toBe("recoverable")
      if (preflight._tag !== "recoverable") return
      const request: WorkExistingGoalRecovery = {
        ...target,
        kind: "work.recover",
        operationId: "legacy-approved-operation",
        expectedHistoryToken: preflight.historyToken,
        approvalJobId: "legacy-approved-job",
        approvalActor: "requester",
        approvalApprovedBy: "approver",
        approvalApprovedAt: 2_000,
        approvalHash: "c".repeat(64)
      }
      const link = yield* work.recoverExistingGoal(request)
      expect(link.goal.repository.repository).toBe(target.repository)
      expect(yield* work.recoverExistingGoal(request)).toEqual(link)
      expect((yield* store.list())[0]).toEqual(original)
    })))

  const invalidLegacyRepositories: ReadonlyArray<readonly [string, string]> = [
    ["/tmp/other/feat/pr376", target.branch],
    [target.worktree, "feat/other"],
    [target.worktree + "/../pr376", target.branch]
  ]
  for (const [repository, branch] of invalidLegacyRepositories) {
    it.effect(`rejects a nonmatching legacy representation ${repository} ${branch}`, () =>
      Effect.scoped(Effect.gen(function*() {
        const { original, store, work } = yield* fixtureForRepository(repository, branch)
        expect((yield* work.recoveryPreflight(target))._tag).toBe("conflict")
        expect(yield* store.list()).toEqual([original])
      })))
  }

  it.effect("selects the latest durable event outside historical projection windows and rejects stale preflight", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const { original, work } = yield* fixture
        const latest = {
          ...original,
          eventId: "newer-jcf-event",
          occurredAt: 900,
          goal: { ...original.goal, updatedAt: 900 }
        }
        yield* work.record(latest)
        const snapshot = yield* work.snapshots(500)
        expect(snapshot.now.goals[0]?.updatedAt).toBe(500)
        const context = yield* work.recoveryContext(target.goalId)
        expect(context).toEqual({
          goalId: target.goalId,
          expectedGoalEventId: latest.eventId,
          expectedGoalUpdatedAt: latest.goal.updatedAt
        })
        expect((yield* work.recoveryPreflight(target))._tag).toBe("conflict")
        expect((yield* work.recoveryPreflight({ ...target, ...context }))._tag).toBe("recoverable")
        yield* work.claim({ ...unrelatedClaim, worktree: target.worktree })
        expect((yield* work.recoveryPreflight({ ...target, ...context }))._tag).toBe("conflict")
      })
    ))

  it.effect("accepts equal timestamps for different goals but rejects missing and invalid IDs", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const { original, work } = yield* fixture
        yield* work.record({
          ...original,
          eventId: "other-goal-event",
          goal: {
            ...original.goal,
            id: "other-goal",
            goalFamily: { canonicalGoalId: "other-goal", role: "canonical" }
          }
        })
        expect((yield* work.recoveryContext(target.goalId)).expectedGoalEventId).toBe(original.eventId)
        expect(yield* Effect.result(work.recoveryContext("missing-goal"))).toMatchObject({
          failure: {
            _tag: "WorkRecoveryContextError",
            reason: "missing_goal"
          }
        })
        expect(yield* Effect.result(work.recoveryContext(""))).toMatchObject({
          failure: {
            _tag: "WorkRecoveryContextError",
            reason: "invalid_goal_id"
          }
        })
      })
    ))

  it.effect("rejects ambiguous and corrupt durable context instead of inventing an event", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const { original, path, work } = yield* fixture
        const sql = new DatabaseSync(path)
        yield* Effect.addFinalizer(() => Effect.sync(() => sql.close()))
        expect(yield* Effect.result(work.record({ ...original, eventId: "same-time-event" }))).toMatchObject({
          failure: { _tag: "WorkCheckpointConflictError" }
        })
        sql.prepare("UPDATE work_goal_events SET record = ? WHERE event_id = ?").run("{invalid-json", original.eventId)
        expect(yield* Effect.result(work.recoveryContext(target.goalId))).toMatchObject({
          failure: { _tag: "WorkStoreError" }
        })
      })
    ))

  it.effect("reads exact recovery context from durable history without changing any table", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const { original, path, work } = yield* fixture
        const sql = new DatabaseSync(path)
        yield* Effect.addFinalizer(() => Effect.sync(() => sql.close()))
        const tables = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ name: Schema.String })))(
          sql.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all()
        )
        const before = tables.map(({ name }) =>
          sql.prepare(`SELECT * FROM ${JSON.stringify(name)} ORDER BY rowid`).all()
        )
        const context = yield* work.recoveryContext(target.goalId)
        expect(context).toEqual({
          goalId: target.goalId,
          expectedGoalEventId: original.eventId,
          expectedGoalUpdatedAt: original.goal.updatedAt
        })
        expect(
          tables.map(({ name }) => sql.prepare(`SELECT * FROM ${JSON.stringify(name)} ORDER BY rowid`).all())
        ).toEqual(before)
      })
    ))

  it.effect("rejects an old worktree claim even when the latest unrelated lane moved away", () =>
    Effect.scoped(Effect.gen(function*() {
      const { original, store, work } = yield* fixture
      yield* work.claim({ ...unrelatedClaim, worktree: target.worktree })
      yield* work.claim({
        ...unrelatedClaim,
        operationId: "unrelated-second",
        expectedRevision: 1,
        worktree: unrelatedClaim.worktree
      })
      expect((yield* work.recoveryPreflight(target))._tag).toBe("conflict")
      expect(yield* store.list()).toEqual([original])
    })))

  it.effect("rejects a malformed historical lane operation without changing the goal", () =>
    Effect.scoped(Effect.gen(function*() {
      const { original, path, store, work } = yield* fixture
      const sql = new DatabaseSync(path)
      sql.prepare(`INSERT INTO work_lane_operations
        (operation_id, lane_id, goal_id, phase, revision, record) VALUES (?, ?, ?, ?, ?, ?)`).run(
        "malformed-operation",
        "foreign-lane",
        "foreign-goal",
        "claim",
        1,
        "{invalid-json"
      )
      sql.close()
      expect(yield* Effect.result(work.recoveryPreflight(target))).toMatchObject({
        failure: { _tag: "WorkStoreError" }
      })
      expect(yield* store.list()).toEqual([original])
    })))

  it.effect("rejects a foreign worktree operation with no durable lane companion", () =>
    Effect.scoped(Effect.gen(function*() {
      const { original, path, store, work } = yield* fixture
      const claim = { ...unrelatedClaim, worktree: target.worktree, revision: 1 }
      const sql = new DatabaseSync(path)
      sql.prepare(`INSERT INTO work_lane_operations
        (operation_id, lane_id, goal_id, phase, revision, record) VALUES (?, ?, ?, ?, ?, ?)`).run(
        claim.operationId,
        claim.laneId,
        claim.goalId,
        claim.phase,
        claim.revision,
        JSON.stringify(claim)
      )
      sql.close()
      expect(yield* Effect.result(work.recoveryPreflight(target))).toMatchObject({
        failure: { _tag: "WorkStoreError" }
      })
      expect(yield* store.list()).toEqual([original])
    })))

  it.effect("rejects an operation whose indexed identity disagrees with its record", () =>
    Effect.scoped(Effect.gen(function*() {
      const { original, path, store, work } = yield* fixture
      const sql = new DatabaseSync(path)
      sql.prepare(`INSERT INTO work_lane_operations
        (operation_id, lane_id, goal_id, phase, revision, record) VALUES (?, ?, ?, ?, ?, ?)`).run(
        "indexed-operation",
        unrelatedClaim.laneId,
        unrelatedClaim.goalId,
        "claim",
        1,
        JSON.stringify({ ...unrelatedClaim, operationId: "record-operation", revision: 1 })
      )
      sql.close()
      expect(yield* Effect.result(work.recoveryPreflight(target))).toMatchObject({
        failure: { _tag: "WorkStoreError" }
      })
      expect(yield* store.list()).toEqual([original])
    })))

  it.effect("allows valid unrelated lane history beside the unlinked goal", () =>
    Effect.scoped(Effect.gen(function*() {
      const { original, store, work } = yield* fixture
      yield* work.claim({ ...unrelatedClaim, owner: target.owner })
      expect((yield* work.recoveryPreflight(target))._tag).toBe("recoverable")
      expect(yield* store.list()).toEqual([original])
    })))

  it.effect("rejects malformed operation authority after preflight without a recovery write", () =>
    Effect.scoped(Effect.gen(function*() {
      const { original, path, store, work } = yield* fixture
      const preflight = yield* work.recoveryPreflight(target)
      expect(preflight._tag).toBe("recoverable")
      if (preflight._tag !== "recoverable") return
      const sql = new DatabaseSync(path)
      sql.prepare(`INSERT INTO work_lane_operations
        (operation_id, lane_id, goal_id, phase, revision, record) VALUES (?, ?, ?, ?, ?, ?)`).run(
        "late-malformed-operation",
        "foreign-lane",
        "foreign-goal",
        "claim",
        1,
        "{invalid-json"
      )
      sql.close()
      expect(
        yield* Effect.result(work.recoverExistingGoal({
          ...target,
          kind: "work.recover",
          operationId: "approved-recovery-operation",
          expectedHistoryToken: preflight.historyToken,
          approvalJobId: "approved-recovery-job",
          approvalActor: "requester",
          approvalApprovedBy: "approver",
          approvalApprovedAt: 2_000,
          approvalHash: "c".repeat(64)
        }))
      ).toMatchObject({ failure: { _tag: "WorkStoreError" } })
      expect(yield* store.list()).toEqual([original])
    })))

  it.effect("does not replay a linked recovery through newly corrupt operation history", () =>
    Effect.scoped(Effect.gen(function*() {
      const { path, store, work } = yield* fixture
      const preflight = yield* work.recoveryPreflight(target)
      expect(preflight._tag).toBe("recoverable")
      if (preflight._tag !== "recoverable") return
      const request = {
        ...target,
        kind: "work.recover",
        operationId: "approved-recovery-operation",
        expectedHistoryToken: preflight.historyToken,
        approvalJobId: "approved-recovery-job",
        approvalActor: "requester",
        approvalApprovedBy: "approver",
        approvalApprovedAt: 2_000,
        approvalHash: "c".repeat(64)
      } satisfies WorkExistingGoalRecovery
      yield* work.recoverExistingGoal(request)
      const sql = new DatabaseSync(path)
      sql.prepare(`INSERT INTO work_lane_operations
        (operation_id, lane_id, goal_id, phase, revision, record) VALUES (?, ?, ?, ?, ?, ?)`).run(
        "later-malformed-operation",
        "foreign-lane",
        "foreign-goal",
        "claim",
        1,
        "{invalid-json"
      )
      sql.close()
      expect(yield* Effect.result(work.recoverExistingGoal(request))).toMatchObject({
        failure: { _tag: "WorkStoreError" }
      })
      expect((yield* store.list()).length).toBe(2)
    })))

  it.effect("links the original blocked goal and replays only the exact approved operation", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const { original, store, work } = yield* fixture
        const preflight = yield* work.recoveryPreflight(target)
        expect(preflight._tag).toBe("recoverable")
        if (preflight._tag !== "recoverable") return
        expect(yield* store.list()).toEqual([original])
        const request = {
          ...target,
          kind: "work.recover",
          operationId: "jcf-recovery-operation",
          expectedHistoryToken: preflight.historyToken,
          approvalJobId: "approved-recovery-job",
          approvalActor: "reviewer@example.com",
          approvalApprovedBy: "approver@example.com",
          approvalApprovedAt: 2_000,
          approvalHash: "c".repeat(64)
        } satisfies WorkExistingGoalRecovery
        const link = yield* work.recoverExistingGoal(request)
        expect(link.goal.id).toBe(original.goal.id)
        expect(link.goal.state).toBe("blocked")
        expect(link.goal.blocker).toEqual(original.goal.blocker)
        expect(link.goal.review?.url).toBe(target.reviewUrl)
        expect(link.binding.request.existingGoalRecovery?.approvalJobId).toBe(request.approvalJobId)
        expect(yield* work.recoverExistingGoal(request)).toEqual(link)
        for (
          const changed of [
            { approvalActor: "different-approver" },
            { approvalApprovedBy: "different-approver" },
            { approvalApprovedAt: 2_001 },
            { approvalHash: "d".repeat(64) },
            { approvalJobId: "other-approved-job" },
            { operationId: "other-operation" },
            { head: "d".repeat(40) }
          ]
        ) {
          expect(yield* Effect.result(work.recoverExistingGoal({ ...request, ...changed }))).toMatchObject({
            failure: { _tag: "WorkAdmissionConflictError" }
          })
        }
        expect((yield* store.list()).length).toBe(2)
        expect(
          yield* work.inspectPullRequest({
            repository: target.repository,
            pullRequest: target.pullRequest,
            goalId: target.goalId,
            laneId: target.laneId
          })
        ).toEqual(link)
      })
    ))

  it.effect("rejects stale history and changed approved identity without altering the original", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const { original, store, work } = yield* fixture
        const preflight = yield* work.recoveryPreflight(target)
        expect(preflight._tag).toBe("recoverable")
        if (preflight._tag !== "recoverable") return
        const request = {
          ...target,
          kind: "work.recover",
          operationId: "jcf-recovery-operation",
          expectedHistoryToken: preflight.historyToken,
          approvalJobId: "approved-recovery-job",
          approvalActor: "reviewer@example.com",
          approvalApprovedBy: "approver@example.com",
          approvalApprovedAt: 2_000,
          approvalHash: "c".repeat(64)
        } satisfies WorkExistingGoalRecovery
        for (
          const changed of [
            { head: "c".repeat(40) },
            { baseHead: "d".repeat(40) },
            { repository: "other/npm", reviewUrl: "https://github.com/other/npm/pull/376" },
            { laneId: "other-recovery-lane" },
            { worktree: "/other/worktree" },
            { branch: "other-branch" },
            { sessionId: "00000000-0000-0000-0000-000000000000" },
            { owner: { id: "foreign-owner", name: "Foreign owner" } },
            { worker: { ...target.worker, agentId: "agent-foreign" } },
            { expectedGoalEventId: "stale-event" },
            { expectedGoalUpdatedAt: 499 }
          ]
        ) {
          const result = yield* Effect.result(work.recoverExistingGoal({ ...request, ...changed }))
          expect(result, JSON.stringify(changed)).toMatchObject({
            failure: { _tag: "WorkAdmissionConflictError" }
          })
        }
        expect(yield* store.list()).toEqual([original])
        yield* work.record({
          ...original,
          eventId: "unrelated-goal-event",
          occurredAt: 501,
          goal: {
            ...original.goal,
            id: "unrelated-goal",
            goalFamily: {
              canonicalGoalId: "unrelated-goal",
              role: "canonical"
            },
            blocker: { summary: "Awaiting supported linkage", since: 501 },
            createdAt: 501,
            updatedAt: 501
          }
        })
        expect(yield* Effect.result(work.recoverExistingGoal(request))).toMatchObject({
          failure: { _tag: "WorkAdmissionConflictError" }
        })
        expect((yield* store.list()).length).toBe(2)
      })
    ))

  it.effect("rolls back the checkpoint and lane when binding insertion fails", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const { original, path, store, work } = yield* fixture
        const preflight = yield* work.recoveryPreflight(target)
        expect(preflight._tag).toBe("recoverable")
        if (preflight._tag !== "recoverable") return
        const sql = new DatabaseSync(path)
        sql.exec(`CREATE TRIGGER fail_recovery_binding BEFORE INSERT ON work_agent_bindings
        BEGIN SELECT RAISE(ABORT, 'synthetic binding failure'); END`)
        sql.close()
        const result = yield* Effect.result(
          work.recoverExistingGoal({
            ...target,
            kind: "work.recover",
            operationId: "jcf-recovery-operation",
            expectedHistoryToken: preflight.historyToken,
            approvalJobId: "approved-recovery-job",
            approvalActor: "reviewer@example.com",
            approvalApprovedBy: "approver@example.com",
            approvalApprovedAt: 2_000,
            approvalHash: "c".repeat(64)
          })
        )
        expect(result).toMatchObject({ failure: { _tag: "WorkStoreError" } })
        expect(yield* store.list()).toEqual([original])
        expect((yield* work.recoveryPreflight(target))._tag).toBe("recoverable")
      })
    ))

  it.effect("rejects terminal and foreign historical PR authority without a new binding", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const { original, store, work } = yield* fixture
        yield* work.record({
          ...original,
          eventId: "jcf-completed-event",
          occurredAt: 501,
          goal: {
            ...original.goal,
            state: "completed",
            blocker: null,
            updatedAt: 501
          }
        })
        expect(
          (yield* work.recoveryPreflight({
            ...target,
            expectedGoalEventId: "jcf-completed-event",
            expectedGoalUpdatedAt: 501
          }))._tag
        ).toBe("conflict")
        expect((yield* store.list()).length).toBe(2)
      })
    ))

  it.effect("rejects an old foreign PR claim even when the canonical goal is still unlinked", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const { original, store, work } = yield* fixture
        yield* work.record({
          ...original,
          eventId: "foreign-pr-event",
          occurredAt: 501,
          goal: {
            ...original.goal,
            id: "foreign-goal",
            goalFamily: {
              canonicalGoalId: "foreign-goal",
              role: "canonical"
            },
            review: {
              state: "requested",
              summary: null,
              updatedAt: 501,
              url: target.reviewUrl
            },
            blocker: { summary: "Other owner", since: 501 },
            createdAt: 501,
            updatedAt: 501
          }
        })
        expect((yield* work.recoveryPreflight(target))._tag).toBe("conflict")
        expect((yield* store.list()).length).toBe(2)
      })
    ))

  it.effect("fails closed on a partial durable binding instead of inferring an absent claim", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const { original, path, store, work } = yield* fixture
        const sql = new DatabaseSync(path)
        sql
          .prepare(
            `INSERT INTO work_agent_bindings
        (dispatch_request_id, lane_id, expected_revision, revision, agent_id, host, record)
        VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run("orphan-binding", target.laneId, 0, 1, target.worker.agentId, target.worker.host, "{invalid-json")
        sql.close()
        expect(yield* Effect.result(work.recoveryPreflight(target))).toMatchObject({
          failure: { _tag: "WorkStoreError" }
        })
        expect(yield* store.list()).toEqual([original])
      })
    ))

  it.effect("refuses an operation ID already used by a durable transaction", () =>
    Effect.scoped(Effect.gen(function*() {
      const { original, path, store, work } = yield* fixture
      const sql = new DatabaseSync(path)
      sql.prepare("INSERT INTO work_goal_transactions (transaction_id, record) VALUES (?, ?)").run(
        "colliding-operation",
        JSON.stringify({ version: "herdr.work.transaction.v3", digest: "d".repeat(64) })
      )
      sql.close()
      const preflight = yield* work.recoveryPreflight(target)
      expect(preflight._tag).toBe("recoverable")
      if (preflight._tag !== "recoverable") return
      expect(
        yield* Effect.result(
          work.recoverExistingGoal({
            ...target,
            kind: "work.recover",
            operationId: "colliding-operation",
            expectedHistoryToken: preflight.historyToken,
            approvalJobId: "approved-recovery-job",
            approvalActor: "reviewer@example.com",
            approvalApprovedBy: "approver@example.com",
            approvalApprovedAt: 2_000,
            approvalHash: "c".repeat(64)
          })
        )
      ).toMatchObject({ failure: { _tag: "WorkAdmissionConflictError" } })
      expect(yield* store.list()).toEqual([original])
    })))

  it.effect("serializes competing approved claims on one complete-history token", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture
      const preflight = yield* work.recoveryPreflight(target)
      expect(preflight._tag).toBe("recoverable")
      if (preflight._tag !== "recoverable") return
      const request = {
        ...target,
        kind: "work.recover",
        expectedHistoryToken: preflight.historyToken,
        approvalJobId: "approved-recovery-job",
        approvalActor: "reviewer@example.com",
        approvalApprovedBy: "approver@example.com",
        approvalApprovedAt: 2_000,
        approvalHash: "c".repeat(64)
      } satisfies Omit<WorkExistingGoalRecovery, "operationId">
      const outcomes = yield* Effect.all([
        Effect.result(work.recoverExistingGoal({ ...request, operationId: "first-claim" })),
        Effect.result(work.recoverExistingGoal({ ...request, operationId: "second-claim" }))
      ], { concurrency: 2 })
      expect(outcomes.filter(({ _tag }) => _tag === "Success")).toHaveLength(1)
      expect(outcomes.filter(({ _tag }) => _tag === "Failure")).toHaveLength(1)
      expect((yield* store.list()).length).toBe(2)
    })))
})
