/**
 * Effect-idiomatic error handler — uses Cause.pretty for structured failure output.
 *
 * @internal
 */
import * as Cause from "effect/Cause"
import * as Console from "effect/Console"
import type * as Effect from "effect/Effect"

/**
 * Handle errors from CLI execution.
 * Logs the pretty-printed cause to stderr via Console.error.
 */
export const handleError = <E>(cause: Cause.Cause<E>): Effect.Effect<void> => Console.error(Cause.pretty(cause))
