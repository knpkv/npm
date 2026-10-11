// Fixtures from packages/codecommit-web/test/workbench-rail.test.ts and packages/codecommit-web/test/pr-row-presentation.test.ts.
import { PRRow } from "@knpkv/codecommit-web-design-system"
import type { PullRequest } from "@knpkv/codecommit-core/Domain.js"
import { caller, pullRequest } from "../fixtures/pull-requests.js"

const row = (pr: PullRequest) => <ul aria-label="Review queue" style={{ listStyle: "none", margin: 0, padding: 0 }}><li><PRRow caller={caller} pr={pr} to="/" showUpdated /></li></ul>

/** The owner's review is still needed. */
export const NeedsReview = () => row(pullRequest("1"))
/** An open pull request conflicts with its destination. */
export const Conflict = () => row(pullRequest("4", { isMergeable: false }))
/** Last-known approval is not treated as a current approval. */
export const ApprovalUnknown = () => row(pullRequest("2", { isApproved: true, approvalUnknown: { _tag: "NotPermitted" } }))
/** No approval rules means no sign-off is required. */
export const NoApprovalRequired = () => row(pullRequest("5", { author: "owner", isApproved: true, approvalRules: [] }))
/** A terminal row uses a neutral navigation action. */
export const Closed = () => row(pullRequest("1", { status: "CLOSED", isMergeable: false }))
