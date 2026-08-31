import { Effect, Fiber, Option, Scope } from "effect"
import type { KillOptions } from "effect/unstable/process/ChildProcess"

export const terminalKillOptions = {
  forceKillAfter: "1 second"
} satisfies KillOptions

export const terminalReleaseKillOptions = { killSignal: "SIGKILL" } satisfies KillOptions

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
  yield* Effect.acquireUseRelease(
    Scope.make(),
    (releaseScope) =>
      Effect.gen(function*() {
        const releaseFiber = yield* Effect.forkIn(
          release.pipe(
            Effect.ignore,
            Effect.andThen(exitCode),
            Effect.ignore
          ),
          releaseScope
        )
        const released = yield* Fiber.await(releaseFiber).pipe(
          Effect.timeoutOption(terminalKillOptions.forceKillAfter)
        )
        if (Option.isNone(released)) {
          yield* Fiber.interrupt(releaseFiber)
          yield* kill.pipe(Effect.ignore)
        }
      }),
    (releaseScope, exit) => Scope.close(releaseScope, exit)
  )
})
