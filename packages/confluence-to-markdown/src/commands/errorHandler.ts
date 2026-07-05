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
import * as Predicate from "effect/Predicate"
import { writeStderr } from "../internal/stdio.js"

const safeStringify = (value: unknown): string | null => {
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

const formatUnknownError = (error: unknown): string => {
  if (Predicate.hasProperty(error, "message")) {
    return String(error.message)
  }
  if (error !== null && typeof error === "object") {
    const tag = Predicate.hasProperty(error, "_tag") ? `${String(error._tag)}: ` : ""
    const props = Object.fromEntries(
      Object.getOwnPropertyNames(error).map((key) => [key, (error as Record<string, unknown>)[key]])
    )
    return `${tag}${safeStringify(Object.keys(props).length > 0 ? props : error) ?? String(error)}`
  }
  return String(error)
}

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
        const formatted = formatUnknownError(error)
        yield* writeStderr(`${formatted === "{}" ? Cause.pretty(cause) : formatted}\n`)
      } else if (Cause.isDieReason(reason)) {
        const defect = reason.defect
        if (Predicate.isError(defect)) {
          yield* writeStderr(`Error: ${defect.message}\n`)
        } else {
          yield* writeStderr(`Error: ${String(defect)}\n`)
        }
      } else {
        yield* writeStderr("Interrupted\n")
      }
    }
  })
