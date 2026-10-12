// Fixtures from packages/codecommit-web/test/pr-detail-view.test.ts, test/pr-view-fixtures.ts and e2e/approval-unknown.spec.ts.
import { PRLifecycleView, PRRevisionView } from "@knpkv/codecommit-web-design-system"
import type { PullRequest } from "@knpkv/codecommit-core/Domain.js"
import { healthFor, managedRules, pagePullRequest, readyComments, unknownHealth } from "../fixtures/pull-requests.js"

const lifecycle = (pr: PullRequest) => <PRLifecycleView pr={pr} comments={readyComments} />
const revision = (pr: PullRequest) => <PRRevisionView pr={pr} health={healthFor(pr)} renderLifecycle={lifecycle} />
/** Branch, provider facts and review duration for a revision without rules. */
export const NoRules = () => revision(pagePullRequest())
/** A managed rule remains pending. */
export const Pending = () => revision(pagePullRequest({ isApproved: false, approvalRules: managedRules }))
/** Conflict and unknown approval are distinct facts. */
export const Conflict = () => revision(pagePullRequest({ isMergeable: false, approvalUnknown: { _tag: "NotPermitted" } }))
/** Unknown health preserves the fixture's normal dates and lifecycle durations. */
export const UnknownHealth = () => <PRRevisionView pr={pagePullRequest()} health={unknownHealth} renderLifecycle={lifecycle} />
