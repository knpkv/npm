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
const DEFAULT_RETENTION_FAILURE_INTERVAL = Duration.minutes(5)

/** Server-owned retention scheduling policy. */
export interface RetentionStartupOptions {
  readonly workspaceId: WorkspaceId
  readonly interval?: Duration.Input
  readonly failureInterval?: Duration.Input
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
  const interval = Duration.fromInputUnsafe(options.interval ?? DEFAULT_RETENTION_INTERVAL)
  const failureInterval = Duration.fromInputUnsafe(
    options.failureInterval ?? DEFAULT_RETENTION_FAILURE_INTERVAL
  )
  const cycle = persistence.retention.sweepWorkspace(options.workspaceId).pipe(
    Effect.as(interval),
    // eslint-disable-next-line local-rules/require-exact-cause-rethrow -- This lifecycle supervisor logs defects and continues; retention-startup.test.ts covers retry and scoped interruption.
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.failCause(cause)
        : Effect.logError("Workspace retention sweep failed", cause).pipe(
          Effect.as(failureInterval)
        )
    )
  )
  const firstPollInterval = yield* lifecycle.runBackground(cycle).pipe(
    Effect.catch(() => Effect.succeed(null))
  )
  const supervise = Effect.gen(function*() {
    let nextPollInterval = firstPollInterval
    while (true) {
      if (nextPollInterval === null) return
      const drainStarted = yield* Effect.raceFirst(
        lifecycle.awaitDrain.pipe(Effect.as(true)),
        Effect.sleep(nextPollInterval).pipe(Effect.as(false))
      )
      if (drainStarted) return
      nextPollInterval = yield* lifecycle.runBackground(cycle)
    }
  }).pipe(
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
