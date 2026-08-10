import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { TestClock } from "effect/testing"

import { applyAwsOperationTimeout } from "../src/AwsClient/internal.js"
import { AwsProfileName, AwsRegion } from "../src/Domain.js"
import { AwsApiError } from "../src/Errors.js"
import {
  CodeCommitAccountIdentity,
  CodeCommitBlobContent,
  CodeCommitBlobId,
  CodeCommitChangedFilesPage,
  CodeCommitPullRequestPage,
  CodeCommitPullRequestRevision,
  CodeCommitRepositoryPage
} from "../src/ReadClient/models.js"
import { CodeCommitReadClient, type CodeCommitReadClientService } from "../src/ReadClient/ReadClient.js"
import { CodeCommitReviewConflictError } from "../src/ReviewClient/errors.js"
import { CodeCommitReviewAction } from "../src/ReviewClient/models.js"
import { CodeCommitReviewClient } from "../src/ReviewClient/ReviewClient.js"
import {
  CodeCommitReviewProvider,
  type CodeCommitReviewProviderService,
  makeMergePullRequestRequest,
  makePostCommentForPullRequestRequest,
  makePostCommentReplyRequest,
  makeUpdateCommentRequest,
  reviewProviderTimeoutPolicy
} from "../src/ReviewClient/ReviewProvider.js"

const account = {
  profile: Schema.decodeUnknownSync(AwsProfileName)("production"),
  region: Schema.decodeUnknownSync(AwsRegion)("eu-west-1")
}

const pullRequest = Schema.decodeUnknownSync(CodeCommitPullRequestRevision)({
  pullRequestId: "17",
  revisionId: "revision-17",
  repositoryName: "payments-api",
  title: "Preserve exact revisions",
  description: "Review the immutable head.",
  authorArn: "arn:aws:iam::123456789012:user/alice",
  status: "OPEN",
  sourceReference: "refs/heads/feature/review-actions",
  destinationReference: "refs/heads/main",
  sourceCommit: "head-commit-17",
  destinationCommit: "base-commit-17",
  mergeBase: "merge-base-17",
  creationDate: new Date("2026-07-23T08:00:00.000Z"),
  lastActivityDate: new Date("2026-07-23T09:00:00.000Z")
})

const commentAction = Schema.decodeUnknownSync(CodeCommitReviewAction)({
  _tag: "request-changes",
  target: {
    account,
    repositoryName: "payments-api",
    pullRequestId: "17",
    revisionId: "revision-17",
    sourceCommit: "head-commit-17",
    destinationCommit: "base-commit-17",
    destinationReference: "refs/heads/main"
  },
  content: "Please preserve the authorization binding.",
  clientRequestToken: "0".repeat(64)
})

const inlineCommentAction = Schema.decodeUnknownSync(CodeCommitReviewAction)({
  _tag: "comment",
  target: commentAction.target,
  content: "Preserve the authorization binding.",
  clientRequestToken: "2".repeat(64),
  location: {
    filePath: "src/authorization.ts",
    filePosition: 42,
    relativeFileVersion: "AFTER"
  }
})

const plainCommentAction = Schema.decodeUnknownSync(CodeCommitReviewAction)({
  _tag: "comment",
  target: commentAction.target,
  content: "Preserve the authorization binding.",
  clientRequestToken: "3".repeat(64)
})

const updateCommentAction = Schema.decodeUnknownSync(CodeCommitReviewAction)({
  _tag: "update-comment",
  target: commentAction.target,
  commentId: "comment-1",
  content: "Updated review content.",
  clientRequestToken: "4".repeat(64)
})

const replyCommentAction = Schema.decodeUnknownSync(CodeCommitReviewAction)({
  _tag: "reply-comment",
  target: commentAction.target,
  commentId: "comment-1",
  content: "Resolution reply.",
  clientRequestToken: "5".repeat(64)
})

const mergeAction = Schema.decodeUnknownSync(CodeCommitReviewAction)({
  _tag: "merge",
  target: commentAction.target,
  strategy: "squash"
})

const baseReadClient = (
  overrides: Partial<CodeCommitReadClientService> = {}
): CodeCommitReadClientService => ({
  discoverAccount: () =>
    Effect.succeed(
      new CodeCommitAccountIdentity({
        accountId: "123456789012",
        arn: "arn:aws:iam::123456789012:user/reviewer"
      })
    ),
  listRepositoriesPage: () =>
    Effect.succeed(new CodeCommitRepositoryPage({ repositoryNames: ["payments-api"], nextToken: null })),
  getBlob: () =>
    Effect.succeed(
      new CodeCommitBlobContent({
        blobId: CodeCommitBlobId.make("blob-1"),
        bytes: new Uint8Array()
      })
    ),
  listPullRequestsPage: () =>
    Effect.succeed(new CodeCommitPullRequestPage({ pullRequests: [pullRequest], nextToken: null })),
  streamPullRequests: () => Stream.make(pullRequest),
  getPullRequest: () => Effect.succeed(pullRequest),
  getChangedFilesPage: () =>
    Effect.succeed(new CodeCommitChangedFilesPage({ files: [], nextToken: null, providerPageLimit: 100 })),
  streamChangedFiles: () => Stream.empty,
  ...overrides
})

const baseProvider = (
  overrides: Partial<CodeCommitReviewProviderService> = {}
): CodeCommitReviewProviderService => ({
  postComment: () =>
    Effect.succeed({
      comment: { commentId: "comment-1", clientRequestToken: "0".repeat(64) }
    }),
  updateComment: () =>
    Effect.succeed({
      comment: { commentId: "comment-1" }
    }),
  postReply: () =>
    Effect.succeed({
      comment: { commentId: "reply-1", clientRequestToken: "0".repeat(64) }
    }),
  updateApprovalState: () => Effect.succeed({}),
  mergePullRequest: () =>
    Effect.succeed({
      pullRequest: { pullRequestId: "17", pullRequestStatus: "CLOSED" }
    }),
  getApprovalStates: () => Effect.succeed({ approvals: [] }),
  getCommentsPage: () => Effect.succeed({ commentsForPullRequestData: [], nextToken: undefined }),
  ...overrides
})

const runWithClients = <A, E>(
  readClient: CodeCommitReadClientService,
  provider: CodeCommitReviewProviderService,
  effect: Effect.Effect<A, E, CodeCommitReviewClient>
): Effect.Effect<A, E> =>
  effect.pipe(
    Effect.provide(
      CodeCommitReviewClient.layer.pipe(
        Layer.provide(Layer.merge(
          Layer.succeed(CodeCommitReadClient, readClient),
          Layer.succeed(CodeCommitReviewProvider, provider)
        ))
      )
    )
  )

describe("CodeCommitReviewClient", () => {
  it("retains an exact inline location when decoding a comment action", () => {
    assert.property(inlineCommentAction, "location")
    if ("location" in inlineCommentAction) {
      assert.strictEqual(inlineCommentAction.location.filePath, "src/authorization.ts")
      assert.strictEqual(inlineCommentAction.location.filePosition, 42)
      assert.strictEqual(inlineCommentAction.location.relativeFileVersion, "AFTER")
    }
  })

  it("maps location only for an inline comment provider request", () => {
    const inline = makePostCommentForPullRequestRequest(inlineCommentAction)
    const plain = makePostCommentForPullRequestRequest(plainCommentAction)
    const reviewState = makePostCommentForPullRequestRequest(commentAction)

    assert.strictEqual(inline.location.filePath, "src/authorization.ts")
    assert.strictEqual(inline.location.filePosition, 42)
    assert.strictEqual(inline.location.relativeFileVersion, "AFTER")
    assert.notProperty(plain, "location")
    assert.notProperty(reviewState, "location")
  })

  it("maps update and reply actions to their exact provider requests", () => {
    assert.deepStrictEqual(makeUpdateCommentRequest(updateCommentAction), {
      commentId: "comment-1",
      content: "Updated review content."
    })
    assert.deepStrictEqual(makePostCommentReplyRequest(replyCommentAction), {
      inReplyTo: "comment-1",
      content: "Resolution reply.",
      clientRequestToken: "5".repeat(64)
    })
  })

  it("pins merge requests to the decoded pull-request head", () => {
    assert.deepStrictEqual(makeMergePullRequestRequest(mergeAction), {
      pullRequestId: "17",
      repositoryName: "payments-api",
      sourceCommitId: "head-commit-17"
    })
  })

  it.effect("preflights and executes the selected native merge strategy exactly once", () =>
    Effect.gen(function*() {
      const providerCalls = yield* Ref.make<Array<string>>([])
      const receipt = yield* runWithClients(
        baseReadClient(),
        baseProvider({
          mergePullRequest: (action) =>
            Ref.update(providerCalls, (calls) => [...calls, action.strategy]).pipe(
              Effect.as({ pullRequest: { pullRequestId: "17", pullRequestStatus: "CLOSED" } })
            )
        }),
        Effect.gen(function*() {
          const client = yield* CodeCommitReviewClient
          return yield* client.execute(mergeAction)
        })
      )

      assert.deepStrictEqual(yield* Ref.get(providerCalls), ["squash"])
      assert.strictEqual(receipt.operationId, "merge:squash:17:head-commit-17")
      assert.strictEqual(receipt.summary, "Pull request merged using squash")
    }))

  it.effect("does not call the merge provider when the reviewed head is stale", () =>
    Effect.gen(function*() {
      const providerCalls = yield* Ref.make(0)
      const stalePullRequest = new CodeCommitPullRequestRevision({
        ...pullRequest,
        sourceCommit: "new-head-commit-17"
      })
      const result = yield* runWithClients(
        baseReadClient({ getPullRequest: () => Effect.succeed(stalePullRequest) }),
        baseProvider({
          mergePullRequest: () => Ref.update(providerCalls, (count) => count + 1)
        }),
        Effect.gen(function*() {
          const client = yield* CodeCommitReviewClient
          return yield* Effect.result(client.execute(mergeAction))
        })
      )

      assert.strictEqual(Result.isFailure(result), true)
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, CodeCommitReviewConflictError)
        assert.strictEqual(result.failure.reason, "source-commit-changed")
      }
      assert.strictEqual(yield* Ref.get(providerCalls), 0)
    }))

  it.effect("maps provider approval-rule rejection to a merge conflict", () =>
    Effect.gen(function*() {
      const result = yield* runWithClients(
        baseReadClient(),
        baseProvider({
          mergePullRequest: () =>
            Effect.fail(
              new AwsApiError({
                operation: "MergePullRequestBySquash",
                profile: account.profile,
                region: account.region,
                cause: { _tag: "PullRequestApprovalRulesNotSatisfiedException" }
              })
            )
        }),
        Effect.gen(function*() {
          const client = yield* CodeCommitReviewClient
          return yield* Effect.result(client.execute(mergeAction))
        })
      )

      assert.strictEqual(Result.isFailure(result), true)
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, CodeCommitReviewConflictError)
        assert.strictEqual(result.failure.reason, "approval-rules-unsatisfied")
      }
    }))

  it.effect("preserves an unclassified post-dispatch merge failure for outcome recovery", () =>
    Effect.gen(function*() {
      const providerCalls = yield* Ref.make(0)
      const result = yield* runWithClients(
        baseReadClient(),
        baseProvider({
          mergePullRequest: () =>
            Ref.update(providerCalls, (count) => count + 1).pipe(
              Effect.andThen(Effect.fail(
                new AwsApiError({
                  operation: "mergePullRequestBySquash",
                  profile: account.profile,
                  region: account.region,
                  cause: { _tag: "HttpClientError" }
                })
              ))
            )
        }),
        Effect.gen(function*() {
          const client = yield* CodeCommitReviewClient
          return yield* Effect.result(client.execute(mergeAction))
        })
      )

      assert.strictEqual(yield* Ref.get(providerCalls), 1)
      assert.strictEqual(Result.isFailure(result), true)
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, AwsApiError)
        assert.strictEqual(result.failure.operation, "mergePullRequestBySquash")
      }
    }))

  it.effect("reloads merge reference races while retaining manual strategy conflicts", () =>
    Effect.gen(function*() {
      const cases: ReadonlyArray<
        readonly [
          "ConcurrentReferenceUpdateException" | "ManualMergeRequiredException" | "ReferenceDoesNotExistException",
          CodeCommitReviewConflictError["reason"]
        ]
      > = [
        ["ConcurrentReferenceUpdateException", "destination-reference-changed"],
        ["ReferenceDoesNotExistException", "destination-reference-changed"],
        ["ManualMergeRequiredException", "merge-conflict"]
      ]

      for (const [tag, expectedReason] of cases) {
        const result = yield* runWithClients(
          baseReadClient(),
          baseProvider({
            mergePullRequest: () =>
              Effect.fail(
                new AwsApiError({
                  operation: "MergePullRequestBySquash",
                  profile: account.profile,
                  region: account.region,
                  cause: { _tag: tag }
                })
              )
          }),
          Effect.gen(function*() {
            const client = yield* CodeCommitReviewClient
            return yield* Effect.result(client.execute(mergeAction))
          })
        )

        assert.strictEqual(Result.isFailure(result), true)
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, CodeCommitReviewConflictError)
          assert.strictEqual(result.failure.reason, expectedReason)
        }
      }
    }))

  it.effect("keeps accepted merge receipts supervised past the ordinary operation timeout", () =>
    Effect.gen(function*() {
      const mergeTimeout = reviewProviderTimeoutPolicy("mergePullRequestBySquash") === "none"
        ? null
        : "30 seconds"
      const readTimeout = reviewProviderTimeoutPolicy("getPullRequest") === "none" ? null : "30 seconds"
      const supervisedMerge = yield* Effect.forkChild(applyAwsOperationTimeout(
        "mergePullRequestBySquash",
        account,
        Effect.sleep("31 seconds").pipe(Effect.as("merge-receipt")),
        mergeTimeout
      ))
      const ordinaryRead = yield* Effect.forkChild(applyAwsOperationTimeout(
        "getPullRequest",
        account,
        Effect.never,
        readTimeout
      ))

      yield* TestClock.adjust("31 seconds")

      assert.strictEqual(yield* Fiber.join(supervisedMerge), "merge-receipt")
      const readResult = yield* Fiber.join(ordinaryRead).pipe(Effect.result)
      assert.strictEqual(Result.isFailure(readResult), true)
      if (Result.isFailure(readResult)) assert.instanceOf(readResult.failure, AwsApiError)
    }))

  it.effect("executes and reconciles update and reply actions without replay", () =>
    Effect.gen(function*() {
      const calls = yield* Ref.make<Array<string>>([])
      const result = yield* runWithClients(
        baseReadClient(),
        baseProvider({
          updateComment: (action) =>
            Ref.update(calls, (items) => [...items, `update:${action.commentId}`]).pipe(
              Effect.as({ comment: { commentId: action.commentId } })
            ),
          postReply: () =>
            Ref.update(calls, (items) => [...items, "reply"]).pipe(
              Effect.as({ comment: { commentId: "reply-1" } })
            ),
          getCommentsPage: () =>
            Effect.succeed({
              commentsForPullRequestData: [{
                comments: [{
                  commentId: "comment-1",
                  content: `updated\n\n<!-- knpkv-codecommit-review:${"4".repeat(64)} -->`
                }, {
                  commentId: "reply-1",
                  inReplyTo: "comment-1",
                  clientRequestToken: replyCommentAction.clientRequestToken
                }]
              }],
              nextToken: undefined
            })
        }),
        Effect.gen(function*() {
          const client = yield* CodeCommitReviewClient
          const updated = yield* client.execute(updateCommentAction)
          const replied = yield* client.execute(replyCommentAction)
          const reconciled = yield* client.reconcile(updateCommentAction)
          const reconciledReply = yield* client.reconcile(replyCommentAction)
          return { updated, replied, reconciled, reconciledReply }
        })
      )

      assert.strictEqual(result.updated.operationId, "comment:comment-1")
      assert.strictEqual(result.replied.operationId, "comment:reply-1")
      assert.strictEqual(result.reconciled._tag, "succeeded")
      assert.strictEqual(result.reconciledReply._tag, "succeeded")
      assert.deepStrictEqual(yield* Ref.get(calls), ["update:comment-1", "reply"])
    }))

  it.effect("does not reconcile a reply with the wrong parent comment", () =>
    Effect.gen(function*() {
      const result = yield* runWithClients(
        baseReadClient(),
        baseProvider({
          getCommentsPage: () =>
            Effect.succeed({
              commentsForPullRequestData: [{
                comments: [{
                  commentId: "reply-1",
                  inReplyTo: "different-comment",
                  clientRequestToken: replyCommentAction.clientRequestToken
                }]
              }]
            })
        }),
        Effect.gen(function*() {
          const client = yield* CodeCommitReviewClient
          return yield* client.reconcile(replyCommentAction)
        })
      )

      assert.strictEqual(result._tag, "pending")
    }))

  it.effect("blocks a stale immutable revision before any provider mutation", () =>
    Effect.gen(function*() {
      const mutationCalls = yield* Ref.make(0)
      const stale = Schema.decodeUnknownSync(CodeCommitPullRequestRevision)({
        ...pullRequest,
        revisionId: "revision-18",
        sourceCommit: "head-commit-18"
      })
      const result = yield* runWithClients(
        baseReadClient({ getPullRequest: () => Effect.succeed(stale) }),
        baseProvider({
          postComment: () => Ref.update(mutationCalls, (count) => count + 1)
        }),
        Effect.gen(function*() {
          const client = yield* CodeCommitReviewClient
          return yield* client.preflight(commentAction).pipe(Effect.result)
        })
      )

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, CodeCommitReviewConflictError)
      assert.strictEqual(yield* Ref.get(mutationCalls), 0)
    }))

  it.effect("re-checks a comment target immediately before the provider write", () =>
    Effect.gen(function*() {
      const mutationCalls = yield* Ref.make(0)
      const stale = Schema.decodeUnknownSync(CodeCommitPullRequestRevision)({
        ...pullRequest,
        revisionId: "revision-18",
        sourceCommit: "head-commit-18"
      })
      const result = yield* runWithClients(
        baseReadClient({ getPullRequest: () => Effect.succeed(stale) }),
        baseProvider({
          postComment: () => Ref.update(mutationCalls, (count) => count + 1)
        }),
        Effect.gen(function*() {
          const client = yield* CodeCommitReviewClient
          return yield* client.execute(commentAction).pipe(Effect.result)
        })
      )

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, CodeCommitReviewConflictError)
      assert.strictEqual(yield* Ref.get(mutationCalls), 0)
    }))

  it.effect("classifies deterministic comment validation failures as terminal conflicts", () =>
    Effect.gen(function*() {
      const result = yield* runWithClients(
        baseReadClient(),
        baseProvider({
          postComment: () =>
            Effect.fail(
              new AwsApiError({
                operation: "postCommentForPullRequest",
                profile: account.profile,
                region: account.region,
                cause: { _tag: "CommentContentSizeLimitExceededException" }
              })
            )
        }),
        Effect.gen(function*() {
          const client = yield* CodeCommitReviewClient
          return yield* client.execute(commentAction).pipe(Effect.result)
        })
      )

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, CodeCommitReviewConflictError)
    }))

  it.effect("classifies an invalid inline position as a terminal conflict", () =>
    Effect.gen(function*() {
      const result = yield* runWithClients(
        baseReadClient(),
        baseProvider({
          postComment: () =>
            Effect.fail(
              new AwsApiError({
                operation: "postCommentForPullRequest",
                profile: account.profile,
                region: account.region,
                cause: { _tag: "InvalidFilePositionException" }
              })
            )
        }),
        Effect.gen(function*() {
          const client = yield* CodeCommitReviewClient
          return yield* client.execute(inlineCommentAction).pipe(Effect.result)
        })
      )

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, CodeCommitReviewConflictError)
    }))

  it.effect("classifies the maximum-approval rejection as a terminal conflict", () =>
    Effect.gen(function*() {
      const approveAction = Schema.decodeUnknownSync(CodeCommitReviewAction)({
        _tag: "approve",
        target: commentAction.target
      })
      const result = yield* runWithClients(
        baseReadClient(),
        baseProvider({
          updateApprovalState: () =>
            Effect.fail(
              new AwsApiError({
                operation: "updatePullRequestApprovalState",
                profile: account.profile,
                region: account.region,
                cause: { _tag: "MaximumNumberOfApprovalsExceededException" }
              })
            )
        }),
        Effect.gen(function*() {
          const client = yield* CodeCommitReviewClient
          return yield* client.execute(approveAction).pipe(Effect.result)
        })
      )

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, CodeCommitReviewConflictError)
    }))

  it.effect("re-checks an approval target immediately before the provider write", () =>
    Effect.gen(function*() {
      const mutationCalls = yield* Ref.make(0)
      const stale = Schema.decodeUnknownSync(CodeCommitPullRequestRevision)({
        ...pullRequest,
        repositoryName: "different-repository"
      })
      const approveAction = Schema.decodeUnknownSync(CodeCommitReviewAction)({
        _tag: "approve",
        target: commentAction.target
      })
      const result = yield* runWithClients(
        baseReadClient({ getPullRequest: () => Effect.succeed(stale) }),
        baseProvider({
          updateApprovalState: () => Ref.update(mutationCalls, (count) => count + 1)
        }),
        Effect.gen(function*() {
          const client = yield* CodeCommitReviewClient
          return yield* client.execute(approveAction).pipe(Effect.result)
        })
      )

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, CodeCommitReviewConflictError)
      assert.strictEqual(yield* Ref.get(mutationCalls), 0)
    }))

  it.effect("returns a safe receipt for an idempotent review comment", () =>
    Effect.gen(function*() {
      const observedToken = yield* Ref.make("")
      const observedContent = yield* Ref.make("")
      const receipt = yield* runWithClients(
        baseReadClient(),
        baseProvider({
          postComment: (action) =>
            Ref.set(observedToken, action.clientRequestToken).pipe(
              Effect.andThen(Ref.set(observedContent, action.content)),
              Effect.as({
                comment: {
                  commentId: "comment-42",
                  clientRequestToken: action.clientRequestToken
                }
              })
            )
        }),
        Effect.gen(function*() {
          const client = yield* CodeCommitReviewClient
          return yield* client.execute(commentAction)
        })
      )

      assert.strictEqual(receipt.operationId, "comment:comment-42")
      assert.strictEqual(yield* Ref.get(observedToken), "0".repeat(64))
      assert.include(yield* Ref.get(observedContent), `knpkv-codecommit-review:${"0".repeat(64)}`)
    }))

  it.effect("reconciles a comment by its durable content marker when AWS omits the token", () =>
    Effect.gen(function*() {
      const result = yield* runWithClients(
        baseReadClient(),
        baseProvider({
          getCommentsPage: () =>
            Effect.succeed({
              commentsForPullRequestData: [{
                comments: [{
                  commentId: "comment-marker-reconciled",
                  content: `${commentAction.content}\n\n<!-- knpkv-codecommit-review:${"0".repeat(64)} -->`
                }]
              }]
            })
        }),
        Effect.gen(function*() {
          const client = yield* CodeCommitReviewClient
          return yield* client.reconcile(commentAction)
        })
      )

      assert.strictEqual(result._tag, "succeeded")
      if (result._tag === "succeeded") {
        assert.strictEqual(result.receipt.operationId, "comment:comment-marker-reconciled")
      }
    }))

  it.effect("does not reconcile a comment carrying a different durable marker", () =>
    Effect.gen(function*() {
      const result = yield* runWithClients(
        baseReadClient(),
        baseProvider({
          getCommentsPage: () =>
            Effect.succeed({
              commentsForPullRequestData: [{
                comments: [{
                  commentId: "different-comment",
                  content: `Unrelated\n\n<!-- knpkv-codecommit-review:${"1".repeat(64)} -->`
                }]
              }]
            })
        }),
        Effect.gen(function*() {
          const client = yield* CodeCommitReviewClient
          return yield* client.reconcile(commentAction)
        })
      )

      assert.strictEqual(result._tag, "pending")
    }))

  it.effect("reconciles an ambiguous comment by token without replaying the write", () =>
    Effect.gen(function*() {
      const mutationCalls = yield* Ref.make(0)
      const result = yield* runWithClients(
        baseReadClient(),
        baseProvider({
          postComment: () => Ref.update(mutationCalls, (count) => count + 1),
          getCommentsPage: () =>
            Effect.succeed({
              commentsForPullRequestData: [{
                comments: [{
                  commentId: "comment-reconciled",
                  clientRequestToken: "0".repeat(64)
                }]
              }]
            })
        }),
        Effect.gen(function*() {
          const client = yield* CodeCommitReviewClient
          return yield* client.reconcile(commentAction)
        })
      )

      assert.strictEqual(result._tag, "succeeded")
      if (result._tag === "succeeded") {
        assert.strictEqual(result.receipt.operationId, "comment:comment-reconciled")
      }
      assert.strictEqual(yield* Ref.get(mutationCalls), 0)
    }))

  it.effect("reconciles a revoked approval when the caller is absent while approval remains pending", () =>
    Effect.gen(function*() {
      const revokeAction = Schema.decodeUnknownSync(CodeCommitReviewAction)({
        _tag: "revoke-approval",
        target: commentAction.target
      })
      const approveAction = Schema.decodeUnknownSync(CodeCommitReviewAction)({
        _tag: "approve",
        target: commentAction.target
      })
      const results = yield* runWithClients(
        baseReadClient(),
        baseProvider({ getApprovalStates: () => Effect.succeed({ approvals: [] }) }),
        Effect.gen(function*() {
          const client = yield* CodeCommitReviewClient
          return {
            approve: yield* client.reconcile(approveAction),
            revoke: yield* client.reconcile(revokeAction)
          }
        })
      )

      assert.strictEqual(results.revoke._tag, "succeeded")
      assert.strictEqual(results.approve._tag, "pending")
    }))

  it.effect("reconciles an explicit REVOKE state while keeping APPROVE pending", () =>
    Effect.gen(function*() {
      const revokeAction = Schema.decodeUnknownSync(CodeCommitReviewAction)({
        _tag: "revoke-approval",
        target: commentAction.target
      })
      const runForState = (approvalState: "APPROVE" | "REVOKE") =>
        runWithClients(
          baseReadClient(),
          baseProvider({
            getApprovalStates: () =>
              Effect.succeed({
                approvals: [{
                  userArn: "arn:aws:iam::123456789012:user/reviewer",
                  approvalState
                }]
              })
          }),
          Effect.gen(function*() {
            const client = yield* CodeCommitReviewClient
            return yield* client.reconcile(revokeAction)
          })
        )
      const revoked = yield* runForState("REVOKE")
      const approved = yield* runForState("APPROVE")

      assert.strictEqual(revoked._tag, "succeeded")
      assert.strictEqual(approved._tag, "pending")
    }))

  it.effect("normalizes assumed-role identities when reconciling approvals", () =>
    Effect.gen(function*() {
      const approveAction = Schema.decodeUnknownSync(CodeCommitReviewAction)({
        _tag: "approve",
        target: commentAction.target
      })
      const result = yield* runWithClients(
        baseReadClient({
          discoverAccount: () =>
            Effect.succeed(
              new CodeCommitAccountIdentity({
                accountId: "123456789012",
                arn: "arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_Reviewer_abc/alice"
              })
            )
        }),
        baseProvider({
          getApprovalStates: () =>
            Effect.succeed({
              approvals: [{
                userArn: "arn:aws:iam::123456789012:user/Alice",
                approvalState: "APPROVE"
              }]
            })
        }),
        Effect.gen(function*() {
          const client = yield* CodeCommitReviewClient
          return yield* client.reconcile(approveAction)
        })
      )

      assert.strictEqual(result._tag, "succeeded")
    }))

  it.effect("does not reconcile an approval from another account with the same username", () =>
    Effect.gen(function*() {
      const approveAction = Schema.decodeUnknownSync(CodeCommitReviewAction)({
        _tag: "approve",
        target: commentAction.target
      })
      const result = yield* runWithClients(
        baseReadClient({
          discoverAccount: () =>
            Effect.succeed(
              new CodeCommitAccountIdentity({
                accountId: "111111111111",
                arn: "arn:aws:sts::111111111111:assumed-role/Reviewer/alice"
              })
            )
        }),
        baseProvider({
          getApprovalStates: () =>
            Effect.succeed({
              approvals: [{
                userArn: "arn:aws:iam::222222222222:user/alice",
                approvalState: "APPROVE"
              }]
            })
        }),
        Effect.gen(function*() {
          const client = yield* CodeCommitReviewClient
          return yield* client.reconcile(approveAction)
        })
      )

      assert.strictEqual(result._tag, "pending")
    }))

  it.effect("keeps an approval pending for a different normalized identity", () =>
    Effect.gen(function*() {
      const approveAction = Schema.decodeUnknownSync(CodeCommitReviewAction)({
        _tag: "approve",
        target: commentAction.target
      })
      const result = yield* runWithClients(
        baseReadClient({
          discoverAccount: () =>
            Effect.succeed(
              new CodeCommitAccountIdentity({
                accountId: "123456789012",
                arn: "arn:aws:sts::123456789012:assumed-role/Reviewer/alice"
              })
            )
        }),
        baseProvider({
          getApprovalStates: () =>
            Effect.succeed({
              approvals: [{
                userArn: "arn:aws:iam::123456789012:user/bob",
                approvalState: "APPROVE"
              }]
            })
        }),
        Effect.gen(function*() {
          const client = yield* CodeCommitReviewClient
          return yield* client.reconcile(approveAction)
        })
      )

      assert.strictEqual(result._tag, "pending")
    }))

  it.effect("distinguishes approve and revoke receipts on the same revision", () =>
    Effect.gen(function*() {
      const approveAction = Schema.decodeUnknownSync(CodeCommitReviewAction)({
        _tag: "approve",
        target: commentAction.target
      })
      const revokeAction = Schema.decodeUnknownSync(CodeCommitReviewAction)({
        _tag: "revoke-approval",
        target: commentAction.target
      })
      const receipts = yield* runWithClients(
        baseReadClient(),
        baseProvider(),
        Effect.gen(function*() {
          const client = yield* CodeCommitReviewClient
          return {
            approve: yield* client.execute(approveAction),
            revoke: yield* client.execute(revokeAction)
          }
        })
      )

      assert.notStrictEqual(receipts.approve.operationId, receipts.revoke.operationId)
      assert.strictEqual(receipts.approve.operationId, "approval:approve:17:revision-17")
      assert.strictEqual(receipts.revoke.operationId, "approval:revoke-approval:17:revision-17")
    }))
})
