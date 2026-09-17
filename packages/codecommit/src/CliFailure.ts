/**
 * One-line failure reporting for the plain CLI.
 *
 * Shared by every subcommand rather than owned by one, because the shape of a
 * CLI failure is a property of the entrypoint, not of the command that hit it.
 *
 * @category Errors
 * @module
 */
import { Console, Data, Effect, Runtime } from "effect"

/**
 * A failure that has already been explained to the user in one line.
 *
 * `runMain` renders any unhandled failure as a pretty Cause with a stack trace,
 * which is the wrong shape for a keybinding: the caller sees this inside a popup
 * and wants a sentence. `errorReported = false` says the error has already been
 * reported by application code, which suppresses that second rendering and
 * leaves the non-zero exit code alone.
 */
export class ReportedFailure extends Data.TaggedError("ReportedFailure") {
  override readonly [Runtime.errorReported] = false
}

/** Prints one line to stderr and fails without letting the runtime re-render it. */
export const reportFailure = (message: string): Effect.Effect<never, ReportedFailure> =>
  Console.error(message).pipe(Effect.andThen(new ReportedFailure()))
