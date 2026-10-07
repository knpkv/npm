/**
 * Timer commands: start, stop, status, edit, discard, log.
 *
 * @module
 */
import { Command } from "effect/cli"
import * as Console from "effect/Console"
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
  Command.withDescription("Track time on a Jira issue"),
  Command.withSubcommands([
    start.pipe(Command.withDescription("Start a timer on a Jira issue, in Clockify")),
    stop.pipe(Command.withDescription("Stop the timer and save the time to Clockify and a Jira worklog")),
    discard.pipe(Command.withDescription("Discard the running timer and delete its Clockify entry")),
    statusCmd.pipe(Command.withDescription("Show the running timer")),
    log.pipe(Command.withDescription("Log time you already spent on a Jira issue")),
    edit.pipe(Command.withDescription("Change the running timer's start time or issue"))
  ])
)
