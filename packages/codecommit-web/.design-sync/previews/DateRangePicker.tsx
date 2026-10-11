// Fixtures from packages/codecommit-core/test/StatsService.test.ts.
import { DateRangePicker } from "@knpkv/codecommit-web-design-system"

const noop = () => {}
/** The lifecycle fixture's complete date range. */
export const SelectedRange = () => <DateRangePicker from="2026-01-01" to="2026-01-02" onChange={noop} />
/** No date filter is applied. */
export const Unbounded = () => <DateRangePicker from={undefined} to={undefined} onChange={noop} />
/** Only the lower bound is selected. */
export const FromOnly = () => <DateRangePicker from="2026-01-01" to={undefined} onChange={noop} />
