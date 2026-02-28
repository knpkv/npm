/**
 * @internal
 */
import * as codecommit from "distilled-aws/codecommit"
import { Effect } from "effect"
import { makeApiError, type UpdatePullRequestDescriptionParams, withAwsContext } from "./internal.js"

const callUpdateDescription = (params: UpdatePullRequestDescriptionParams) =>
  codecommit.updatePullRequestDescription({
    pullRequestId: params.pullRequestId,
    description: params.description
  }).pipe(
    Effect.asVoid,
    Effect.mapError((cause) =>
      makeApiError("updatePullRequestDescription", params.account.profile, params.account.region, cause)
    )
  )

export const updatePullRequestDescription = (
  params: UpdatePullRequestDescriptionParams
) => withAwsContext("updatePullRequestDescription", params.account, callUpdateDescription(params))
