/**
 * Opens an exact CodeCommit console destination through Granted's `assume`.
 *
 * `assume` is resolved from `PATH`, and it is the only supported way in this TUI
 * to reach the console: it exchanges the named profile for a federated console
 * session, so the destination link lands in an already-authenticated browser tab
 * instead of a sign-in page.
 *
 * Two failures are distinguished deliberately. A missing executable is a
 * prerequisite the user has to install once, and the view answers it with a
 * dialog; anything else is a per-attempt failure reported inline. The
 * distinction is drawn from the spawner's own errno translation rather than from
 * a separate `PATH` probe, because no Effect service exposes the parent
 * environment here (see `ChildEnv`), and because a probe can disagree with the
 * spawn that follows it.
 */
import { ChildEnv } from "@knpkv/codecommit-core"
import { Effect, Schema } from "effect"
import type * as PlatformError from "effect/PlatformError"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { TuiTerminalSession } from "./atoms/applicationScope.js"
import { assumeConsoleArgs } from "./browser-command.js"

export const ConsoleLaunchReason = Schema.Literals(["assume-missing", "assume-failed", "assume-interrupted"])
export type ConsoleLaunchReason = typeof ConsoleLaunchReason.Type

export class ConsoleLaunchError extends Schema.TaggedErrorClass<ConsoleLaunchError>()(
  "ConsoleLaunchError",
  {
    operation: Schema.String,
    reason: ConsoleLaunchReason,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect())
  }
) {}

export interface OpenConsoleInput {
  readonly link: string
  readonly profile: string
  readonly requestId: string
}

export interface OpenConsoleResult {
  readonly link: string
  readonly profile: string
}

const OPERATION = "open-codecommit"

const launchFailure = (reason: ConsoleLaunchReason, message: string, cause?: unknown) =>
  new ConsoleLaunchError({ operation: OPERATION, reason, message, ...(cause === undefined ? {} : { cause }) })

/**
 * Reports whether the spawner failed because no `assume` executable exists.
 *
 * The Node spawner translates a spawn-time `ENOENT` into a `NotFound` system
 * error tagged with the `ChildProcess` module, which is exactly the shape a
 * missing binary produces and is not reachable from a running child.
 */
export const assumeExecutableMissing = (error: PlatformError.PlatformError): boolean =>
  error.reason._tag === "NotFound" && error.reason.module === "ChildProcess" && error.reason.method === "spawn"

/**
 * Reports whether the child was ended by a signal rather than failing to run.
 *
 * The spawner turns a signal exit into an `exitCode` failure, which is the shape
 * Ctrl-C now produces: the child shares the terminal's foreground process group,
 * so the keystroke ends `assume` while the parent's teardown stays bracketed. Any
 * other signal lands here too, so callers must report an unfinished run rather than
 * a specifically benign one — what is known is that it stopped, not why.
 */
export const assumeInterrupted = (error: PlatformError.PlatformError): boolean =>
  error.reason.module === "ChildProcess" && error.reason.method === "exitCode"

/** Deferred so the child starts after the terminal has been handed over, not while the pipeline is built. */
const assumeExitCode = Effect.fn("ConsoleLaunch.exitCode")(function*(command: ChildProcess.Command) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  return yield* Effect.scoped(
    spawner.spawn(command).pipe(
      Effect.flatMap((handle) => handle.exitCode)
    )
  )
})

/**
 * Sequences the best-effort clipboard copy ahead of the launch.
 *
 * The copy is a convenience, not a precondition, so it is discarded rather than
 * sequenced: `copyToClipboard` reports its own failures through a notification,
 * and that reporting step can itself fail on a busy cache. Propagating either
 * one would skip `assume` entirely and surface an untyped failure, which
 * `actionDiagnostic` cannot classify — losing the `assume-missing` prerequisite
 * dialog for the very hosts most likely to lack both tools.
 */
export const openConsoleAfterClipboard = <E, R>(
  copy: Effect.Effect<void, E, R>,
  input: OpenConsoleInput
): Effect.Effect<
  OpenConsoleResult,
  ConsoleLaunchError,
  R | ChildEnv.HostEnvironment | ChildProcessSpawner.ChildProcessSpawner | TuiTerminalSession
> =>
  // `ignoreCause`, not `ignore`: the latter discards only the typed error channel, so a
  // defect in the clipboard path — including inside `copyToClipboard`'s own catch
  // handler — would still short-circuit and produce exactly the unclassifiable failure
  // this exists to prevent.
  Effect.ignoreCause(copy).pipe(Effect.andThen(openAssumeConsole(input)))

/**
 * Runs `assume` for one console destination and waits for it to finish.
 *
 * The terminal is handed over for the duration: an expired SSO session makes
 * `assume` print a verification URL and wait for it, which is invisible and
 * unanswerable while the TUI owns the screen.
 */
export const openAssumeConsole = Effect.fn("ConsoleLaunch.openAssumeConsole")(function*(
  input: OpenConsoleInput
): Effect.fn.Return<
  OpenConsoleResult,
  ConsoleLaunchError,
  ChildEnv.HostEnvironment | ChildProcessSpawner.ChildProcessSpawner | TuiTerminalSession
> {
  const terminalSession = yield* TuiTerminalSession
  const host = yield* ChildEnv.HostEnvironment
  const command = ChildProcess.make("assume", assumeConsoleArgs(input.link, input.profile), {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    // The spawner defaults to a detached process group on POSIX, which would put the
    // child outside the terminal's foreground group so Ctrl-C could only ever reach
    // this process. Keeping it in the group is what lets the keystroke end `assume`
    // while the parent's SIGINT teardown is bracketed. The cost is that scope
    // finalization no longer kills descendants as a group — acceptable here, because
    // the descendant `assume` creates is the user's browser, which must outlive it.
    detached: false,
    // `assume` is resolved from PATH and needs the caller's AWS/SSO env, so the
    // flag must be merged into the inherited environment. The profile argument
    // stays authoritative only if ambient AWS credentials are dropped.
    env: ChildEnv.profileScopedEnv(host.variables, { GRANTED_ALIAS_CONFIGURED: "true" }),
    extendEnv: true
  })

  const exitCode = yield* terminalSession.suspend.pipe(
    Effect.andThen(assumeExitCode(command)),
    Effect.ensuring(terminalSession.resume),
    Effect.mapError((cause) =>
      assumeExecutableMissing(cause)
        ? launchFailure("assume-missing", "Granted's assume executable was not found on PATH", cause)
        : assumeInterrupted(cause)
        // Any signal ends the run here, not just the user's Ctrl-C, so the wording stays
        // true for a crash as well: what is known is that it stopped before finishing.
        ? launchFailure("assume-interrupted", "Console sign-in ended before completing", cause)
        : launchFailure("assume-failed", "Unable to start assume", cause)
    )
  )
  if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
    return yield* launchFailure("assume-failed", `assume exited with status ${exitCode}`)
  }
  return { link: input.link, profile: input.profile }
})
