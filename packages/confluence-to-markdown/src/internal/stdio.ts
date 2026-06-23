/**
 * Standard output helpers backed by the Effect Stdio service.
 *
 * @module
 * @internal
 */
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import type * as PlatformError from "effect/PlatformError"
import * as Terminal from "effect/Terminal"

export const writeStdout = (
  message: string
): Effect.Effect<void, PlatformError.PlatformError, Terminal.Terminal> =>
  Effect.gen(function*() {
    const terminal = yield* Terminal.Terminal
    yield* terminal.display(message)
  })

export const writeStderr = (
  message: string
): Effect.Effect<void> => Console.error(message)
