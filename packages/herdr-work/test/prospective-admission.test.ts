import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Crypto, Deferred, Effect, Fiber, PlatformError, Ref } from "effect"
import { TestClock } from "effect/testing"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { makeWorkService, type WorkAdmissionTarget, type WorkProspectiveAdmission, WorkStore } from "../src/index.js"

const target: WorkAdmissionTarget = {
  repository: "example/npm",
  pullRequest: 433,
  reviewUrl: "https://github.com/example/npm/pull/433",
  goalId: "release-pr433",
  laneId: "lane-pr433",
  head: "a".repeat(40),
  baseHead: "d".repeat(40),
  owner: { id: "owner-1", name: "Original owner" },
  sessionId: "01a0ae7d-ed74-73c1-8454-4aed86de10cc",
  expectedWork: "feat/guided-review-rly",
  worker: { host: "TEST-HOST", agentId: "agent-original433", name: "Original owner", paneId: "w1P:p3" },
  worktree: "/tmp/existing-owner/feat/guided-review-rly",
  branch: "feat/guided-review-rly"
}

// @effect-diagnostics-next-line strictEffectProvide:off
const provideNodeServices = Effect.provide(NodeServices.layer)

const fixture = (configureCrypto?: (base: Crypto.Crypto) => Crypto.Crypto) =>
  Effect.gen(function*() {
    yield* TestClock.setTime(1_000)
    const root = mkdtempSync(join(tmpdir(), "herdr-prospective-admission-"))
    yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { recursive: true, force: true })))
    const path = join(root, "work.sqlite")
    const baseCrypto = yield* Crypto.Crypto
    const configuredCrypto = configureCrypto?.(baseCrypto) ?? baseCrypto
    const store = yield* Effect.acquireRelease(
      WorkStore.open(path).pipe(Effect.provideService(Crypto.Crypto, configuredCrypto)),
      (opened) => Effect.sync(() => opened.close())
    )
    const work = yield* makeWorkService(store)
    return { path, store, work }
  }).pipe(provideNodeServices)

const requestFor = (absenceToken: string) =>
  ({
    kind: "work.admit",
    ...target,
    expectedAbsenceToken: absenceToken,
    operationId: "prospective-admission-433",
    title: "Ship PR433",
    summary: "Prospective existing-owner admission for PR433",
    detail: "Source-only synthetic admission fixture",
    approvalJobId: "approved-fleet-job-433",
    approvalActor: "reviewer@example.com"
  }) satisfies WorkProspectiveAdmission

describe("prospective existing-owner admission", () => {
  it.effect("inspects without mutation, atomically admits, and replays only the exact operation", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture()
      const before = yield* work.admissionPreflight(target)
      expect(before._tag).toBe("prospective")
      if (before._tag !== "prospective") return
      expect(before.absenceToken).toBe("f09ac24877e73245994affbe857ec670c52426e98f98a2f8dfc1fd4da5cae25e")
      expect(yield* store.list()).toEqual([])
      expect(yield* work.admissionPreflight(target)).toEqual(before)
      const request = requestFor(before.absenceToken)
      const link = yield* work.admitExistingOwner(request)
      expect(link.goal.review?.url).toBe(target.reviewUrl)
      expect(link.lane.head).toBe(target.head)
      const now = (yield* work.snapshots()).now
      expect(now.activityProvenance).toEqual([{
        activityId: `${request.operationId}.admission`,
        approvalJobId: request.approvalJobId,
        goalId: target.goalId,
        provenance: "approval"
      }])
      expect(now.activityProvenanceGoals).toEqual([target.goalId])
      expect(link.binding.request.prospectiveAdmission).toEqual({
        sessionId: target.sessionId,
        workAssignment: target.expectedWork,
        baseHead: target.baseHead,
        expectedAbsenceToken: request.expectedAbsenceToken,
        approvalJobId: request.approvalJobId,
        approvalActor: request.approvalActor
      })
      expect(
        yield* work.inspectPullRequest({
          repository: target.repository,
          pullRequest: target.pullRequest,
          goalId: target.goalId,
          laneId: target.laneId
        })
      ).toEqual(link)
      expect(yield* work.admissionPreflight(target)).toEqual({ _tag: "existing", target, link })
      expect(yield* work.admitExistingOwner(request)).toEqual(link)
      expect((yield* store.list()).length).toBe(2)
      for (
        const change of [
          { operationId: "another-operation" },
          { approvalJobId: "another-approval" },
          { expectedAbsenceToken: "b".repeat(64) },
          { title: "Different title" }
        ]
      ) {
        const outcome = yield* Effect.result(work.admitExistingOwner({ ...request, ...change }))
        expect(outcome).toMatchObject({ failure: { _tag: "WorkAdmissionConflictError" } })
      }
      expect((yield* store.list()).length).toBe(2)
    })))

  it.effect("rejects stale absence and hidden identity conflicts without mutation", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture()
      const preflight = yield* work.admissionPreflight(target)
      expect(preflight._tag).toBe("prospective")
      if (preflight._tag !== "prospective") return
      const stale = yield* Effect.result(work.admitExistingOwner(requestFor("b".repeat(64))))
      expect(stale).toMatchObject({ failure: { _tag: "WorkAdmissionConflictError" } })
      const request = requestFor(preflight.absenceToken)
      yield* work.admitExistingOwner(request)
      const competing = { ...target, goalId: "other-goal", laneId: "other-lane" }
      expect((yield* work.admissionPreflight(competing))._tag).toBe("conflict")
      expect(
        (yield* work.admissionPreflight({
          ...competing,
          worker: { ...target.worker, agentId: "agent-other" },
          worktree: "/tmp/another-worktree"
        }))._tag
      ).toBe("conflict")
      expect((yield* work.admissionPreflight({ ...target, head: "c".repeat(40) }))._tag).toBe("conflict")
      expect((yield* work.admissionPreflight({ ...target, sessionId: "00000000-0000-0000-0000-000000000000" }))._tag)
        .toBe("conflict")
      expect((yield* work.admissionPreflight({ ...target, expectedWork: "other-work" }))._tag).toBe("conflict")
      const current = yield* work.inspectPullRequest({
        repository: target.repository,
        pullRequest: target.pullRequest,
        goalId: target.goalId,
        laneId: target.laneId
      })
      yield* work.record({
        version: "herdr.work.event.v1",
        eventId: "completed-pr433",
        occurredAt: 1_001,
        goal: { ...current.goal, state: "completed", updatedAt: 1_001 }
      })
      expect((yield* work.admissionPreflight(target))._tag).toBe("conflict")
      expect(
        (yield* work.admissionPreflight({
          ...competing,
          reviewUrl: "https://github.com/example/npm/pull/434",
          pullRequest: 434,
          worktree: "/tmp/another-worktree"
        }))._tag
      ).toBe("conflict")
      expect((yield* store.list()).length).toBe(3)
    })))

  it.effect("rolls back the goal and lane when binding insertion fails", () =>
    Effect.scoped(Effect.gen(function*() {
      const { path, store, work } = yield* fixture()
      const preflight = yield* work.admissionPreflight(target)
      expect(preflight._tag).toBe("prospective")
      if (preflight._tag !== "prospective") return
      const sql = new DatabaseSync(path)
      sql.exec(`CREATE TRIGGER fail_admission_binding BEFORE INSERT ON work_agent_bindings
        BEGIN SELECT RAISE(ABORT, 'synthetic binding failure'); END`)
      sql.close()
      const outcome = yield* Effect.result(work.admitExistingOwner(requestFor(preflight.absenceToken)))
      expect(outcome).toMatchObject({ failure: { _tag: "WorkStoreError" } })
      expect(yield* store.list()).toEqual([])
      expect((yield* work.admissionPreflight(target))._tag).toBe("prospective")
    })))

  it.effect("returns an existing canonical binding for the reconciliation route without inventing admission provenance", () =>
    Effect.scoped(Effect.gen(function*() {
      const { path, work } = yield* fixture()
      const preflight = yield* work.admissionPreflight(target)
      expect(preflight._tag).toBe("prospective")
      if (preflight._tag !== "prospective") return
      const request = requestFor(preflight.absenceToken)
      const link = yield* work.admitExistingOwner(request)
      const sql = new DatabaseSync(path)
      sql.prepare("UPDATE work_agent_bindings SET record = ? WHERE dispatch_request_id = ?").run(
        JSON.stringify({ ...link.binding, request: { ...link.binding.request, prospectiveAdmission: undefined } }),
        request.operationId
      )
      sql.close()
      expect((yield* work.admissionPreflight(target))._tag).toBe("existing")
      expect(yield* Effect.result(work.admitExistingOwner(request))).toMatchObject({
        failure: { _tag: "WorkAdmissionConflictError" }
      })
    })))

  it.effect("rejects a completed lane rather than reusing its worker binding", () =>
    Effect.scoped(Effect.gen(function*() {
      const { work } = yield* fixture()
      const preflight = yield* work.admissionPreflight(target)
      expect(preflight._tag).toBe("prospective")
      if (preflight._tag !== "prospective") return
      yield* work.admitExistingOwner(requestFor(preflight.absenceToken))
      yield* work.claim({
        operationId: "ship-pr433-fixture",
        goalId: target.goalId,
        laneId: target.laneId,
        worktree: target.worktree,
        branch: target.branch,
        head: target.head,
        owner: target.owner,
        parent: null,
        phase: "shipped",
        expectedRevision: 1
      })
      expect((yield* work.admissionPreflight(target))._tag).toBe("conflict")
    })))

  it.effect("invalidates an absence token after an unrelated durable Work change", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture()
      const original = yield* work.admissionPreflight(target)
      expect(original._tag).toBe("prospective")
      if (original._tag !== "prospective") return
      const other = {
        ...target,
        pullRequest: 435,
        reviewUrl: "https://github.com/example/npm/pull/435",
        goalId: "release-pr435",
        laneId: "lane-pr435",
        worker: { ...target.worker, agentId: "agent-pr435" },
        sessionId: "00000000-0000-0000-0000-000000000435",
        expectedWork: "feat/pr435",
        worktree: "/tmp/existing-owner/feat/pr435",
        branch: "feat/pr435"
      }
      const otherPreflight = yield* work.admissionPreflight(other)
      expect(otherPreflight._tag).toBe("prospective")
      if (otherPreflight._tag !== "prospective") return
      expect(otherPreflight.absenceToken).not.toBe(original.absenceToken)
      yield* work.admitExistingOwner({
        ...requestFor(otherPreflight.absenceToken),
        ...other,
        operationId: "prospective-admission-435"
      })
      expect(yield* Effect.result(work.admitExistingOwner(requestFor(original.absenceToken)))).toMatchObject({
        failure: { _tag: "WorkAdmissionConflictError", reason: "stale absence evidence" }
      })
      expect((yield* store.list()).length).toBe(2)
    })))

  it.effect("reports digest failure without issuing an absence token", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture((baseCrypto) => ({
        ...baseCrypto,
        digest: () =>
          Effect.fail(PlatformError.systemError({
            _tag: "Unknown",
            module: "Crypto",
            method: "digest",
            description: "synthetic digest failure"
          }))
      }))
      expect(yield* Effect.result(work.admissionPreflight(target))).toMatchObject({
        failure: { _tag: "WorkStoreError", operation: "admission.preflight.digest" }
      })
      expect(yield* store.list()).toEqual([])
    })))

  it.effect("fails admission through the typed digest error without writing a goal", () =>
    Effect.scoped(Effect.gen(function*() {
      const fail = yield* Ref.make(false)
      const { store, work } = yield* fixture((baseCrypto) => ({
        ...baseCrypto,
        digest: (algorithm, data) =>
          Effect.gen(function*() {
            if (yield* Ref.get(fail)) {
              return yield* PlatformError.systemError({
                _tag: "Unknown",
                module: "Crypto",
                method: "digest",
                description: "synthetic admission digest failure"
              })
            }
            return yield* baseCrypto.digest(algorithm, data)
          })
      }))
      const preflight = yield* work.admissionPreflight(target)
      expect(preflight._tag).toBe("prospective")
      if (preflight._tag !== "prospective") return
      yield* Ref.set(fail, true)
      expect(yield* Effect.result(work.admitExistingOwner(requestFor(preflight.absenceToken)))).toMatchObject({
        failure: { _tag: "WorkStoreError", operation: "admission.digest" }
      })
      expect(yield* store.list()).toEqual([])
    })))

  it.effect("rejects a snapshot changed while its digest is suspended", () =>
    Effect.scoped(Effect.gen(function*() {
      const suspend = yield* Ref.make(false)
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const { store, work } = yield* fixture((baseCrypto) => ({
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
      const first = yield* work.admissionPreflight(target)
      expect(first._tag).toBe("prospective")
      if (first._tag !== "prospective") return
      yield* Ref.set(suspend, true)
      const pending = yield* work.admitExistingOwner(requestFor(first.absenceToken)).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      yield* Ref.set(suspend, false)
      const other = {
        ...target,
        pullRequest: 435,
        reviewUrl: "https://github.com/example/npm/pull/435",
        goalId: "release-pr435",
        laneId: "lane-pr435",
        worker: { ...target.worker, agentId: "agent-pr435" },
        sessionId: "00000000-0000-0000-0000-000000000435",
        expectedWork: "feat/pr435",
        worktree: "/tmp/existing-owner/feat/pr435",
        branch: "feat/pr435"
      }
      const second = yield* work.admissionPreflight(other)
      expect(second._tag).toBe("prospective")
      if (second._tag !== "prospective") return
      yield* work.admitExistingOwner({
        ...requestFor(second.absenceToken),
        ...other,
        operationId: "prospective-admission-435"
      })
      yield* Deferred.succeed(release, undefined)
      expect(yield* Effect.result(Fiber.join(pending))).toMatchObject({
        failure: { _tag: "WorkAdmissionConflictError", reason: "stale absence evidence" }
      })
      expect((yield* store.list()).length).toBe(2)
    })))

  it.effect("releases the read transaction before an interrupted digest", () =>
    Effect.scoped(Effect.gen(function*() {
      const suspend = yield* Ref.make(false)
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const { store, work } = yield* fixture((baseCrypto) => ({
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
      const preflight = yield* work.admissionPreflight(target)
      expect(preflight._tag).toBe("prospective")
      if (preflight._tag !== "prospective") return
      yield* Ref.set(suspend, true)
      const pending = yield* work.admitExistingOwner(requestFor(preflight.absenceToken)).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(pending)
      yield* Ref.set(suspend, false)
      expect(yield* store.list()).toEqual([])
      yield* work.admitExistingOwner(requestFor(preflight.absenceToken))
      expect((yield* store.list()).length).toBe(2)
    })))
})
