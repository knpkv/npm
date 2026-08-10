import { AwsClient, CacheService, type Domain, type Errors } from "@knpkv/codecommit-core"
import { Effect } from "effect"

const notifyCommentFetchError = Effect.fn("notifyCommentFetchError")(function*(error: Errors.AwsClientError) {
  const notificationRepo = yield* CacheService.NotificationRepo
  yield* notificationRepo.addSystem({
    type: "error",
    title: "Fetch Comments Failed",
    message: error.message
  })
})

/** Reads posted comments without converting provider failures into a successful empty result. */
export const fetchPrComments = Effect.fn("fetchPrComments")(function*(pr: Domain.PullRequest) {
  const awsClient = yield* AwsClient.AwsClient
  const comments = yield* awsClient.getCommentsForPullRequest({
    account: { profile: pr.account.profile, region: pr.account.region },
    pullRequestId: pr.id,
    repositoryName: pr.repositoryName
  }).pipe(
    Effect.tapError(notifyCommentFetchError),
    Effect.withSpan("fetchPrComments", { attributes: { prId: pr.id } })
  )
  return {
    comments,
    identity: {
      profile: pr.account.profile,
      pullRequestId: pr.id,
      region: pr.account.region,
      repositoryName: pr.repositoryName
    }
  }
})
