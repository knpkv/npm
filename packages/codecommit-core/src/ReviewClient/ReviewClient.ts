/**
 * Schema-decoded CodeCommit review actions with immutable-head preflight and read-only reconciliation.
 *
 * @category Review client
 * @module
 */
import { Context, Effect, Layer, Predicate, Schema } from "effect"

import { identityMatches } from "../Domain.js"
import type { AwsClientError } from "../Errors.js"
import { CodeCommitMalformedResponseError, CodeCommitReadNotFoundError } from "../ReadClient/errors.js"
import type { CodeCommitAccountIdentity, CodeCommitPullRequestRevision } from "../ReadClient/models.js"
import { CodeCommitReadClient } from "../ReadClient/ReadClient.js"
import { CodeCommitReviewConflictError, type CodeCommitReviewError } from "./errors.js"
import {
  type CodeCommitReviewAction,
  CodeCommitReviewReceipt,
  type CodeCommitReviewReconciliation,
  type CodeCommitReviewTarget
} from "./models.js"
import { CodeCommitReviewProvider, CodeCommitReviewProviderLive } from "./ReviewProvider.js"

const MAXIMUM_COMMENT_PAGES = 20
const COMMENT_MARKER_PREFIX = "<!-- knpkv-codecommit-review:"
const COMMENT_MARKER_SUFFIX = " -->"

const RawCommentResponse = Schema.Struct({
  comment: Schema.Struct({
    commentId: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()),
    clientRequestToken: Schema.optional(Schema.String)
  })
})

const RawApprovalStates = Schema.Struct({
  approvals: Schema.optional(Schema.Array(Schema.Struct({
    userArn: Schema.optional(Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty())),
    approvalState: Schema.optional(Schema.Literals(["APPROVE", "REVOKE"]))
  })))
})

const RawCommentsPage = Schema.Struct({
  commentsForPullRequestData: Schema.optional(Schema.Array(Schema.Struct({
    comments: Schema.optional(Schema.Array(Schema.Struct({
      commentId: Schema.optional(Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty())),
      clientRequestToken: Schema.optional(Schema.String),
      content: Schema.optional(Schema.String)
    })))
  }))),
  nextToken: Schema.optional(Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()))
})

const malformed = (operation: string) =>
  new CodeCommitMalformedResponseError({
    operation,
    diagnosticCode: "provider-response-schema-invalid"
  })

const decodeProvider = <S extends Schema.Codec<unknown, unknown, never, never>>(
  operation: string,
  schema: S,
  value: unknown
): Effect.Effect<S["Type"], CodeCommitMalformedResponseError> =>
  Schema.decodeUnknownEffect(Schema.toType(schema))(value).pipe(
    Effect.mapError(() => malformed(operation))
  )

const conflictReason = (cause: unknown): CodeCommitReviewConflictError["reason"] | null => {
  if (Predicate.isTagged(cause, "RevisionNotCurrentException")) return "revision-changed"
  if (Predicate.isTagged(cause, "TipOfSourceReferenceIsDifferentException")) return "source-commit-changed"
  if (Predicate.isTagged(cause, "PullRequestAlreadyClosedException")) return "pull-request-closed"
  if (Predicate.isTagged(cause, "PullRequestCannotBeApprovedByAuthorException")) return "approval-by-author"
  if (Predicate.isTagged(cause, "MaximumNumberOfApprovalsExceededException")) {
    return "approval-rules-unsatisfied"
  }
  if (Predicate.isTagged(cause, "PullRequestApprovalRulesNotSatisfiedException")) {
    return "approval-rules-unsatisfied"
  }
  if (Predicate.isTagged(cause, "RepositoryNotAssociatedWithPullRequestException")) return "repository-changed"
  if (Predicate.isTagged(cause, "CommitDoesNotExistException")) return "source-commit-changed"
  if (
    Predicate.isTagged(cause, "CommentContentSizeLimitExceededException") ||
    Predicate.isTagged(cause, "InvalidClientRequestTokenException")
  ) return "revision-changed"
  if (
    Predicate.isTagged(cause, "ConcurrentReferenceUpdateException") ||
    Predicate.isTagged(cause, "ManualMergeRequiredException")
  ) return "merge-conflict"
  return null
}

const mapProviderError = (operation: string) => (error: AwsClientError): CodeCommitReviewError => {
  if (error._tag !== "AwsApiError") return error
  const reason = conflictReason(error.cause)
  if (reason !== null) return new CodeCommitReviewConflictError({ operation, reason })
  if (
    Predicate.isTagged(error.cause, "PullRequestDoesNotExistException") ||
    Predicate.isTagged(error.cause, "RepositoryDoesNotExistException")
  ) return new CodeCommitReadNotFoundError({ operation })
  return error
}

const targetConflict = (
  target: CodeCommitReviewTarget,
  pullRequest: CodeCommitPullRequestRevision
): CodeCommitReviewConflictError["reason"] | null => {
  if (pullRequest.repositoryName !== target.repositoryName) return "repository-changed"
  if (pullRequest.status !== "OPEN") return "pull-request-closed"
  if (pullRequest.revisionId !== target.revisionId) return "revision-changed"
  if (pullRequest.sourceCommit !== target.sourceCommit) return "source-commit-changed"
  if (pullRequest.destinationCommit !== target.destinationCommit) return "destination-commit-changed"
  if (pullRequest.destinationReference !== target.destinationReference) return "destination-reference-changed"
  return null
}

const arnAccountId = (arn: string): string | null => {
  const fields = arn.trim().split(":")
  const accountId = fields[4]
  return fields[0]?.toLowerCase() === "arn" && accountId !== undefined && /^[0-9]{12}$/u.test(accountId)
    ? accountId
    : null
}

const approvalIdentityMatches = (
  identity: CodeCommitAccountIdentity,
  approvalArn: string
): boolean => {
  const caller = identity.arn.trim().toLowerCase()
  const approver = approvalArn.trim().toLowerCase()
  if (caller === approver) return true
  return arnAccountId(approvalArn) === identity.accountId && identityMatches(identity.arn, approvalArn)
}

const preflightTarget = Effect.fn("CodeCommitReviewClient.preflightTarget")(function*(
  readClient: CodeCommitReadClient["Service"],
  target: CodeCommitReviewTarget
) {
  const pullRequest = yield* readClient.getPullRequest({
    account: target.account,
    pullRequestId: target.pullRequestId
  })
  const reason = targetConflict(target, pullRequest)
  if (reason !== null) return yield* new CodeCommitReviewConflictError({ operation: "preflight", reason })
  return pullRequest
})

const commentSummary = (tag: CodeCommitReviewAction["_tag"]): string => {
  switch (tag) {
    case "request-review":
      return "Review request posted to the pull request"
    case "request-changes":
      return "Change request posted to the pull request"
    case "comment":
      return "Comment posted to the pull request"
    case "approve":
      return "Pull request revision approved"
    case "revoke-approval":
      return "Pull request approval revoked"
  }
}

const commentMarker = (clientRequestToken: string): string =>
  `${COMMENT_MARKER_PREFIX}${clientRequestToken}${COMMENT_MARKER_SUFFIX}`

const withCommentMarker = <
  A extends Extract<CodeCommitReviewAction, { readonly content: string }>
>(action: A): A => ({
  ...action,
  content: `${action.content}\n\n${commentMarker(action.clientRequestToken)}`
})

/** Public review operations implemented over injectable read and raw-provider boundaries. */
export interface CodeCommitReviewClientService {
  readonly preflight: (
    action: CodeCommitReviewAction
  ) => Effect.Effect<CodeCommitPullRequestRevision, CodeCommitReviewError>
  readonly execute: (
    action: CodeCommitReviewAction
  ) => Effect.Effect<CodeCommitReviewReceipt, CodeCommitReviewError>
  readonly reconcile: (
    action: CodeCommitReviewAction
  ) => Effect.Effect<CodeCommitReviewReconciliation, CodeCommitReviewError>
}

/** Schema-decoded CodeCommit review service. */
export class CodeCommitReviewClient extends Context.Service<
  CodeCommitReviewClient,
  CodeCommitReviewClientService
>()("@knpkv/codecommit-core/CodeCommitReviewClient") {
  /** Review client implementation requiring read and raw mutation providers. */
  static readonly layer = Layer.effect(
    CodeCommitReviewClient,
    Effect.gen(function*() {
      const provider = yield* CodeCommitReviewProvider
      const readClient = yield* CodeCommitReadClient

      const preflight = (action: CodeCommitReviewAction) => preflightTarget(readClient, action.target)

      const execute = Effect.fn("CodeCommitReviewClient.execute")(function*(action: CodeCommitReviewAction) {
        switch (action._tag) {
          case "request-review":
          case "request-changes":
          case "comment": {
            yield* preflightTarget(readClient, action.target)
            const raw = yield* provider.postComment(withCommentMarker(action)).pipe(
              Effect.mapError(mapProviderError("post-comment"))
            )
            const response = yield* decodeProvider("post-comment", RawCommentResponse, raw)
            return new CodeCommitReviewReceipt({
              operationId: `comment:${response.comment.commentId}`,
              summary: commentSummary(action._tag)
            })
          }
          case "approve":
          case "revoke-approval": {
            yield* preflightTarget(readClient, action.target)
            yield* provider.updateApprovalState(action).pipe(
              Effect.mapError(mapProviderError("update-approval"))
            )
            return new CodeCommitReviewReceipt({
              operationId: `approval:${action._tag}:${action.target.pullRequestId}:${action.target.revisionId}`,
              summary: commentSummary(action._tag)
            })
          }
        }
      })

      const reconcileComment = Effect.fn("CodeCommitReviewClient.reconcileComment")(function*(
        action: Extract<
          CodeCommitReviewAction,
          { readonly _tag: "comment" | "request-changes" | "request-review" }
        >
      ) {
        let nextToken: string | null = null
        for (let pageIndex = 0; pageIndex < MAXIMUM_COMMENT_PAGES; pageIndex += 1) {
          const raw: unknown = yield* provider.getCommentsPage({ target: action.target, nextToken }).pipe(
            Effect.mapError(mapProviderError("reconcile-comment"))
          )
          const page: typeof RawCommentsPage.Type = yield* decodeProvider(
            "reconcile-comment",
            RawCommentsPage,
            raw
          )
          const comment = (page.commentsForPullRequestData ?? [])
            .flatMap(({ comments }) => comments ?? [])
            .find(({ clientRequestToken, content }) =>
              clientRequestToken === action.clientRequestToken ||
              content?.includes(commentMarker(action.clientRequestToken)) === true
            )
          if (comment?.commentId !== undefined) {
            return {
              _tag: "succeeded",
              receipt: new CodeCommitReviewReceipt({
                operationId: `comment:${comment.commentId}`,
                summary: commentSummary(action._tag)
              })
            } satisfies CodeCommitReviewReconciliation
          }
          nextToken = page.nextToken ?? null
          if (nextToken === null) return { _tag: "pending" } satisfies CodeCommitReviewReconciliation
        }
        return { _tag: "pending" } satisfies CodeCommitReviewReconciliation
      })

      const reconcile = Effect.fn("CodeCommitReviewClient.reconcile")(function*(action: CodeCommitReviewAction) {
        switch (action._tag) {
          case "request-review":
          case "request-changes":
          case "comment":
            return yield* reconcileComment(action)
          case "approve":
          case "revoke-approval": {
            const identity = yield* readClient.discoverAccount(action.target.account)
            const raw = yield* provider.getApprovalStates(action.target).pipe(
              Effect.mapError(mapProviderError("reconcile-approval"))
            )
            const states = yield* decodeProvider("reconcile-approval", RawApprovalStates, raw)
            const caller = (states.approvals ?? []).find(({ userArn }) =>
              userArn !== undefined && approvalIdentityMatches(identity, userArn)
            )
            const reconciled = action._tag === "approve"
              ? caller?.approvalState === "APPROVE"
              : caller === undefined || caller.approvalState === "REVOKE"
            return reconciled
              ? {
                _tag: "succeeded",
                receipt: new CodeCommitReviewReceipt({
                  operationId: `approval:${action._tag}:${action.target.pullRequestId}:${action.target.revisionId}`,
                  summary: commentSummary(action._tag)
                })
              } satisfies CodeCommitReviewReconciliation
              : { _tag: "pending" } satisfies CodeCommitReviewReconciliation
          }
        }
      })

      return { execute, preflight, reconcile }
    })
  )

  /** Live review client backed by production read and mutation providers. */
  static readonly live = CodeCommitReviewClient.layer.pipe(
    Layer.provide(CodeCommitReviewProviderLive)
  )
}
