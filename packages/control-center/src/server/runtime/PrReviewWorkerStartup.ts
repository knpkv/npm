/** Supervise the durable PR-review worker for one configured workspace. @module */
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import type { WorkspaceId } from "../../domain/identifiers.js"
import { AgentJobWorker } from "../agent/AgentJobWorker.js"
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
  const idlePollInterval = Duration.fromInputUnsafe(
    options.idlePollInterval ?? DEFAULT_IDLE_POLL_INTERVAL
  )
  const failurePollInterval = Duration.fromInputUnsafe(
    options.failurePollInterval ?? DEFAULT_FAILURE_POLL_INTERVAL
  )
  const cycle = worker.runOnce(options.workspaceId).pipe(
    Effect.flatMap((result) =>
      result._tag === "idle"
        ? Effect.sleep(idlePollInterval)
        : Effect.yieldNow
    ),
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.failCause(cause)
        : Effect.logError("PR review worker cycle failed", cause).pipe(
          Effect.andThen(Effect.sleep(failurePollInterval))
        )
    )
  )
  const supervise = lifecycle.runBackground(
    Effect.raceFirst(
      lifecycle.awaitDrain,
      Effect.forever(cycle)
    )
  ).pipe(
    Effect.catch(() => Effect.void)
  )
  yield* Effect.forkScoped(supervise)
  return new PrReviewWorkerRunning({ workspaceId: options.workspaceId })
})

/** Attach one review worker to the server scope and graceful-drain boundary. */
export const prReviewWorkerStartupLayer = (
  options: PrReviewWorkerStartupOptions
): Layer.Layer<
  PrReviewWorkerStartup,
  never,
  AgentJobWorker | ServerLifecycle
> => Layer.effect(PrReviewWorkerStartup, makeStartup(options))
