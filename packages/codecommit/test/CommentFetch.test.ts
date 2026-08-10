import { describe, expect, it } from "@effect/vitest"
import { AwsClient, CacheService, Domain, Errors } from "@knpkv/codecommit-core"
import { Effect, Layer } from "effect"
import { fetchPrComments } from "../src/tui/comment-fetch.js"

const pullRequest = new Domain.PullRequest({
  account: new Domain.Account({
    profile: Domain.AwsProfileName.make("production"),
    region: Domain.AwsRegion.make("eu-west-1"),
    repoAccountId: "111122223333"
  }),
  approvalRules: [],
  approvedBy: [],
  approvedByArns: [],
  author: "reviewer",
  commentedBy: [],
  creationDate: new Date(0),
  destinationBranch: "main",
  id: Domain.PullRequestId.make("42"),
  isApproved: false,
  isMergeable: true,
  lastModifiedDate: new Date(1_000),
  link: "https://example.invalid/pr/42",
  repositoryName: Domain.RepositoryName.make("payments"),
  sourceBranch: "feature",
  status: "OPEN",
  title: "Review"
})

const commentsLayer = (
  result: Effect.Effect<Array<Domain.PRCommentLocation>, Errors.AwsClientError>
) =>
  Layer.mergeAll(
    Layer.mock(AwsClient.AwsClient, {
      getCommentsForPullRequest: () => result
    }),
    Layer.mock(CacheService.NotificationRepo, {
      addSystem: () => Effect.void
    })
  )

describe("posted comment fetch", () => {
  it.effect("preserves credential and throttle failures at the atom effect boundary", () =>
    Effect.gen(function*() {
      const credentialFailure = new Errors.AwsCredentialError({
        cause: new Error("expired SSO session"),
        profile: pullRequest.account.profile,
        region: pullRequest.account.region
      })
      const throttleFailure = new Errors.AwsThrottleError({
        cause: new Error("rate limited"),
        operation: "getCommentsForPullRequest",
        retryCount: 3
      })

      const credentialResult = yield* fetchPrComments(pullRequest).pipe(
        Effect.flip,
        Effect.provide(commentsLayer(Effect.fail(credentialFailure)))
      )
      const throttleResult = yield* fetchPrComments(pullRequest).pipe(
        Effect.flip,
        Effect.provide(commentsLayer(Effect.fail(throttleFailure)))
      )

      expect(credentialResult).toBe(credentialFailure)
      expect(throttleResult).toBe(throttleFailure)
    }))

  it.effect("keeps a successful zero-location read as an empty result", () =>
    Effect.gen(function*() {
      const result = yield* fetchPrComments(pullRequest).pipe(
        Effect.provide(commentsLayer(Effect.succeed([])))
      )

      expect(result.comments).toEqual([])
    }))
})
