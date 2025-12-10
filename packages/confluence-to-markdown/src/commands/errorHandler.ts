/**
 * CLI error handler.
 *
 * We use custom error handling instead of built-in options because:
 * - Cause.pretty() includes stack traces which are noisy for CLI users
 * - Logger.pretty is for logging, not error output
 * - NodeRuntime.runMain error reporting shows full cause structure
 */
import * as Cause from "effect/Cause"

/**
 * Print errors to stderr without stack traces.
 */
export const handleError = <E>(cause: Cause.Cause<E>): void => {
  if (Cause.isEmpty(cause)) return

  for (const error of Cause.failures(cause)) {
    if (error && typeof error === "object" && "message" in error) {
      process.stderr.write(`${(error as { message: string }).message}\n`)
    } else {
      process.stderr.write(`${String(error)}\n`)
    }
  }

  for (const defect of Cause.defects(cause)) {
    if (defect instanceof Error) {
      process.stderr.write(`Error: ${defect.message}\n`)
    } else {
      process.stderr.write(`Error: ${String(defect)}\n`)
    }
  }
}
