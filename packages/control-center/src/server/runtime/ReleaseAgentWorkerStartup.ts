/** Supervise durable release-chat agent jobs for one configured workspace. @module */
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import type { WorkspaceId } from "../../domain/identifiers.js"
import { AgentJobWorker } from "../agent/AgentJobWorker.js"
import { superviseAgentJobWorker } from "./internal/superviseAgentJobWorker.js"
import { ServerLifecycle } from "./ServerLifecycle.js"

const DEFAULT_IDLE_POLL_INTERVAL = Duration.seconds(1)
const DEFAULT_FAILURE_POLL_INTERVAL = Duration.seconds(5)

/** Bounded release-chat polling policy owned by the server composition. */
export interface ReleaseAgentWorkerStartupOptions {
  readonly workspaceId: WorkspaceId
  readonly idlePollInterval?: Duration.Input
  readonly failurePollInterval?: Duration.Input
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
  yield* superviseAgentJobWorker({
    failurePollInterval,
    idlePollInterval,
    lifecycle,
    logLabel: "Release agent worker",
    worker,
    workspaceId: options.workspaceId
  })
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
