/** Run bounded workspace retention at startup and under lifecycle supervision. @module */
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import type { WorkspaceId } from "../../domain/identifiers.js"
import { Persistence } from "../persistence/Persistence.js"
import { ControlCenterBootstrap } from "./Bootstrap.js"
import { ServerLifecycle } from "./ServerLifecycle.js"

const DEFAULT_RETENTION_INTERVAL = Duration.hours(24)

/** Server-owned retention scheduling policy. */
export interface RetentionStartupOptions {
  readonly workspaceId: WorkspaceId
  readonly interval?: Duration.Input
}

/** Diagnostic state proving retention is attached to the configured workspace. */
export class RetentionRunning extends Data.TaggedClass("running")<{
  readonly workspaceId: WorkspaceId
}> {}

/** Startup state retained by the server layer. */
export class RetentionStartup extends Context.Service<
  RetentionStartup,
  RetentionRunning
>()("@knpkv/control-center/server/runtime/RetentionStartup") {}

const makeStartup = Effect.fn("RetentionStartup.make")(function*(
  options: RetentionStartupOptions
) {
  const lifecycle = yield* ServerLifecycle
  const persistence = yield* Persistence
  yield* ControlCenterBootstrap
  const runOnce = persistence.retention.sweepWorkspace(options.workspaceId).pipe(
    Effect.asVoid,
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.failCause(cause)
        : Effect.logError("Workspace retention sweep failed", cause)
    )
  )
  yield* lifecycle.runBackground(runOnce).pipe(
    Effect.catch(() => Effect.void)
  )
  const interval = Duration.fromInputUnsafe(options.interval ?? DEFAULT_RETENTION_INTERVAL)
  const supervise = lifecycle.runBackground(
    Effect.raceFirst(
      lifecycle.awaitDrain,
      Effect.forever(Effect.sleep(interval).pipe(Effect.andThen(runOnce)))
    )
  ).pipe(
    Effect.catch(() => Effect.void)
  )
  yield* Effect.forkScoped(supervise)
  return new RetentionRunning({ workspaceId: options.workspaceId })
})

/** Attach bounded retention to startup and graceful drain. */
export const retentionStartupLayer = (
  options: RetentionStartupOptions
): Layer.Layer<
  RetentionStartup,
  never,
  ControlCenterBootstrap | Persistence | ServerLifecycle
> => Layer.effect(RetentionStartup, makeStartup(options))
