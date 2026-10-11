// Fixtures from packages/codecommit-web/test/pr-approvals-view.test.ts and test/pr-view-fixtures.ts.
// permissionPrompt is forwarded to membership polling; this view renders no permission prompt or distinct card.
import { PRApprovalsView } from "@knpkv/codecommit-web-design-system"
import { approvalActions, managedRules, pagePullRequest, repositoryRule } from "../fixtures/pull-requests.js"

/** Managed required approver and shared repository-template approver. */
export const RequiredAndTemplate = () => <PRApprovalsView pr={pagePullRequest({ isApproved: false, approvalRules: [...managedRules, repositoryRule] })} actions={approvalActions} />
/** The managed rule is satisfied by its reviewer. */
export const Satisfied = () => <PRApprovalsView pr={pagePullRequest({ approvalRules: managedRules.map((rule) => ({ ...rule, satisfied: true })), approvedBy: ["reviewer"] })} actions={approvalActions} />
/** Stale satisfaction and sign-off never appear current after failed reads. */
export const ApprovalUnknown = () => <PRApprovalsView pr={pagePullRequest({ approvalRules: managedRules.map((rule) => ({ ...rule, satisfied: true })), approvedBy: ["reviewer"], approvalUnknown: { _tag: "NotPermitted" }, approversUnknown: true })} actions={approvalActions} />
/** No managed or template rules apply. */
export const NoRules = () => <PRApprovalsView pr={pagePullRequest()} actions={approvalActions} />
