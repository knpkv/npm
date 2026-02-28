/**
 * @internal
 */
import * as codecommit from "distilled-aws/codecommit"
import { Effect } from "effect"
import { makeApiError, type UpdatePullRequestTitleParams, withAwsContext } from "./internal.js"

const callUpdateTitle = (params: UpdatePullRequestTitleParams) =>
  codecommit.updatePullRequestTitle({
    pullRequestId: params.pullRequestId,
    title: params.title
  }).pipe(
    Effect.asVoid,
    Effect.mapError((cause) =>
      makeApiError("updatePullRequestTitle", params.account.profile, params.account.region, cause)
    )
  )

export const updatePullRequestTitle = (params: UpdatePullRequestTitleParams) =>
  withAwsContext("updatePullRequestTitle", params.account, callUpdateTitle(params))
