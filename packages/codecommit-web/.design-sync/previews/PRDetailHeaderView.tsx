// Fixtures from packages/codecommit-web/test/pr-detail-view.test.ts and test/pr-view-fixtures.ts.
import { PRDetailHeaderView } from "@knpkv/codecommit-web-design-system"
import type { PullRequest } from "@knpkv/codecommit-core/Domain.js"
import { detailActions, now, pagePullRequest } from "../fixtures/pull-requests.js"

const header = (overrides: Partial<PullRequest> = {}) => <PRDetailHeaderView pr={pagePullRequest(overrides)} now={new Date(now)} actions={detailActions} />
/** No rules apply and the revision is ready to merge. */
export const Ready = () => header()
/** Provider approval is still pending. */
export const ReviewPending = () => header({ isApproved: false })
/** Conflicts decide the verdict. */
export const Conflict = () => header({ isMergeable: false })
/** Last-known approval is labelled unknown after a denied evaluation. */
export const ApprovalUnknown = () => header({ approvalUnknown: { _tag: "NotPermitted" } })
/** A terminal pull request uses the closed verdict. */
export const Closed = () => header({ status: "CLOSED" })
