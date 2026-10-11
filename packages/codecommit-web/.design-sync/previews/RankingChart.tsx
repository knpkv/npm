// Fixtures from packages/codecommit-core/test/StatsService.test.ts.
import { RankingChart } from "@knpkv/codecommit-web-design-system"
import { contributors, noop } from "../fixtures/stats.js"

/** The tested contributor ranking. */
export const Contributors = () => <RankingChart data={contributors} labelKey="author" valueKey="prCount" title="Top Contributors" onItemClick={noop} />
/** No contributors in the reporting week. */
export const Empty = () => <RankingChart data={[]} labelKey="author" valueKey="prCount" title="Top Contributors" />
