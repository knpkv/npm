/** Supervise the durable PR-review worker for one configured workspace. @module */
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import { AgentSessionRef } from "@knpkv/ai-runtime"

import type { WorkspaceId } from "../../domain/identifiers.js"
import { AgentJobWorker } from "../agent/AgentJobWorker.js"
import { type PrReviewSandboxSessionError, PrReviewSandboxSessions } from "../agent/internal/PrReviewSandboxSession.js"
import { Persistence, type PersistenceOperationFailure } from "../persistence/Persistence.js"
import { ControlCenterBootstrap } from "./Bootstrap.js"
import { superviseAgentJobWorker } from "./internal/superviseAgentJobWorker.js"
import { ServerLifecycle } from "./ServerLifecycle.js"

const DEFAULT_IDLE_POLL_INTERVAL = Duration.seconds(1)
const DEFAULT_FAILURE_POLL_INTERVAL = Duration.seconds(5)

/** Bounded polling policy owned by the server composition, not by queued work. */
export interface PrReviewWorkerStartupOptions {
  readonly workspaceId: WorkspaceId
  readonly idlePollInterval?: Duration.Input
  readonly failurePollInterval?: Duration.Input
}

/** Diagnostic state proving the worker fiber was attached to the server scope. */
export class PrReviewWorkerRunning extends Data.TaggedClass("running")<{
  readonly workspaceId: WorkspaceId
}> {}

/** Startup state retained by the server layer. */
export class PrReviewWorkerStartup extends Context.Service<
  PrReviewWorkerStartup,
  PrReviewWorkerRunning
>()("@knpkv/control-center/server/runtime/PrReviewWorkerStartup") {}

const makeStartup = Effect.fn("PrReviewWorkerStartup.make")(function*(
  options: PrReviewWorkerStartupOptions
) {
  const lifecycle = yield* ServerLifecycle
  const worker = yield* AgentJobWorker
  const sandboxes = yield* PrReviewSandboxSessions
  const persistence = yield* Persistence
  yield* ControlCenterBootstrap
  const reconciliation = yield* sandboxes.reconcile(options.workspaceId).pipe(
    Effect.tapError((failure) => Effect.logError("PR review sandbox reconciliation failed", failure))
  )
  const runningAttempts = yield* persistence.agentJobs.listRunningPrReviewAttempts(options.workspaceId)
  const preservedSandboxAttempts = (reconciliation.reattachedSandboxIdentities ?? []).flatMap((sandbox) => {
    const sessionRef = AgentSessionRef.make(`sbx:${sandbox.name}`)
    const carriedAttempts = runningAttempts.filter((attempt) => attempt.sessionRef === sessionRef)
    const directAttempts = runningAttempts.filter((attempt) =>
      attempt.jobId.replaceAll("-", "").slice(-4) === sandbox.jobToken &&
      attempt.attemptId === sandbox.attemptId
    )
    const latest = [...(carriedAttempts.length > 0 ? carriedAttempts : directAttempts)]
      .sort((left, right) => right.attemptSequence - left.attemptSequence)[0]
    return latest === undefined ? [] : [{ sandboxName: sandbox.name, ...latest }]
  })
  const preservedAttempts = preservedSandboxAttempts.map(({ attemptSequence, jobId }) => ({ attemptSequence, jobId }))
  if (persistence.agentJobs.attachRunningPrReviewSession !== undefined) {
    yield* Effect.forEach(
      (reconciliation.reattachedSandboxIdentities ?? []).flatMap((sandbox) =>
        runningAttempts
          .filter((attempt) =>
            attempt.jobId.replaceAll("-", "").slice(-4) === sandbox.jobToken &&
            attempt.attemptId === sandbox.attemptId
          )
          .map(({ attemptSequence, jobId }) => ({
            attemptSequence,
            jobId,
            sessionRef: AgentSessionRef.make(`sbx:${sandbox.name}`)
          }))
      ),
      (recovered) =>
        persistence.agentJobs.attachRunningPrReviewSession!({
          workspaceId: options.workspaceId,
          ...recovered
        }),
      { discard: true }
    )
  }
  const preservedSandboxNames = new Set(
    preservedSandboxAttempts.map(({ sandboxName }) => sandboxName)
  )
  const unmatchedSandboxNames = (reconciliation.reattachedSandboxes ?? [])
    .filter((name) => !preservedSandboxNames.has(name))
  const removedSandboxes = sandboxes.cleanupUnmatched === undefined
    ? []
    : yield* sandboxes.cleanupUnmatched(unmatchedSandboxNames)
  if (persistence.agentJobs.interruptRunningReviews === undefined) {
    yield* Effect.logDebug("PR review interruption recovery is unavailable for this persistence boundary")
  } else {
    yield* DateTime.now.pipe(
      Effect.flatMap((interruptedAt) =>
        persistence.agentJobs.interruptRunningReviews!({
          workspaceId: options.workspaceId,
          interruptedAt,
          preservedAttempts
        })
      )
    )
  }
  yield* persistence.retention
    .recordSandboxReconciliation(
      options.workspaceId,
      reconciliation.removedSandboxes.length + removedSandboxes.length
    )
  const idlePollInterval = Duration.fromInputUnsafe(
    options.idlePollInterval ?? DEFAULT_IDLE_POLL_INTERVAL
  )
  const failurePollInterval = Duration.fromInputUnsafe(
    options.failurePollInterval ?? DEFAULT_FAILURE_POLL_INTERVAL
  )
  yield* superviseAgentJobWorker({
    failurePollInterval,
    idlePollInterval,
    lifecycle,
    logLabel: "PR review worker",
    worker,
    workspaceId: options.workspaceId
  })
  return new PrReviewWorkerRunning({ workspaceId: options.workspaceId })
})

/** Attach one review worker to the server scope and graceful-drain boundary. */
export const prReviewWorkerStartupLayer = (
  options: PrReviewWorkerStartupOptions
): Layer.Layer<
  PrReviewWorkerStartup,
  PersistenceOperationFailure | PrReviewSandboxSessionError,
  AgentJobWorker | ControlCenterBootstrap | Persistence | PrReviewSandboxSessions | ServerLifecycle
> => Layer.effect(PrReviewWorkerStartup, makeStartup(options))
