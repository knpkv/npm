/**
 * Creates an approval rule on a pull request via
 * `distilled-aws/codecommit.createPullRequestApprovalRule`, wrapped with
 * {@link withAwsContext} for credential acquisition and retry.
 *
 * @internal
 */
import * as codecommit from "distilled-aws/codecommit"
import { Effect } from "effect"
import { type CreateApprovalRuleParams, makeApiError, withAwsContext } from "./internal.js"

const callCreateApprovalRule = (params: CreateApprovalRuleParams) =>
  codecommit.createPullRequestApprovalRule({
    pullRequestId: params.pullRequestId,
    approvalRuleName: params.approvalRuleName,
    approvalRuleContent: params.approvalRuleContent
  }).pipe(
    Effect.asVoid,
    Effect.mapError((cause) => makeApiError("createApprovalRule", params.account.profile, params.account.region, cause))
  )

export const createApprovalRule = (params: CreateApprovalRuleParams) =>
  withAwsContext("createApprovalRule", params.account, callCreateApprovalRule(params))
