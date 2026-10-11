/** Shared lifecycle admission, wakeup and drain loop for durable workers. @module */
import * as Cause from "effect/Cause"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"

import type { WorkspaceId } from "../../../domain/identifiers.js"
import type { AgentJobWorkerService } from "../../agent/AgentJobWorker.js"
import type { ServerLifecycle } from "../ServerLifecycle.js"

interface BackgroundWorkerOptions<Failure, Requirements> {
  readonly failurePollInterval: Duration.Duration
  readonly logLabel: string
  readonly lifecycle: ServerLifecycle["Service"]
  readonly cycle: Effect.Effect<Duration.Duration, Failure, Requirements>
  readonly awaitWork?: Effect.Effect<void, never, Requirements>
}

interface SuperviseAgentJobWorkerOptions {
  readonly failurePollInterval: Duration.Duration
  readonly idlePollInterval: Duration.Duration
  readonly logLabel: string
  readonly lifecycle: ServerLifecycle["Service"]
  readonly worker: AgentJobWorkerService
  readonly workspaceId: WorkspaceId
}

/** Admit only an active cycle, then stop polling as soon as drain begins. @internal */
export const superviseBackgroundWorker = Effect.fn("BackgroundWorker.supervise")(function*<Failure, Requirements>(
  options: BackgroundWorkerOptions<Failure, Requirements>
) {
  const cycle = options.cycle.pipe(
    // eslint-disable-next-line local-rules/require-exact-cause-rethrow -- This lifecycle supervisor logs defects and continues; agent-job-worker.test.ts covers retry and scoped interruption.
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.failCause(cause)
        : Effect.logError(`${options.logLabel} cycle failed`, cause).pipe(
          Effect.as(options.failurePollInterval)
        )
    )
  )
  const supervise = Effect.gen(function*() {
    while (true) {
      const nextPollInterval = yield* options.lifecycle.runBackground(cycle)
      const drainStarted = yield* Effect.raceFirst(
        options.lifecycle.awaitDrain.pipe(Effect.as(true)),
        (
          Duration.isZero(nextPollInterval)
            ? Effect.yieldNow
            : options.awaitWork === undefined ?
            Effect.sleep(nextPollInterval) :
            Effect.raceFirst(options.awaitWork, Effect.sleep(nextPollInterval))
        ).pipe(Effect.as(false))
      )
      if (drainStarted) return
    }
  }).pipe(
    // A draining server refusing the next cycle is the normal stop; anything else is logged, never dropped.
    Effect.catch((error) =>
      Predicate.isTagged(error, "ServerDraining")
        ? Effect.void
        : Effect.logError(`${options.logLabel} supervisor stopped`, error)
    )
  )
  yield* Effect.forkScoped(supervise)
})

/** Agent jobs share the same admission and graceful-drain loop as readiness work. */
export const superviseAgentJobWorker = Effect.fn("AgentJobWorker.supervise")(function*(
  options: SuperviseAgentJobWorkerOptions
) {
  yield* superviseBackgroundWorker({
    ...options,
    cycle: options.worker.runOnce(options.workspaceId).pipe(
      Effect.map((result) => result._tag === "idle" ? options.idlePollInterval : Duration.zero)
    )
  })
})
