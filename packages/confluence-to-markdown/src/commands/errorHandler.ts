/**
 * CLI error handler.
 *
 * We use custom error handling instead of built-in options because:
 * - Cause.pretty() includes stack traces which are noisy for CLI users
 * - Logger.pretty is for logging, not error output
 * - NodeRuntime.runMain error reporting shows full cause structure
 */
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import { writeStderr } from "../internal/stdio.js"

/**
 * Print errors to stderr without stack traces.
 */
export const handleError = <E>(
  cause: Cause.Cause<E>
): Effect.Effect<void> =>
  Effect.gen(function*() {
    for (const reason of cause.reasons) {
      if (Cause.isFailReason(reason)) {
        const error = reason.error
        if (error && typeof error === "object" && "message" in error) {
          yield* writeStderr(`${(error as { message: string }).message}\n`)
        } else {
          yield* writeStderr(`${String(error)}\n`)
        }
      } else if (Cause.isDieReason(reason)) {
        const defect = reason.defect
        if (defect instanceof Error) {
          yield* writeStderr(`Error: ${defect.message}\n`)
        } else {
          yield* writeStderr(`Error: ${String(defect)}\n`)
        }
      } else {
        yield* writeStderr("Interrupted\n")
      }
    }
  })
