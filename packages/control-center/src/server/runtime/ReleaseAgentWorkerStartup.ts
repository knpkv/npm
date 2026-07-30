/** Supervise durable release-chat agent jobs for one configured workspace. @module */
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

/** Bounded release-chat polling policy owned by the server composition. */
export interface ReleaseAgentWorkerStartupOptions {
  readonly workspaceId: WorkspaceId
  readonly idlePollInterval?: Duration.Input
  readonly failurePollInterval?: Duration.Input
  /** Deterministic composition-test hook; production starts through supervision. @internal */
  readonly runOnceBeforeSupervision?: boolean
}

/** Diagnostic state proving the release-chat worker is attached to the server scope. */
export class ReleaseAgentWorkerRunning extends Data.TaggedClass("running")<{
  readonly workspaceId: WorkspaceId
}> {}

/** Startup state retained by the server layer. */
export class ReleaseAgentWorkerStartup extends Context.Service<
  ReleaseAgentWorkerStartup,
  ReleaseAgentWorkerRunning
>()("@knpkv/control-center/server/runtime/ReleaseAgentWorkerStartup") {}

const makeStartup = Effect.fn("ReleaseAgentWorkerStartup.make")(function*(
  options: ReleaseAgentWorkerStartupOptions
) {
  const lifecycle = yield* ServerLifecycle
  const worker = yield* AgentJobWorker
  const idlePollInterval = Duration.fromInputUnsafe(
    options.idlePollInterval ?? DEFAULT_IDLE_POLL_INTERVAL
  )
  const failurePollInterval = Duration.fromInputUnsafe(
    options.failurePollInterval ?? DEFAULT_FAILURE_POLL_INTERVAL
  )
  if (options.runOnceBeforeSupervision === true) {
    yield* worker.runOnce(options.workspaceId).pipe(Effect.orDie)
  }
  const cycle = worker.runOnce(options.workspaceId).pipe(
    Effect.flatMap((result) =>
      result._tag === "idle"
        ? Effect.sleep(idlePollInterval)
        : Effect.yieldNow
    ),
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.failCause(cause)
        : Effect.logError("Release agent worker cycle failed", cause).pipe(
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
  return new ReleaseAgentWorkerRunning({ workspaceId: options.workspaceId })
})

/** Attach one release-chat worker to the server scope and graceful-drain boundary. */
export const releaseAgentWorkerStartupLayer = (
  options: ReleaseAgentWorkerStartupOptions
): Layer.Layer<
  ReleaseAgentWorkerStartup,
  never,
  AgentJobWorker | ServerLifecycle
> => Layer.effect(ReleaseAgentWorkerStartup, makeStartup(options))
