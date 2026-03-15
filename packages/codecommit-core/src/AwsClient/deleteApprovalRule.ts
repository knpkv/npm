/**
 * Deletes an approval rule from a pull request via
 * `distilled-aws/codecommit.deletePullRequestApprovalRule`, wrapped with
 * {@link withAwsContext} for credential acquisition and retry.
 *
 * @internal
 */
import * as codecommit from "distilled-aws/codecommit"
import { Effect } from "effect"
import { type DeleteApprovalRuleParams, makeApiError, withAwsContext } from "./internal.js"

const callDeleteApprovalRule = (params: DeleteApprovalRuleParams) =>
  codecommit.deletePullRequestApprovalRule({
    pullRequestId: params.pullRequestId,
    approvalRuleName: params.approvalRuleName
  }).pipe(
    Effect.asVoid,
    Effect.mapError((cause) => makeApiError("deleteApprovalRule", params.account.profile, params.account.region, cause))
  )

export const deleteApprovalRule = (params: DeleteApprovalRuleParams) =>
  withAwsContext("deleteApprovalRule", params.account, callDeleteApprovalRule(params))
