/**
 * List command — display Jira tickets.
 *
 * @module
 */
import { Console, Effect, SubscriptionRef } from "effect"
import { Command, Flag as Options } from "effect/cli"
import { TicketService } from "../services/TicketService.js"
import { CommandFailed, requireJira } from "./CommandFailed.js"

/** `list` command — prints assigned tickets. */
export const list = Command.make(
  "list",
  {
    json: Options.Boolean("json").pipe(Options.withDescription("Print the issues as JSON"), Options.withDefault(false))
  },
  ({ json }) =>
    Effect.gen(function*() {
      yield* requireJira
      const ticketService = yield* TicketService
      yield* ticketService.refresh.pipe(Effect.mapError((error) => new CommandFailed({ message: error.message })))
      yield* Effect.sleep("600 millis")

      const { error, tickets } = yield* SubscriptionRef.get(ticketService.state)
      if (error !== null) return yield* new CommandFailed({ message: `Could not read Jira issues: ${error}` })

      if (json) {
        yield* Console.log(JSON.stringify(tickets, null, 2))
      } else {
        for (const t of tickets) {
          yield* Console.log(`${t.key.padEnd(12)} ${t.summary.slice(0, 50).padEnd(50)} ${t.status}`)
        }
        if (tickets.length === 0) {
          yield* Console.log("No open Jira issues are assigned to you.")
        }
      }
    })
)

export const issue = Command.make("issue", {}, () => Console.log("Usage: jcf issue list")).pipe(
  Command.withDescription("List your Jira issues"),
  Command.withSubcommands([list.pipe(Command.withDescription("List the Jira issues your query finds"))])
)
