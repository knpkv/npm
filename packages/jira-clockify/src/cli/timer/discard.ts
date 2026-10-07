/**
 * Timer `discard` command.
 *
 * @module
 */
import { Console, Effect, SubscriptionRef } from "effect"
import { Command, Prompt } from "effect/cli"
import { TimerService } from "../../services/TimerService.js"
import { toCommandFailed } from "../CommandFailed.js"

export const discard = Command.make(
  "discard",
  {},
  () =>
    Effect.gen(function*() {
      const timer = yield* TimerService
      yield* timer.detectRunning

      const current = yield* SubscriptionRef.get(timer.state)
      if (!current.active) {
        yield* Console.log("No active timer to discard.")
        return
      }

      yield* Console.log(`Discard timer: ${current.ticketKey} — ${current.summary ?? ""}?`)
      yield* Console.log("This will delete the Clockify entry. No Jira worklog will be created.")

      const confirm = yield* Prompt.Select({
        message: "Are you sure?",
        choices: [
          { title: "Yes, discard", value: true },
          { title: "Cancel", value: false }
        ]
      })

      if (!confirm) {
        yield* Console.log("Cancelled.")
        return
      }

      yield* timer.discard.pipe(Effect.mapError(toCommandFailed))

      yield* Console.log("Timer discarded. Clockify entry deleted.")
    })
)
