/**
 * Injectable raw CodeCommit provider boundary.
 *
 * The live layer performs real distilled-aws calls. Responses deliberately
 * remain `unknown` until the read client decodes them with repository-owned
 * Schema contracts; tests can therefore supply provider-shaped fixtures
 * without credentials or network access.
 *
 * @category Read client
 * @module
 */
import * as codecommit from "distilled-aws/codecommit"
import type * as DistilledCredentials from "distilled-aws/Credentials"
import type * as DistilledRegion from "distilled-aws/Region"
import * as sts from "distilled-aws/sts"
import { Context, Effect, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"

import { makeApiError, withAwsContext } from "../AwsClient/internal.js"
import { AwsClientConfig } from "../AwsClientConfig.js"
import type { AwsClientError } from "../Errors.js"
import type { CodeCommitReadAccount } from "./models.js"

/** Parameters for a bounded provider pull-request listing page. */
export interface ListPullRequestsProviderPageRequest {
  readonly account: CodeCommitReadAccount
  readonly repositoryName: string
  readonly status: "OPEN" | "CLOSED"
  readonly nextToken: string | null
  readonly maximumResults: number
}

/** Parameters for one raw provider pull-request read. */
export interface GetPullRequestProviderRequest {
  readonly account: CodeCommitReadAccount
  readonly pullRequestId: string
}

/** Parameters for one immutable blob read. */
export interface GetBlobProviderRequest {
  readonly account: CodeCommitReadAccount
  readonly repositoryName: string
  readonly blobId: string
}

/** Parameters for a bounded provider changed-file page. */
export interface GetDifferencesProviderPageRequest {
  readonly account: CodeCommitReadAccount
  readonly repositoryName: string
  readonly beforeCommitSpecifier: string
  readonly afterCommitSpecifier: string
  readonly nextToken: string | null
  readonly maximumResults: number
}

/** Raw provider methods consumed only by the Schema-decoding read client. */
export interface CodeCommitReadProviderService {
  readonly getCallerIdentity: (account: CodeCommitReadAccount) => Effect.Effect<unknown, AwsClientError>
  readonly getBlob: (request: GetBlobProviderRequest) => Effect.Effect<unknown, AwsClientError>
  readonly listPullRequestsPage: (
    request: ListPullRequestsProviderPageRequest
  ) => Effect.Effect<unknown, AwsClientError>
  readonly getPullRequest: (request: GetPullRequestProviderRequest) => Effect.Effect<unknown, AwsClientError>
  readonly getDifferencesPage: (
    request: GetDifferencesProviderPageRequest
  ) => Effect.Effect<unknown, AwsClientError>
}

/** Injectable raw provider service for CodeCommit reads. */
export class CodeCommitReadProvider extends Context.Service<
  CodeCommitReadProvider,
  CodeCommitReadProviderService
>()("@knpkv/codecommit-core/CodeCommitReadProvider") {}

const callProvider = <A, E>(
  operation: string,
  account: CodeCommitReadAccount,
  effect: Effect.Effect<
    A,
    E,
    DistilledCredentials.Credentials | DistilledRegion.Region | HttpClient.HttpClient
  >
) =>
  withAwsContext(
    operation,
    account,
    effect.pipe(
      Effect.mapError((cause) => makeApiError(operation, account.profile, account.region, cause))
    ),
    { retry: false }
  )

/** Live raw provider layer backed by distilled-aws CodeCommit and STS operations. */
export const CodeCommitReadProviderLive = Layer.effect(
  CodeCommitReadProvider,
  Effect.gen(function*() {
    const config = yield* AwsClientConfig
    const httpClient = yield* HttpClient.HttpClient
    const provideRuntime = <A, E>(
      effect: Effect.Effect<A, E, AwsClientConfig | HttpClient.HttpClient>
    ): Effect.Effect<A, E> =>
      effect.pipe(
        Effect.provideService(AwsClientConfig, config),
        Effect.provideService(HttpClient.HttpClient, httpClient)
      )

    return {
      getCallerIdentity: (account) =>
        provideRuntime(callProvider("getCallerIdentity", account, sts.getCallerIdentity({}))),
      getBlob: (request) =>
        provideRuntime(
          callProvider(
            "getBlob",
            request.account,
            codecommit.getBlob({ repositoryName: request.repositoryName, blobId: request.blobId })
          )
        ),
      listPullRequestsPage: (request) =>
        provideRuntime(
          callProvider(
            "listPullRequestsPage",
            request.account,
            codecommit.listPullRequests({
              repositoryName: request.repositoryName,
              pullRequestStatus: request.status,
              maxResults: request.maximumResults,
              ...(request.nextToken === null ? {} : { nextToken: request.nextToken })
            })
          )
        ),
      getPullRequest: (request) =>
        provideRuntime(
          callProvider(
            "getPullRequestRevision",
            request.account,
            codecommit.getPullRequest({ pullRequestId: request.pullRequestId })
          )
        ),
      getDifferencesPage: (request) =>
        provideRuntime(
          callProvider(
            "getDifferencesPage",
            request.account,
            codecommit.getDifferences({
              repositoryName: request.repositoryName,
              beforeCommitSpecifier: request.beforeCommitSpecifier,
              afterCommitSpecifier: request.afterCommitSpecifier,
              MaxResults: request.maximumResults,
              ...(request.nextToken === null ? {} : { NextToken: request.nextToken })
            })
          )
        )
    } satisfies CodeCommitReadProviderService
  })
)
