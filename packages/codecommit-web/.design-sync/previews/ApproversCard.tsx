// Fixtures from packages/codecommit-web/test/pr-approvals-view.test.ts and test/pr-view-fixtures.ts.
// permissionPrompt pauses membership polling and refreshes when cleared; it renders no prompt, so no separate card.
import { ApproversCard } from "@knpkv/codecommit-web-design-system"
import type { ApproversCardProps } from "@knpkv/codecommit-web/views"
import { approvalActions, managedRules, noop } from "../fixtures/pull-requests.js"

const props: ApproversCardProps = {
  title: "Required Approvers", ruleName: "Required approvers", required: true,
  approvalRules: managedRules, approvedBy: [], approversUnknown: false, approvalUnknown: false,
  currentUser: "reviewer", knownUserArns: new Map([["maintainer", "CodeCommitApprovers:111122223333:maintainer"]]),
  repoAccountId: "111122223333", permissionPrompt: false, onSetApprovers: noop,
  onRemoveRule: () => approvalActions.onRemoveRule("required"), onRefresh: approvalActions.onRefresh
}

/** Required reviewer has not approved the managed rule. */
export const Pending = () => <ApproversCard {...props} />
/** Current reviewer sign-off satisfies the managed rule. */
export const Satisfied = () => <ApproversCard {...props} approvalRules={managedRules.map((rule) => ({ ...rule, satisfied: true }))} approvedBy={["reviewer"]} />
/** Failed evaluation and approver reads keep stale satisfaction unverified. */
export const ApprovalUnknown = () => <ApproversCard {...props} approvalRules={managedRules.map((rule) => ({ ...rule, satisfied: true }))} approvalUnknown approversUnknown />
