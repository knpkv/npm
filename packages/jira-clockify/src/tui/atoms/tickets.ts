/**
 * Jotai atom for Jira ticket state, bridged from {@link TicketService} SubscriptionRef.
 *
 * @internal
 */
import { Effect } from "effect"
import { TicketService } from "../../services/TicketService.js"
import { runtimeAtom } from "./runtime.js"

export const ticketsAtom = runtimeAtom.subscriptionRef(
  Effect.gen(function*() {
    const service = yield* TicketService
    return service.state
  })
)

export const refreshAtom = runtimeAtom.fn(
  Effect.fnUntraced(function*() {
    const service = yield* TicketService
    yield* service.refresh
  })
)
