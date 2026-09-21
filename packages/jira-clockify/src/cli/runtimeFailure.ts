/**
 * Report a command failure once before the process runtime takes over.
 *
 * Commands that already rendered a user-facing diagnostic mark their error as already reported.
 * Everything else gets one concise stderr line, while the original failure remains in the channel
 * so the process still exits non-zero.
 */
import { Cause, Console, Effect, Runtime } from "effect"

export const reportUnhandled = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.tapCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.void
      if (!Runtime.getErrorReported(Cause.squash(cause))) return Effect.void
      const error = Cause.prettyErrors(cause)[0]
      return Console.error(error?.message ?? "Command failed without an error message.")
    })
  )
