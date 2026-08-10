/**
 * Injectable raw CodeCommit provider boundary for review mutations and reconciliation.
 *
 * @category Review client
 * @module
 */
import * as codecommit from "@distilled.cloud/aws/codecommit"
import type * as DistilledCredentials from "@distilled.cloud/aws/Credentials"
import type * as DistilledRegion from "@distilled.cloud/aws/Region"
import * as sts from "@distilled.cloud/aws/sts"
import { Context, Effect, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"

import { makeApiError, withAwsContext } from "../AwsClient/internal.js"
import { AwsClientConfig } from "../AwsClientConfig.js"
import type { AwsClientError } from "../Errors.js"
import type { CodeCommitReviewAction, CodeCommitReviewTarget } from "./models.js"

/** Raw provider page used to locate an idempotent comment without replaying it. */
export interface GetReviewCommentsProviderPageRequest {
  readonly target: CodeCommitReviewTarget
  readonly nextToken: string | null
}

/** Raw identity evidence captured by the same AWS runtime that will dispatch a merge. */
export interface CodeCommitMergeAuthorizationEvidence {
  readonly callerIdentity: unknown
  readonly repositoryIdentity: unknown
}

/** Raw provider operations needed by the schema-decoded review client. */
export interface CodeCommitReviewProviderService {
  readonly postComment: (
    action: Extract<CodeCommitReviewAction, { readonly _tag: "comment" | "request-changes" | "request-review" }>
  ) => Effect.Effect<unknown, AwsClientError>
  readonly updateComment: (
    action: Extract<CodeCommitReviewAction, { readonly _tag: "update-comment" }>
  ) => Effect.Effect<unknown, AwsClientError>
  readonly postReply: (
    action: Extract<CodeCommitReviewAction, { readonly _tag: "reply-comment" }>
  ) => Effect.Effect<unknown, AwsClientError>
  readonly updateApprovalState: (
    action: Extract<CodeCommitReviewAction, { readonly _tag: "approve" | "revoke-approval" }>
  ) => Effect.Effect<unknown, AwsClientError>
  readonly mergePullRequest: <E>(
    action: Extract<CodeCommitReviewAction, { readonly _tag: "merge" }>,
    authorize: (evidence: CodeCommitMergeAuthorizationEvidence) => Effect.Effect<void, E>
  ) => Effect.Effect<unknown, AwsClientError | E>
  readonly getApprovalStates: (target: CodeCommitReviewTarget) => Effect.Effect<unknown, AwsClientError>
  readonly getCommentsPage: (
    request: GetReviewCommentsProviderPageRequest
  ) => Effect.Effect<unknown, AwsClientError>
}

/** Injectable raw provider service for CodeCommit review actions. */
export class CodeCommitReviewProvider extends Context.Service<
  CodeCommitReviewProvider,
  CodeCommitReviewProviderService
>()("@knpkv/codecommit-core/CodeCommitReviewProvider") {}

/** Non-idempotent merge submissions stay supervised until the provider settles. */
export const reviewProviderTimeoutPolicy = (operation: string): "none" | "operation" => {
  switch (operation) {
    case "mergePullRequestByFastForward":
    case "mergePullRequestBySquash":
    case "mergePullRequestByThreeWay":
      return "none"
    default:
      return "operation"
  }
}

const callProvider = <A, E>(
  operation: string,
  target: CodeCommitReviewTarget,
  effect: Effect.Effect<
    A,
    E,
    DistilledCredentials.Credentials | DistilledRegion.Region | HttpClient.HttpClient
  >
) =>
  withAwsContext(
    operation,
    target.account,
    effect.pipe(
      Effect.mapError((cause) => makeApiError(operation, target.account.profile, target.account.region, cause))
    ),
    reviewProviderTimeoutPolicy(operation) === "none" ? { retry: false, timeout: "none" } : { retry: false }
  )

const mapRawProviderError = (operation: string, target: CodeCommitReviewTarget) => (cause: unknown) =>
  makeApiError(operation, target.account.profile, target.account.region, cause)

const mergeOperation = (strategy: Extract<CodeCommitReviewAction, { readonly _tag: "merge" }>["strategy"]) => {
  switch (strategy) {
    case "fast-forward":
      return "mergePullRequestByFastForward"
    case "squash":
      return "mergePullRequestBySquash"
    case "three-way":
      return "mergePullRequestByThreeWay"
  }
}

/**
 * Verify caller and repository ownership, then dispatch under one credential snapshot.
 * The authorization callback owns Schema decoding while this provider owns runtime atomicity.
 */
const callAuthorizedMerge = <E>(
  action: Extract<CodeCommitReviewAction, { readonly _tag: "merge" }>,
  authorize: (evidence: CodeCommitMergeAuthorizationEvidence) => Effect.Effect<void, E>
) => {
  const operation = mergeOperation(action.strategy)
  const request = makeMergePullRequestRequest(action)
  const mapError = mapRawProviderError(operation, action.target)
  const merge = (() => {
    switch (action.strategy) {
      case "fast-forward":
        return codecommit.mergePullRequestByFastForward(request)
      case "squash":
        return codecommit.mergePullRequestBySquash(request)
      case "three-way":
        return codecommit.mergePullRequestByThreeWay(request)
    }
  })()

  return withAwsContext(
    operation,
    action.target.account,
    Effect.gen(function*() {
      const repositoryIdentity = yield* codecommit.getRepository({
        repositoryName: action.target.repositoryName
      }).pipe(Effect.mapError(mapError))
      // STS is intentionally last: authorization immediately precedes the destructive call.
      const callerIdentity = yield* sts.getCallerIdentity({}).pipe(Effect.mapError(mapError))
      yield* authorize({ callerIdentity, repositoryIdentity })
      return yield* merge.pipe(Effect.mapError(mapError))
    }),
    { retry: false, timeout: "none" }
  )
}

/** Map one decoded comment action to the exact Distilled CodeCommit request. */
export const makePostCommentForPullRequestRequest = (
  action: Extract<
    CodeCommitReviewAction,
    { readonly _tag: "comment" | "request-changes" | "request-review" }
  >
) => ({
  pullRequestId: action.target.pullRequestId,
  repositoryName: action.target.repositoryName,
  beforeCommitId: action.target.destinationCommit,
  afterCommitId: action.target.sourceCommit,
  content: action.content,
  clientRequestToken: action.clientRequestToken,
  ...(action._tag === "comment" && action.location !== undefined
    ? { location: action.location }
    : {})
})

/** Map an update action to the exact CodeCommit comment mutation request. */
export const makeUpdateCommentRequest = (
  action: Extract<CodeCommitReviewAction, { readonly _tag: "update-comment" }>
) => ({
  commentId: action.commentId,
  content: action.content
})

/** Map a reply action to the exact CodeCommit comment mutation request. */
export const makePostCommentReplyRequest = (
  action: Extract<CodeCommitReviewAction, { readonly _tag: "reply-comment" }>
) => ({
  inReplyTo: action.commentId,
  content: action.content,
  clientRequestToken: action.clientRequestToken
})

/** Map a merge action to a provider request pinned to the reviewed source commit. */
export const makeMergePullRequestRequest = (
  action: Extract<CodeCommitReviewAction, { readonly _tag: "merge" }>
) => ({
  pullRequestId: action.target.pullRequestId,
  repositoryName: action.target.repositoryName,
  sourceCommitId: action.target.sourceCommit
})

/** Live raw provider layer backed by @distilled.cloud/aws CodeCommit operations. */
export const CodeCommitReviewProviderLive = Layer.effect(
  CodeCommitReviewProvider,
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
      postComment: (action) =>
        provideRuntime(callProvider(
          "postPullRequestComment",
          action.target,
          codecommit.postCommentForPullRequest(
            makePostCommentForPullRequestRequest(action)
          )
        )),
      updateComment: (action) =>
        provideRuntime(callProvider(
          "updateComment",
          action.target,
          codecommit.updateComment(makeUpdateCommentRequest(action))
        )),
      postReply: (action) =>
        provideRuntime(callProvider(
          "postCommentReply",
          action.target,
          codecommit.postCommentReply(makePostCommentReplyRequest(action))
        )),
      updateApprovalState: (action) =>
        provideRuntime(callProvider(
          "updatePullRequestApprovalState",
          action.target,
          codecommit.updatePullRequestApprovalState({
            pullRequestId: action.target.pullRequestId,
            revisionId: action.target.revisionId,
            approvalState: action._tag === "approve" ? "APPROVE" : "REVOKE"
          })
        )),
      mergePullRequest: (action, authorize) => provideRuntime(callAuthorizedMerge(action, authorize)),
      getApprovalStates: (target) =>
        provideRuntime(callProvider(
          "getPullRequestApprovalStates",
          target,
          codecommit.getPullRequestApprovalStates({
            pullRequestId: target.pullRequestId,
            revisionId: target.revisionId
          })
        )),
      getCommentsPage: ({ nextToken, target }) =>
        provideRuntime(callProvider(
          "getCommentsForPullRequest",
          target,
          codecommit.getCommentsForPullRequest({
            pullRequestId: target.pullRequestId,
            repositoryName: target.repositoryName,
            beforeCommitId: target.destinationCommit,
            afterCommitId: target.sourceCommit,
            maxResults: 100,
            ...(nextToken === null ? {} : { nextToken })
          })
        ))
    } satisfies CodeCommitReviewProviderService
  })
)
