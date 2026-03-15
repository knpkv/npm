/**
 * Updates an approval rule's content on a pull request via
 * `distilled-aws/codecommit.updatePullRequestApprovalRuleContent`, wrapped
 * with {@link withAwsContext} for credential acquisition and retry.
 *
 * @internal
 */
import * as codecommit from "distilled-aws/codecommit"
import { Effect } from "effect"
import { makeApiError, type UpdateApprovalRuleParams, withAwsContext } from "./internal.js"

const callUpdateApprovalRule = (params: UpdateApprovalRuleParams) =>
  codecommit.updatePullRequestApprovalRuleContent({
    pullRequestId: params.pullRequestId,
    approvalRuleName: params.approvalRuleName,
    newRuleContent: params.newApprovalRuleContent
  }).pipe(
    Effect.asVoid,
    Effect.mapError((cause) => makeApiError("updateApprovalRule", params.account.profile, params.account.region, cause))
  )

export const updateApprovalRule = (params: UpdateApprovalRuleParams) =>
  withAwsContext("updateApprovalRule", params.account, callUpdateApprovalRule(params))
