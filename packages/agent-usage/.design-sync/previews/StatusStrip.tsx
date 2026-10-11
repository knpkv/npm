// Fixtures from stories/fixtures/week.ts and the Status story in stories/CurrentScreen.stories.tsx.
import { StatusStrip } from "@knpkv/agent-usage-design-system"
import { Page } from "../fixtures/page.js"
import { healthyStatus, viewOf } from "../fixtures/view.js"

/** Ingest and limits are healthy. */
export const Healthy = () => {
  const { week } = viewOf("binding")
  return (
    <Page>
      <StatusStrip ignoredKeys={week.usage.ignoredKeys} now={week.now} status={healthyStatus} />
    </Page>
  )
}
