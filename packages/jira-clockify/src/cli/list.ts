/**
 * List command — display Jira tickets.
 *
 * @module
 */
import { Command, Options } from "@effect/cli"
import { Console, Effect, SubscriptionRef } from "effect"
import { TicketService } from "../services/TicketService.js"

/** `list` command — prints assigned tickets. */
export const list = Command.make(
  "list",
  { json: Options.boolean("json").pipe(Options.withDefault(false)) },
  ({ json }) =>
    Effect.gen(function*() {
      const ticketService = yield* TicketService
      yield* ticketService.refresh
      yield* Effect.sleep("600 millis")

      const { tickets } = yield* SubscriptionRef.get(ticketService.state)

      if (json) {
        yield* Console.log(JSON.stringify(tickets, null, 2))
      } else {
        for (const t of tickets) {
          yield* Console.log(`${t.key.padEnd(12)} ${t.summary.slice(0, 50).padEnd(50)} ${t.status}`)
        }
        if (tickets.length === 0) {
          yield* Console.log("No tickets found")
        }
      }
    })
)
