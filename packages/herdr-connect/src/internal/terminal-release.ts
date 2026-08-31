import { Effect, Fiber } from "effect"
import type { KillOptions } from "effect/unstable/process/ChildProcess"

export const terminalKillOptions = {
  forceKillAfter: "1 second"
} satisfies KillOptions

export const releaseTerminalControl = Effect.fn("HerdrTerminal.releaseControl")(function*<
  ReleaseError,
  ExitError,
  KillError,
  ReleaseRequirements,
  ExitRequirements,
  KillRequirements
>(
  release: Effect.Effect<void, ReleaseError, ReleaseRequirements>,
  exitCode: Effect.Effect<unknown, ExitError, ExitRequirements>,
  kill: Effect.Effect<unknown, KillError, KillRequirements>
) {
  const watchdog = yield* Effect.forkChild(
    Effect.sleep("1 second").pipe(
      Effect.andThen(kill),
      Effect.ignore
    ),
    { startImmediately: true, uninterruptible: false }
  )
  yield* release.pipe(
    Effect.ignore,
    Effect.andThen(exitCode),
    Effect.ignore,
    Effect.ensuring(Fiber.interrupt(watchdog))
  )
})
