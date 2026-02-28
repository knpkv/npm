/**
 * @internal
 */
import * as codecommit from "distilled-aws/codecommit"
import { Effect } from "effect"
import { type CreatePullRequestParams, makeApiError, withAwsContext } from "./internal.js"

const callCreatePullRequest = (params: CreatePullRequestParams) =>
  codecommit.createPullRequest({
    title: params.title,
    ...(params.description && { description: params.description }),
    targets: [{
      repositoryName: params.repositoryName,
      sourceReference: params.sourceReference,
      destinationReference: params.destinationReference
    }]
  }).pipe(
    Effect.map((resp) => resp.pullRequest?.pullRequestId ?? ""),
    Effect.mapError((cause) => makeApiError("createPullRequest", params.account.profile, params.account.region, cause))
  )

export const createPullRequest = (params: CreatePullRequestParams) =>
  withAwsContext("createPullRequest", params.account, callCreatePullRequest(params))
