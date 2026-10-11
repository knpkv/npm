// Fixtures from packages/codecommit-core/test/StatsService.test.ts.
import { KPICard } from "@knpkv/codecommit-web-design-system"

const PullRequestIcon = ({ className }: { className?: string }) => <svg aria-hidden="true" className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="6" cy="5" r="3" /><circle cx="6" cy="19" r="3" /><circle cx="18" cy="19" r="3" /><path d="M6 8v8M18 16V7a2 2 0 0 0-2-2h-3m0 0 3-3m-3 3 3 3" /></svg>
const noop = () => {}
/** Five pull requests were created in the tested volume fixture. */
export const Created = () => <KPICard label="PRs Created" value={5} icon={PullRequestIcon} onClick={noop} />
/** No pull requests in an empty reporting week. */
export const EmptyWeek = () => <KPICard label="PRs Created" value={0} icon={PullRequestIcon} />
/** The tested merged count. */
export const Merged = () => <KPICard label="PRs Merged" value={3} icon={PullRequestIcon} onClick={noop} />
