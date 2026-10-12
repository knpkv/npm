// Fixtures from packages/codecommit-web/test/queue-controls-view.test.ts and test/pr-list-view.test.ts.
// No pull-request activity renders null, so the empty fixture has no card.
import { RecentActivityView } from "@knpkv/codecommit-web-design-system"
import { now } from "../fixtures/pull-requests.js"
import { notifications } from "../fixtures/queue-controls.js"

/** Recent feedback links to its complete account, repository and region. */
export const Feedback = () => <RecentActivityView notifications={notifications} now={new Date(now)} />
/** Incomplete coordinates use fallback text without a pull-request link. */
export const MissingCoordinates = () => <RecentActivityView notifications={notifications.map((item) => ({ ...item, title: "", repositoryName: "", type: "unknown_event" }))} now={new Date(now)} />
/** A longer feed is capped at five visible items. */
export const FiveItems = () => <RecentActivityView notifications={[1, 2, 3, 4, 5, 6].flatMap((id) => notifications.map((item) => ({ ...item, id })))} now={new Date(now)} />
