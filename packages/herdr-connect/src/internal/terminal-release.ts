import { Effect } from "effect"

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
  yield* release.pipe(
    Effect.timeoutOrElse({
      duration: "1 second",
      orElse: () => kill
    }),
    Effect.ignore
  )
  yield* exitCode.pipe(
    Effect.timeoutOrElse({
      duration: "1 second",
      orElse: () => kill
    }),
    Effect.ignore
  )
})
