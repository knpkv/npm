/**
 * @internal
 */
import { HttpClient } from "@effect/platform"
import { Credentials, Region } from "distilled-aws"
import * as codecommit from "distilled-aws/codecommit"
import { Effect, Layer, Option, Stream } from "effect"
import { AwsClientConfig } from "../AwsClientConfig.js"
import { acquireCredentials, type ListBranchesParams, makeApiError, throttleRetry } from "./internal.js"

const fetchBranchPages = (repositoryName: string) =>
  Stream.paginateEffect(
    undefined as string | undefined,
    (nextToken) =>
      codecommit.listBranches({
        repositoryName,
        ...(nextToken && { nextToken })
      }).pipe(
        Effect.map((resp) =>
          [
            resp.branches ?? [],
            resp.nextToken ? Option.some(resp.nextToken) : Option.none()
          ] as const
        )
      )
  ).pipe(
    Stream.flatMap(Stream.fromIterable)
  )

export const listBranches = (params: ListBranchesParams) =>
  Effect.gen(function*() {
    const config = yield* AwsClientConfig
    const httpClient = yield* HttpClient.HttpClient
    const credentials = yield* acquireCredentials(params.account.profile, params.account.region)

    return yield* Effect.provide(
      fetchBranchPages(params.repositoryName).pipe(
        Stream.mapError((cause) => makeApiError("listBranches", params.account.profile, params.account.region, cause)),
        Stream.runCollect
      ),
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, httpClient),
        Layer.succeed(Region.Region, params.account.region),
        Layer.succeed(Credentials.Credentials, credentials)
      )
    ).pipe(
      throttleRetry,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.timeout(config.operationTimeout),
      Effect.catchTag("TimeoutException", (cause) =>
        Effect.fail(makeApiError("listBranches", params.account.profile, params.account.region, cause)))
    )
  })
