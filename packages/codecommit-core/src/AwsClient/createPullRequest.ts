/**
 * @internal
 */
import { HttpClient } from "@effect/platform"
import { Credentials, Region } from "distilled-aws"
import * as codecommit from "distilled-aws/codecommit"
import { Effect, Layer } from "effect"
import { AwsClientConfig } from "../AwsClientConfig.js"
import { acquireCredentials, type CreatePullRequestParams, makeApiError, throttleRetry } from "./internal.js"

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
  Effect.gen(function*() {
    const config = yield* AwsClientConfig
    const httpClient = yield* HttpClient.HttpClient
    const credentials = yield* acquireCredentials(params.account.profile, params.account.region)

    return yield* Effect.provide(
      callCreatePullRequest(params),
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
        (cause) => Effect.fail(makeApiError("createPullRequest", params.account.profile, params.account.region, cause))
      )
    )
  })
