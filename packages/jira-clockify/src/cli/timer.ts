/**
 * Timer commands: start, stop, status, edit, discard, log.
 *
 * @module
 */
import * as Console from "effect/Console"
import { Command } from "effect/unstable/cli"
import { discard, edit, log, start, statusCmd, stop } from "./timer/index.js"

export { discard, edit, log, start, statusCmd, stop } from "./timer/index.js"

type TimerSubcommand = typeof start | typeof stop | typeof discard | typeof statusCmd | typeof log | typeof edit

export const timer: Command.Command<
  "timer",
  {},
  {},
  Command.Error<TimerSubcommand>,
  Command.Services<TimerSubcommand>
> = Command.make(
  "timer",
  {},
  () => Console.log("Usage: jcf timer <start|stop|discard|status|log|edit>")
).pipe(
  Command.withDescription("Timer commands for Jira-backed Clockify work"),
  Command.withSubcommands([start, stop, discard, statusCmd, log, edit])
)
