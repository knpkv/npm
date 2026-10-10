// Fixtures from stories/fixtures/week.ts (the CurrentScreen stories' week).
import { TokenUsageChart } from "@knpkv/agent-usage-design-system"
import { Page } from "../fixtures/page.js"
import { viewOf } from "../fixtures/view.js"

/** Tokens per day for the week, stacked by booking: the measure is fixed to tokens. */
export const TokensByBooking = () => {
  const view = viewOf("binding")
  return (
    <Page>
      <TokenUsageChart
        label={`Tokens per ${view.range.bucket}, stacked by booking`}
        labelOf={view.labelOf}
        periods={view.week.usage.periods}
        range={view.range}
        slots={view.slots}
        stacked={view.tokens}
      />
    </Page>
  )
}
