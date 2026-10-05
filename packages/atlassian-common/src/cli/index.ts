/**
 * How an Atlassian command-line tool reports a failed run.
 *
 * **Mental model**
 *
 * - **The message is the report.** A failure prints its message; a defect prints `Error: <message>`;
 *   an interruption prints `Interrupted`. The full cause, with stack traces, is for whoever asked for
 *   it: `--verbose`, or `DEBUG=1` in the environment.
 * - **What the CLI already showed is not repeated.** `Command.runWith` renders help and usage errors
 *   itself and then fails with them, so those reasons are skipped unless verbose.
 * - **The exit code is untouched.** The cause is reported and re-failed as it was, so a help request
 *   still exits 0 and every failure still exits non-zero.
 *
 * @module
 */
import * as Cause from "effect/Cause"
import { CliError, Flag, GlobalFlag } from "effect/cli"
import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Stdio from "effect/Stdio"

/** `--verbose`: print the full cause, with stack traces, when a command fails. Register on the root command. */
export const Verbose = GlobalFlag.Setting("verbose")({
  flag: Flag.Boolean("verbose").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Print the full cause, with stack traces, when a command fails")
  )
})

const truthy = new Set(["true", "1", "y", "yes", "on"])
const falsy = new Set(["false", "0", "n", "no", "off"])

/**
 * Whether `args` turn {@link Verbose} on, read the way the flag parses: only tokens before `--`, the last
 * of `--verbose`, `--no-verbose` and `--verbose=<boolean>` wins.
 */
export const verboseFlagIn = (args: ReadonlyArray<string>): boolean => {
  const end = args.indexOf("--")
  let verbose = false
  for (const token of end === -1 ? args : args.slice(0, end)) {
    if (token === "--verbose") verbose = true
    else if (token === "--no-verbose") verbose = false
    else if (token.startsWith("--verbose=")) {
      const value = token.slice("--verbose=".length).toLowerCase()
      if (truthy.has(value)) verbose = true
      else if (falsy.has(value)) verbose = false
    }
  }
  return verbose
}

const isVerboseToken = (token: string): boolean =>
  token === "--verbose" || token === "--no-verbose" || token.startsWith("--verbose=")

/**
 * `args` without the {@link Verbose} flag (before `--`), for code that routes on the command words
 * before the CLI parses them, such as choosing which service layer to build.
 */
export const commandArgs = (args: ReadonlyArray<string>): ReadonlyArray<string> => {
  const end = args.indexOf("--")
  const head = end === -1 ? args : args.slice(0, end)
  const tail = end === -1 ? [] : args.slice(end)
  return [...head.filter((token) => !isVerboseToken(token)), ...tail]
}

/** `--verbose` in `args`, or `DEBUG=1`. Only `1`: `DEBUG` is also the debug package's namespace list. */
export const verboseRequested = (args: ReadonlyArray<string>): Effect.Effect<boolean> =>
  verboseFlagIn(args)
    ? Effect.succeed(true)
    : Effect.gen(function*() {
      const debug = yield* Config.option(Config.String("DEBUG"))
      return Option.getOrUndefined(debug) === "1"
    }).pipe(Effect.orElseSucceed(() => false))

const describe = <E>(error: E): string => {
  if (Predicate.hasProperty(error, "message") && Predicate.isString(error.message) && error.message !== "") {
    return error.message
  }
  if (Predicate.hasProperty(error, "_tag") && Predicate.isString(error._tag)) return error._tag
  return String(error)
}

/** Print a failed run's cause to stderr: each failure's message, or the full cause when verbose. */
export const handleCliError = <E>(cause: Cause.Cause<E>, options: { readonly verbose: boolean }): Effect.Effect<void> =>
  options.verbose
    ? Console.error(Cause.pretty(cause))
    : Effect.forEach(cause.reasons, (reason) => {
      if (Cause.isFailReason(reason)) {
        return CliError.isCliError(reason.error) ? Effect.void : Console.error(describe(reason.error))
      }
      if (Cause.isDieReason(reason)) return Console.error(`Error: ${describe(reason.defect)}`)
      return Console.error("Interrupted")
    }, { discard: true })

const reportFailure = <E>(cause: Cause.Cause<E>): Effect.Effect<void, never, Stdio.Stdio> =>
  Effect.gen(function*() {
    const stdio = yield* Stdio.Stdio
    const verbose = yield* stdio.args.pipe(Effect.flatMap(verboseRequested), Effect.orElseSucceed(() => false))
    yield* handleCliError(cause, { verbose })
  })

/**
 * Report a CLI program's failure with {@link handleCliError} and fail with the same cause. Apply it
 * before providing `Stdio`, which it reads the arguments from.
 */
export const withCliErrorHandling = <A, E, R>(
  program: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R | Stdio.Stdio> =>
  program.pipe(Effect.catchCause((cause) => reportFailure(cause).pipe(Effect.andThen(Effect.failCause(cause)))))
