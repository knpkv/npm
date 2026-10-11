// Fixtures from packages/codecommit-core/test/StatsService.test.ts.
import { HealthCard } from "@knpkv/codecommit-web-design-system"
import { contributorStats, emptyStats, healthStats } from "../fixtures/stats.js"

/** Eight of ten reviewed; six approved. */
export const Coverage = () => <HealthCard data={healthStats} />
/** Three contributors, with half the work from the top contributor. */
export const ContributorShare = () => <HealthCard data={contributorStats} />
/** No pull requests means unavailable ratios, rather than zero percent. */
export const EmptyWeek = () => <HealthCard data={emptyStats} />
