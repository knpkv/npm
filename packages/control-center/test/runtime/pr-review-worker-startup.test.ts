import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { AgentSessionRef } from "@knpkv/ai-runtime"
import { DateTime, Deferred, Effect, Layer, Ref, Result } from "effect"

import { JobId, WorkspaceId } from "../../src/domain/identifiers.js"
import { AgentJobWorker, type AgentJobWorkerRunResult } from "../../src/server/agent/AgentJobWorker.js"
import {
  PrReviewSandboxSessionError,
  PrReviewSandboxSessions
} from "../../src/server/agent/internal/PrReviewSandboxSession.js"
import { databaseLayer } from "../../src/server/persistence/Database.js"
import { Persistence, persistenceLayerFromDatabase } from "../../src/server/persistence/Persistence.js"
import { AgentAttemptSequence } from "../../src/server/persistence/repositories/agentJobModels.js"
import { WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { ControlCenterBootstrap } from "../../src/server/runtime/Bootstrap.js"
import {
  PrReviewWorkerRunning,
  PrReviewWorkerStartup,
  prReviewWorkerStartupLayer,
  selectPreservedSandboxAttempts
} from "../../src/server/runtime/PrReviewWorkerStartup.js"
import { ServerLifecycle } from "../../src/server/runtime/ServerLifecycle.js"
import { makePersistenceTestConfig } from "../persistence/fixtures.js"

const WORKSPACE_ID = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000021")
const FIXTURE_TIME = DateTime.makeUnsafe("2026-07-30T12:00:00.000Z")
const REVIEW_JOB_ID = JobId.make("01890f6f-6d6a-7cc0-98d2-000000000099")
const REVIEW_SANDBOX_NAME = "cc-pr-review-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-0099-0123456789ab"

const makeTestPersistence = Effect.fn("PrReviewWorkerStartupTest.makePersistence")(function*(
  createWorkspace: boolean
) {
  const config = yield* makePersistenceTestConfig("control-center-pr-review-startup-")
  const database = databaseLayer(config)
  const persistence = persistenceLayerFromDatabase(config).pipe(Layer.provide(database))
  if (createWorkspace) {
    yield* Effect.gen(function*() {
      const service = yield* Persistence
      yield* service.workspaces.create(WORKSPACE_ID, {
        displayName: WorkspaceName.make("PR review startup fixture"),
        createdAt: FIXTURE_TIME
      })
      yield* service.workspaceSettings.get(WORKSPACE_ID)
    }).pipe(Effect.provide(persistence), Effect.scoped)
  }
  return persistence
})

const bootstrapLayer = Layer.succeed(ControlCenterBootstrap, {
  _tag: "already-initialized",
  workspaceId: WORKSPACE_ID
})

describe("PR review worker startup", () => {
  it("preserves the newest immutable attempt across repeated sandbox recovery", () => {
    const preserved = selectPreservedSandboxAttempts(
      [
        {
          jobId: REVIEW_JOB_ID,
          attemptSequence: AgentAttemptSequence.make(1),
          attemptId: "0123456789ab",
          sessionRef: AgentSessionRef.make(`sbx:${REVIEW_SANDBOX_NAME}`)
        },
        {
          jobId: REVIEW_JOB_ID,
          attemptSequence: AgentAttemptSequence.make(2),
          attemptId: "abcdef012345",
          sessionRef: AgentSessionRef.make(`sbx:${REVIEW_SANDBOX_NAME}`)
        }
      ],
      [{ name: REVIEW_SANDBOX_NAME, jobToken: "0099", attemptId: "0123456789ab" }]
    )

    assert.deepStrictEqual(preserved, [{
      attemptId: "abcdef012345",
      attemptSequence: AgentAttemptSequence.make(2),
      jobId: REVIEW_JOB_ID,
      sandboxName: REVIEW_SANDBOX_NAME,
      sessionRef: AgentSessionRef.make(`sbx:${REVIEW_SANDBOX_NAME}`)
    }])
  })

  it.effect("attaches the worker to the server scope and exits it during drain", () =>
    Effect.gen(function*() {
      const lifecycle = yield* ServerLifecycle.make
      const persistence = yield* makeTestPersistence(true)
      const started = yield* Deferred.make<void>()
      let observedWorkspaceId: WorkspaceId | undefined
      let reconciledWorkspaceId: WorkspaceId | undefined
      const worker = AgentJobWorker.of({
        runOnce: (workspaceId) =>
          Effect.sync(() => {
            observedWorkspaceId = workspaceId
          }).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Effect.succeed({ _tag: "idle" } satisfies AgentJobWorkerRunResult))
          )
      })
      const sandboxes = PrReviewSandboxSessions.of({
        withSession: () => Effect.die("not used"),
        reconcile: (workspaceId) =>
          Effect.sync(() => {
            reconciledWorkspaceId = workspaceId
            return { removedSandboxes: ["/stale/sandbox"] }
          })
      })
      const startup = prReviewWorkerStartupLayer({
        workspaceId: WORKSPACE_ID,
        idlePollInterval: "1 hour"
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(AgentJobWorker, worker),
            bootstrapLayer,
            persistence,
            Layer.succeed(PrReviewSandboxSessions, sandboxes),
            Layer.succeed(ServerLifecycle, lifecycle)
          )
        )
      )

      const running = yield* Effect.gen(function*() {
        const state = yield* PrReviewWorkerStartup
        const service = yield* Persistence
        yield* Deferred.await(started)
        const runs = yield* service.retention.listRuns(WORKSPACE_ID)
        assert.deepStrictEqual(
          runs.map(({ deletedCount, retentionClass, selectedCount }) => ({
            deletedCount,
            retentionClass,
            selectedCount
          })),
          [
            {
              deletedCount: 1,
              retentionClass: "sandbox-artifact",
              selectedCount: 1
            }
          ]
        )
        yield* lifecycle.beginDrain
        yield* lifecycle.awaitWorkDrained
        return state
      }).pipe(Effect.provide(Layer.merge(persistence, startup)))

      assert.instanceOf(running, PrReviewWorkerRunning)
      assert.strictEqual(running.workspaceId, WORKSPACE_ID)
      assert.strictEqual(observedWorkspaceId, WORKSPACE_ID)
      assert.strictEqual(reconciledWorkspaceId, WORKSPACE_ID)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("fails before polling when stale-sandbox reconciliation is unavailable", () =>
    Effect.gen(function*() {
      const lifecycle = yield* ServerLifecycle.make
      const persistence = yield* makeTestPersistence(true)
      const started = yield* Ref.make(false)
      const worker = AgentJobWorker.of({
        runOnce: () => Ref.set(started, true).pipe(Effect.as({ _tag: "idle" } satisfies AgentJobWorkerRunResult))
      })
      const sandboxes = PrReviewSandboxSessions.of({
        withSession: () => Effect.die("not used"),
        reconcile: () =>
          Effect.fail(
            new PrReviewSandboxSessionError({
              reason: "sandbox-unavailable"
            })
          )
      })
      const startup = prReviewWorkerStartupLayer({
        workspaceId: WORKSPACE_ID,
        idlePollInterval: "1 hour"
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(AgentJobWorker, worker),
            bootstrapLayer,
            persistence,
            Layer.succeed(PrReviewSandboxSessions, sandboxes),
            Layer.succeed(ServerLifecycle, lifecycle)
          )
        )
      )

      const result = yield* Layer.build(startup).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      assert.isFalse(yield* Ref.get(started))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("fails before polling when a successful reconciliation cannot be audited", () =>
    Effect.gen(function*() {
      const lifecycle = yield* ServerLifecycle.make
      const persistence = yield* makeTestPersistence(false)
      const started = yield* Ref.make(false)
      const worker = AgentJobWorker.of({
        runOnce: () => Ref.set(started, true).pipe(Effect.as({ _tag: "idle" } satisfies AgentJobWorkerRunResult))
      })
      const sandboxes = PrReviewSandboxSessions.of({
        withSession: () => Effect.die("not used"),
        reconcile: () => Effect.succeed({ removedSandboxes: ["/stale/sandbox"] })
      })
      const startup = prReviewWorkerStartupLayer({
        workspaceId: WORKSPACE_ID
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(AgentJobWorker, worker),
            bootstrapLayer,
            persistence,
            Layer.succeed(PrReviewSandboxSessions, sandboxes),
            Layer.succeed(ServerLifecycle, lifecycle)
          )
        )
      )

      const result = yield* Layer.build(startup).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      assert.isFalse(yield* Ref.get(started))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))
})
