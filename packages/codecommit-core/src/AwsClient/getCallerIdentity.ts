/**
 * @internal
 */
import { HttpClient } from "@effect/platform"
import { Credentials, Region } from "distilled-aws"
import * as sts from "distilled-aws/sts"
import { Effect, Layer } from "effect"
import { AwsClientConfig } from "../AwsClientConfig.js"
import { type AccountParams, acquireCredentials, makeApiError, normalizeAuthor, throttleRetry } from "./internal.js"

const callGetCallerIdentity = (account: AccountParams) =>
  sts.getCallerIdentity({}).pipe(
    Effect.map((resp) => normalizeAuthor(resp.Arn ?? "")),
    Effect.mapError((cause) => makeApiError("getCallerIdentity", account.profile, account.region, cause))
  )

export const getCallerIdentity = (account: AccountParams) =>
  Effect.gen(function*() {
    const config = yield* AwsClientConfig
    const httpClient = yield* HttpClient.HttpClient
    const credentials = yield* acquireCredentials(account.profile, account.region)

    return yield* Effect.provide(
      callGetCallerIdentity(account),
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, httpClient),
        Layer.succeed(Region.Region, account.region),
        Layer.succeed(Credentials.Credentials, credentials)
      )
    ).pipe(
      throttleRetry,
      Effect.timeout(config.operationTimeout),
      Effect.catchTag("TimeoutException", (cause) =>
        Effect.fail(makeApiError("getCallerIdentity", account.profile, account.region, cause)))
    )
  })
