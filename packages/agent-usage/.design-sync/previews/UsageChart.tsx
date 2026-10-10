// Fixtures from stories/fixtures/week.ts (the CurrentScreen stories' week).
import { UsageChart } from "@knpkv/agent-usage-design-system"
import { Page } from "../fixtures/page.js"
import { viewOf } from "../fixtures/view.js"

/** Cost per day for the week, stacked by booking. */
export const CostByBooking = () => {
  const view = viewOf("binding")
  return (
    <Page>
      <UsageChart
        label={`Usage per ${view.range.bucket}, stacked by booking`}
        labelOf={view.labelOf}
        measure="cost"
        periods={view.week.usage.periods}
        range={view.range}
        slots={view.slots}
        stacked={view.stacked}
      />
    </Page>
  )
}

/** A week with no usage recorded. */
export const Empty = () => {
  const view = viewOf("empty")
  return (
    <Page>
      <UsageChart
        label={`Usage per ${view.range.bucket}, stacked by booking`}
        labelOf={view.labelOf}
        measure="cost"
        periods={view.week.usage.periods}
        range={view.range}
        slots={view.slots}
        stacked={view.stacked}
      />
    </Page>
  )
}
