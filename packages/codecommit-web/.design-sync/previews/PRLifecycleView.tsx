// Fixtures from packages/codecommit-web/test/pr-lifecycle-view.test.ts and test/pr-view-fixtures.ts.
// Unmerged fixtures render null while comments load or when no review evidence exists; those cards are omitted.
import { PRLifecycleView } from "@knpkv/codecommit-web-design-system"
import { emptyComments, feedbackComments, now, pagePullRequest } from "../fixtures/pull-requests.js"

const hour = 3_600_000
const day = 86_400_000
/** One day to merge, two hours to review and one hour to address feedback. */
export const Merged = () => <dl><PRLifecycleView pr={pagePullRequest({ status: "MERGED", lastModifiedDate: new Date(now - day - 3.5 * hour) })} comments={feedbackComments} /></dl>
/** Known non-author sign-off supplies the four-hour review fallback. */
export const ApprovalFallback = () => <dl><PRLifecycleView pr={pagePullRequest({ approvedBy: ["reviewer"], lastModifiedDate: new Date(now - 2 * day + 0.5 * hour) })} comments={emptyComments} /></dl>
