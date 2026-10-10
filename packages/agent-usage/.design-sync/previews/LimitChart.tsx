// Fixtures from stories/fixtures/week.ts (the CurrentScreen stories' week).
import { LimitChart } from "@knpkv/agent-usage-design-system"
import { Page } from "../fixtures/page.js"
import { viewOf } from "../fixtures/view.js"

const chart = (scenario: Parameters<typeof viewOf>[0]) => {
  const view = viewOf(scenario)
  return (
    <Page>
      <LimitChart now={view.week.now} range={view.range} series={view.week.limits.series} />
    </Page>
  )
}

/** Limits over the week, one of them binding. */
export const Binding = () => chart("binding")
/** A limit reached during the week. */
export const AtLimit = () => chart("at-limit")
