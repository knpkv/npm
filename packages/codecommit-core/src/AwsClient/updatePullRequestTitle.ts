/**
 * @internal
 */
import { HttpClient } from "@effect/platform"
import { Credentials, Region } from "distilled-aws"
import * as codecommit from "distilled-aws/codecommit"
import { Effect, Layer } from "effect"
import { AwsClientConfig } from "../AwsClientConfig.js"
import { acquireCredentials, makeApiError, throttleRetry, type UpdatePullRequestTitleParams } from "./internal.js"

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
  Effect.gen(function*() {
    const config = yield* AwsClientConfig
    const httpClient = yield* HttpClient.HttpClient
    const credentials = yield* acquireCredentials(params.account.profile, params.account.region)

    return yield* Effect.provide(
      callUpdateTitle(params),
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, httpClient),
        Layer.succeed(Region.Region, params.account.region),
        Layer.succeed(Credentials.Credentials, credentials)
      )
    ).pipe(
      throttleRetry,
      Effect.timeout(config.operationTimeout),
      Effect.catchTag(
        "TimeoutException",
        (cause) =>
          Effect.fail(makeApiError("updatePullRequestTitle", params.account.profile, params.account.region, cause))
      )
    )
  })
