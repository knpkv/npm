/** Shared lifecycle admission and polling loop for durable agent workers. @module */
import * as Cause from "effect/Cause"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"

import type { WorkspaceId } from "../../../domain/identifiers.js"
import type { AgentJobWorkerService } from "../../agent/AgentJobWorker.js"
import type { ServerLifecycle } from "../ServerLifecycle.js"

interface SuperviseAgentJobWorkerOptions {
  readonly failurePollInterval: Duration.Duration
  readonly idlePollInterval: Duration.Duration
  readonly logLabel: string
  readonly lifecycle: ServerLifecycle["Service"]
  readonly worker: AgentJobWorkerService
  readonly workspaceId: WorkspaceId
}

/** Admit only an active cycle, then stop polling as soon as drain begins. @internal */
export const superviseAgentJobWorker = Effect.fn("AgentJobWorker.supervise")(function*(
  options: SuperviseAgentJobWorkerOptions
) {
  const cycle = options.worker.runOnce(options.workspaceId).pipe(
    Effect.map((result) => result._tag === "idle" ? options.idlePollInterval : Duration.zero),
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
            : Effect.sleep(nextPollInterval)
        ).pipe(Effect.as(false))
      )
      if (drainStarted) return
    }
  }).pipe(
    Effect.catch(() => Effect.void)
  )
  yield* Effect.forkScoped(supervise)
})
