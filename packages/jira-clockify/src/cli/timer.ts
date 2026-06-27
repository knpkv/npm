/**
 * Timer commands: start, stop, status, edit, discard, log.
 *
 * @module
 */
import * as Console from "effect/Console"
import { Command } from "effect/unstable/cli"
import { discard, edit, log, start, statusCmd, stop } from "./timer/index.js"

export { discard, edit, log, start, statusCmd, stop } from "./timer/index.js"

export const timer = Command.make(
  "timer",
  {},
  () => Console.log("Usage: jcf timer <start|stop|discard|status|log|edit>")
).pipe(
  Command.withDescription("Timer commands for Jira-backed Clockify work"),
  Command.withSubcommands([start, stop, discard, statusCmd, log, edit])
)
