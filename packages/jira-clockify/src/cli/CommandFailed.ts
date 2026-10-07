/**
 * A command that could not do its job, with the one line that says why and what to run.
 *
 * Fail with it instead of printing and returning: the command boundary (`reportUnhandled`) prints
 * the message once on stderr, and the process exits non-zero so a script can tell.
 *
 * @module
 */
import { Data, Effect, Option, Stdio } from "effect"
import { JiraAccess } from "../services/JiraAccess.js"
import { NOT_LOGGED_IN_HINT } from "../utils/hints.js"

export class CommandFailed extends Data.TaggedError("CommandFailed")<{ readonly message: string }> {}

/** Fails unless Jira is connected, naming the command that connects it. */
export const requireJira = JiraAccess.use((access) => access.connection).pipe(
  Effect.mapError((error) => new CommandFailed({ message: error.message })),
  Effect.flatMap(Option.match({
    onNone: () => Effect.fail(new CommandFailed({ message: NOT_LOGGED_IN_HINT })),
    onSome: Effect.succeed
  }))
)

/** Fails before a prompt when nobody can answer it, saying what to run instead. */
export const requireTerminal = (instead: string) =>
  Stdio.Stdio.use((stdio) => stdio.stdinIsTerminal).pipe(
    Effect.flatMap((terminal) =>
      terminal
        ? Effect.void
        : Effect.fail(new CommandFailed({ message: `This step needs an interactive terminal. ${instead}` }))
    )
  )

/** Any failure with a message, as the one line the command prints. */
export const toCommandFailed = (error: { readonly message: string }): CommandFailed =>
  new CommandFailed({ message: error.message })
