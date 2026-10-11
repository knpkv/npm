// Fixtures from packages/codecommit-web/test/stats-page.test.ts.
import { StalePRs } from "@knpkv/codecommit-web-design-system"
import { noop, stalePRs } from "../fixtures/stats.js"

/** Both regional pull requests have eight days without activity. */
export const TwoRegions = () => <StalePRs prs={stalePRs} onPRClick={noop} />
/** One regional stale pull request. */
export const OneRegion = () => <StalePRs prs={stalePRs.slice(0, 1)} onPRClick={noop} />
