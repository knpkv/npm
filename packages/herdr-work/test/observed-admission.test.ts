import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  makeWorkService,
  type WorkAdmissionTarget,
  type WorkObservedAdmission,
  type WorkProspectiveAdmission,
  WorkStore
} from "../src/index.js"

const target: WorkAdmissionTarget = {
  repository: "example/npm",
  pullRequest: 433,
  reviewUrl: "https://github.com/example/npm/pull/433",
  goalId: "observed-pr433",
  laneId: "lane-observed-pr433",
  head: "a".repeat(40),
  baseHead: "d".repeat(40),
  owner: { id: "owner-1", name: "Observed owner" },
  sessionId: "01a0ae7d-ed74-73c1-8454-4aed86de10cc",
  expectedWork: "feat/observed",
  worker: { host: "TEST-HOST", agentId: "agent-observed433", name: "Observed owner", paneId: "w1P:p3" },
  worktree: "/tmp/observed-owner/feat/observed",
  branch: "feat/observed"
}

// @effect-diagnostics-next-line strictEffectProvide:off
const provideNodeServices = Effect.provide(NodeServices.layer)

const fixture = Effect.gen(function*() {
  yield* TestClock.setTime(1_000)
  const root = mkdtempSync(join(tmpdir(), "herdr-observed-admission-"))
  yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { recursive: true, force: true })))
  const store = yield* Effect.acquireRelease(
    WorkStore.open(join(root, "work.sqlite")),
    (opened) => Effect.sync(() => opened.close())
  )
  const work = yield* makeWorkService(store)
  return { store, work }
}).pipe(provideNodeServices)

const observedRequest = (absenceToken: string, observationId = "observation-433"): WorkObservedAdmission => ({
  ...target,
  expectedAbsenceToken: absenceToken,
  operationId: "observed-admission-433",
  title: "Ship PR433",
  summary: "Observed worker on PR433",
  detail: "Admitted by the reconciler",
  observationId
})

const approvedRequest = (absenceToken: string): WorkProspectiveAdmission => ({
  kind: "work.admit",
  ...target,
  expectedAbsenceToken: absenceToken,
  operationId: "observed-admission-433",
  title: "Ship PR433",
  summary: "Observed worker on PR433",
  detail: "Admitted by the reconciler",
  approvalJobId: "approved-fleet-job-433",
  approvalActor: "reviewer@example.com"
})

const absenceToken = (work: Effect.Success<typeof fixture>["work"]) =>
  Effect.gen(function*() {
    const preflight = yield* work.admissionPreflight(target)
    if (preflight._tag !== "prospective") return yield* Effect.die(preflight)
    return preflight.absenceToken
  })

/** Confirms every stored fact, as a pass that has just re-read them all would, then reconciles. */
const reconcileConfirmed = (
  store: Effect.Success<typeof fixture>["store"],
  work: Effect.Success<typeof fixture>["work"]
) =>
  store.snapshotInput().pipe(
    Effect.flatMap(({ facts }) =>
      work.reconcile({ confirmed: facts.map(({ observationId, subject }) => ({ observationId, subject })) })
    )
  )

describe("observed admission", () => {
  it.effect("admits an observed worker, credited to the reconciler and its observation", () =>
    Effect.scoped(Effect.gen(function*() {
      const { work } = yield* fixture
      const request = observedRequest(yield* absenceToken(work))
      const link = yield* work.admitObserved(request)
      expect(link.binding.request.observedAdmission).toEqual({
        actor: "reconciler",
        baseHead: target.baseHead,
        expectedAbsenceToken: request.expectedAbsenceToken,
        observationId: "observation-433",
        sessionId: target.sessionId,
        workAssignment: target.expectedWork
      })
      expect(link.binding.request.prospectiveAdmission).toBeUndefined()
      expect(link.goal.activity?.[0]?.summary).toBe(
        "Admission of an observed worker by the reconciler from observation observation-433"
      )
      const now = (yield* work.snapshots()).now
      expect(now.activityProvenance).toEqual([{
        activityId: `${request.operationId}.admission`,
        approvalJobId: null,
        goalId: target.goalId,
        provenance: "reconciler"
      }])
      expect((yield* work.admissionPreflight(target))._tag).toBe("existing")
    })))

  it.effect("replays only the exact observation, never another observation or an approved job", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture
      const token = yield* absenceToken(work)
      const link = yield* work.admitObserved(observedRequest(token))
      expect(yield* work.admitObserved(observedRequest(token))).toEqual(link)
      expect(yield* Effect.result(work.admitObserved(observedRequest(token, "observation-other")))).toMatchObject({
        failure: { _tag: "WorkAdmissionConflictError" }
      })
      expect(yield* Effect.result(work.admitExistingOwner(approvedRequest(token)))).toMatchObject({
        failure: { _tag: "WorkAdmissionConflictError" }
      })
      expect((yield* store.list()).length).toBe(2)
    })))

  it.effect("does not let an approved replay pass for an observed admission's binding", () =>
    Effect.scoped(Effect.gen(function*() {
      const { work } = yield* fixture
      const token = yield* absenceToken(work)
      yield* work.admitExistingOwner(approvedRequest(token))
      expect(yield* Effect.result(work.admitObserved(observedRequest(token)))).toMatchObject({
        failure: { _tag: "WorkAdmissionConflictError" }
      })
    })))

  it.effect("refuses stale absence evidence without writing", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture
      expect(yield* Effect.result(work.admitObserved(observedRequest("b".repeat(64))))).toMatchObject({
        failure: { _tag: "WorkAdmissionConflictError" }
      })
      expect(yield* store.list()).toEqual([])
    })))

  it.effect("keeps the observed admission's session claimed against another target", () =>
    Effect.scoped(Effect.gen(function*() {
      const { work } = yield* fixture
      yield* work.admitObserved(observedRequest(yield* absenceToken(work)))
      const other = yield* work.admissionPreflight({
        ...target,
        pullRequest: 434,
        reviewUrl: "https://github.com/example/npm/pull/434",
        goalId: "observed-pr434",
        laneId: "lane-observed-pr434",
        worker: { ...target.worker, agentId: "agent-observed434" },
        worktree: "/tmp/observed-owner/other"
      })
      expect(other._tag).toBe("conflict")
    })))

  it.effect("still lets the reconciler close an observed goal when its pull request merges", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, work } = yield* fixture
      yield* work.admitObserved(observedRequest(yield* absenceToken(work)))
      yield* work.observe([{
        observation: {
          _tag: "pull_request",
          branch: target.branch,
          checks: "passing",
          closedAt: 2_000,
          head: target.head,
          pullRequest: target.pullRequest,
          repository: target.repository,
          review: "approved",
          state: "merged"
        },
        observedAt: 2_000
      }])
      yield* TestClock.setTime(3_000)
      expect((yield* reconcileConfirmed(store, work))[0]?._tag).toBe("applied")
      const goal = (yield* work.snapshots()).now.goals.find(({ id }) => id === target.goalId)
      expect(goal?.state).toBe("completed")
    })))
})
