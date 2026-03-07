/**
 * AWS CodeCommit API client service.
 *
 * @category Client
 * @module
 */
import { HttpClient } from "@effect/platform"
import { Context, Effect, Layer, Stream } from "effect"
import { AwsClientConfig } from "../AwsClientConfig.js"
import type { PRCommentLocation, PullRequest } from "../Domain.js"
import type { AwsApiError, AwsCredentialError, AwsThrottleError } from "../Errors.js"
import { createPullRequest } from "./createPullRequest.js"
import { type CallerIdentity, getCallerIdentity } from "./getCallerIdentity.js"
import { getCommentsForPullRequest } from "./getCommentsForPullRequest.js"
import { getDifferences } from "./getDifferences.js"
import { getPullRequest } from "./getPullRequest.js"
import { getPullRequests } from "./getPullRequests.js"
import type {
  AccountParams,
  CreatePullRequestParams,
  DiffStats,
  GetCommentsForPullRequestParams,
  GetDifferencesParams,
  GetPullRequestParams,
  ListBranchesParams,
  PullRequestDetail,
  UpdatePullRequestDescriptionParams,
  UpdatePullRequestTitleParams
} from "./internal.js"
import { listBranches } from "./listBranches.js"
import { updatePullRequestDescription } from "./updatePullRequestDescription.js"
import { updatePullRequestTitle } from "./updatePullRequestTitle.js"

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type { CallerIdentity } from "./getCallerIdentity.js"
export type { DiffStats, GetDifferencesParams } from "./internal.js"

// ---------------------------------------------------------------------------
// Error Union
// ---------------------------------------------------------------------------

export type AwsClientError = AwsCredentialError | AwsThrottleError | AwsApiError

// ---------------------------------------------------------------------------
// Service Definition
// ---------------------------------------------------------------------------

export class AwsClient extends Context.Tag("@knpkv/codecommit-core/AwsClient")<
  AwsClient,
  AwsClient.Service
>() {}

export declare namespace AwsClient {
  /**
   * @category models
   */
  export interface Service {
    readonly getPullRequests: (
      account: AccountParams,
      options?: { status?: "OPEN" | "CLOSED" }
    ) => Stream.Stream<PullRequest, AwsClientError>
    readonly getCallerIdentity: (account: AccountParams) => Effect.Effect<CallerIdentity, AwsClientError>
    readonly createPullRequest: (params: CreatePullRequestParams) => Effect.Effect<string, AwsClientError>
    readonly listBranches: (params: ListBranchesParams) => Effect.Effect<Array<string>, AwsClientError>
    readonly getCommentsForPullRequest: (
      params: GetCommentsForPullRequestParams
    ) => Effect.Effect<Array<PRCommentLocation>, AwsClientError>
    readonly updatePullRequestTitle: (params: UpdatePullRequestTitleParams) => Effect.Effect<void, AwsClientError>
    readonly updatePullRequestDescription: (
      params: UpdatePullRequestDescriptionParams
    ) => Effect.Effect<void, AwsClientError>
    readonly getPullRequest: (params: GetPullRequestParams) => Effect.Effect<PullRequestDetail, AwsClientError>
    readonly getDifferences: (params: GetDifferencesParams) => Effect.Effect<DiffStats, AwsClientError>
  }
}

// ---------------------------------------------------------------------------
// Live Implementation
// ---------------------------------------------------------------------------

export const AwsClientLive = Layer.effect(
  AwsClient,
  Effect.gen(function*() {
    const config = yield* AwsClientConfig
    const httpClient = yield* HttpClient.HttpClient

    const provide = <A, E>(
      effect: Effect.Effect<A, E, AwsClientConfig | HttpClient.HttpClient>
    ): Effect.Effect<A, E> =>
      effect.pipe(
        Effect.provideService(AwsClientConfig, config),
        Effect.provideService(HttpClient.HttpClient, httpClient)
      )

    const provideStream = <A, E>(
      stream: Stream.Stream<A, E, AwsClientConfig | HttpClient.HttpClient>
    ): Stream.Stream<A, E> =>
      stream.pipe(
        Stream.provideService(AwsClientConfig, config),
        Stream.provideService(HttpClient.HttpClient, httpClient)
      )

    return {
      getPullRequests: (account, options) => provideStream(getPullRequests(account, options)),
      getCallerIdentity: (account) => provide(getCallerIdentity(account)),
      createPullRequest: (params) => provide(createPullRequest(params)),
      listBranches: (params) => provide(listBranches(params)),
      getCommentsForPullRequest: (params) => provide(getCommentsForPullRequest(params)),
      updatePullRequestTitle: (params) => provide(updatePullRequestTitle(params)),
      updatePullRequestDescription: (params) => provide(updatePullRequestDescription(params)),
      getPullRequest: (params) => provide(getPullRequest(params)),
      getDifferences: (params) => provide(getDifferences(params))
    }
  })
)
