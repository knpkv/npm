// Fixtures from stories/fixtures/week.ts (the CurrentScreen stories' week).
import { BookingTable } from "@knpkv/agent-usage-design-system"
import { Page } from "../fixtures/page.js"
import { viewOf } from "../fixtures/view.js"

const noop = () => undefined

/** The week's bookings, each with its series colour, cost and tokens. */
export const Bookings = () => {
  const view = viewOf("binding")
  return (
    <Page>
      <BookingTable
        bookings={view.week.usage.bookings}
        named={view.named}
        onSelect={noop}
        selected={null}
        slots={view.slots}
      />
    </Page>
  )
}
