// Fixtures from stories/fixtures/week.ts (the CurrentScreen stories' week).
import { LimitsSummary } from "@knpkv/agent-usage-design-system"
import { Page } from "../fixtures/page.js"
import { viewOf } from "../fixtures/view.js"

const summary = (scenario: Parameters<typeof viewOf>[0]) => {
  const { week } = viewOf(scenario)
  return (
    <Page>
      <LimitsSummary balances={week.limits.balances} latest={week.limits.latest} now={week.now} />
    </Page>
  )
}

/** One limit is the binding one: it says which, and how close. */
export const Binding = () => summary("binding")
/** A limit is reached. */
export const AtLimit = () => summary("at-limit")
/** Every limit has room. */
export const Clear = () => summary("clear")
/** No readings yet. */
export const Empty = () => summary("empty")
