/**
 * AWS CodeCommit API client service.
 *
 * Provides an Effect `Context.Tag`-based service wrapping @distilled.cloud/aws
 * CodeCommit calls. Exposes PR CRUD, branch listing, comments, diff stats,
 * caller identity, and approval rule management (create/update/delete).
 *
 * **Mental model**
 *
 * - Thin Effect wrappers over @distilled.cloud/aws CodeCommit calls
 * - Each method acquires credentials and provides region/HTTP context
 *
 * @category Client
 * @module
 */
import { Context, Effect, Layer, Stream } from "effect"
import { HttpClient } from "effect/unstable/http"
import { AwsClientConfig } from "../AwsClientConfig.js"
import type { PRCommentLocation, PullRequest } from "../Domain.js"
import type { AwsApiError, AwsCredentialError, AwsThrottleError } from "../Errors.js"
import type { CallerIdentity } from "./getCallerIdentity.js"
import type {
  AccountParams,
  CreateApprovalRuleParams,
  CreatePullRequestParams,
  DeleteApprovalRuleParams,
  DiffStats,
  GetCommentsForPullRequestParams,
  GetDifferencesParams,
  GetPullRequestParams,
  ListBranchesParams,
  PullRequestDetail,
  UpdateApprovalRuleParams,
  UpdatePullRequestDescriptionParams,
  UpdatePullRequestTitleParams
} from "./internal.js"

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

export class AwsClient extends Context.Service<
  AwsClient,
  AwsClient.Service
>()("@knpkv/codecommit-core/AwsClient") {}

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
    readonly createApprovalRule: (params: CreateApprovalRuleParams) => Effect.Effect<void, AwsClientError>
    readonly updateApprovalRule: (params: UpdateApprovalRuleParams) => Effect.Effect<void, AwsClientError>
    readonly deleteApprovalRule: (params: DeleteApprovalRuleParams) => Effect.Effect<void, AwsClientError>
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
      getPullRequests: (account, options) =>
        Stream.unwrap(
          Effect.map(Effect.promise(() => import("./getPullRequests.js")), ({ getPullRequests }) =>
            provideStream(getPullRequests(account, options)))
        ),
      getCallerIdentity: (account) =>
        Effect.flatMap(
          Effect.promise(() => import("./getCallerIdentity.js")),
          ({ getCallerIdentity }) => provide(getCallerIdentity(account))
        ),
      createPullRequest: (params) =>
        Effect.flatMap(
          Effect.promise(() => import("./createPullRequest.js")),
          ({ createPullRequest }) => provide(createPullRequest(params))
        ),
      listBranches: (params) =>
        Effect.flatMap(
          Effect.promise(() => import("./listBranches.js")),
          ({ listBranches }) => provide(listBranches(params))
        ),
      getCommentsForPullRequest: (params) =>
        Effect.flatMap(
          Effect.promise(() => import("./getCommentsForPullRequest.js")),
          ({ getCommentsForPullRequest }) => provide(getCommentsForPullRequest(params))
        ),
      updatePullRequestTitle: (params) =>
        Effect.flatMap(
          Effect.promise(() => import("./updatePullRequestTitle.js")),
          ({ updatePullRequestTitle }) => provide(updatePullRequestTitle(params))
        ),
      updatePullRequestDescription: (params) =>
        Effect.flatMap(
          Effect.promise(() => import("./updatePullRequestDescription.js")),
          ({ updatePullRequestDescription }) => provide(updatePullRequestDescription(params))
        ),
      getPullRequest: (params) =>
        Effect.flatMap(
          Effect.promise(() => import("./getPullRequest.js")),
          ({ getPullRequest }) => provide(getPullRequest(params))
        ),
      getDifferences: (params) =>
        Effect.flatMap(
          Effect.promise(() => import("./getDifferences.js")),
          ({ getDifferences }) => provide(getDifferences(params))
        ),
      createApprovalRule: (params) =>
        Effect.flatMap(
          Effect.promise(() => import("./createApprovalRule.js")),
          ({ createApprovalRule }) => provide(createApprovalRule(params))
        ),
      updateApprovalRule: (params) =>
        Effect.flatMap(
          Effect.promise(() => import("./updateApprovalRule.js")),
          ({ updateApprovalRule }) => provide(updateApprovalRule(params))
        ),
      deleteApprovalRule: (params) =>
        Effect.flatMap(
          Effect.promise(() => import("./deleteApprovalRule.js")),
          ({ deleteApprovalRule }) => provide(deleteApprovalRule(params))
        )
    }
  })
)
