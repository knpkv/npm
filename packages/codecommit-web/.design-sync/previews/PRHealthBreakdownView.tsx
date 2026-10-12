// Fixtures from packages/codecommit-web/test/pr-detail-view.test.ts, test/pr-view-fixtures.ts and e2e/approval-unknown.spec.ts.
import { PRHealthBreakdownView } from "@knpkv/codecommit-web-design-system"
import { healthFor, pagePullRequest, unknownHealth } from "../fixtures/pull-requests.js"

/** Categories calculated from the tested revision facts and fixed fixture clock. */
export const CurrentRevision = () => <PRHealthBreakdownView health={healthFor(pagePullRequest())} />
/** Missing creation date gives a reason instead of a zero score. */
export const MissingCreationDate = () => <PRHealthBreakdownView health={unknownHealth} />
/** Conflicts reduce the mergeable category. */
export const Conflict = () => <PRHealthBreakdownView health={healthFor(pagePullRequest({ isMergeable: false }))} />
/** Failed evaluation produces an unknown approval category. */
export const ApprovalUnknown = () => <PRHealthBreakdownView health={healthFor(pagePullRequest({ approvalUnknown: { _tag: "NotPermitted" } }))} />
