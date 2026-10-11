// Fixtures from packages/codecommit-web/test/stats-page.test.ts.
import { MostActivePRs } from "@knpkv/codecommit-web-design-system"
import { activePRs, noop } from "../fixtures/stats.js"

/** Same pull-request number, two region-specific rows. */
export const TwoRegions = () => <MostActivePRs prs={activePRs} onPRClick={noop} />
/** One regional row. */
export const OneRegion = () => <MostActivePRs prs={activePRs.slice(0, 1)} onPRClick={noop} />
