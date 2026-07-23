import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

import { AwsProfileName, AwsRegion } from "../src/Domain.js"
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
import { CodeCommitReviewProvider, type CodeCommitReviewProviderService } from "../src/ReviewClient/ReviewProvider.js"

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
  updateApprovalState: () => Effect.succeed({}),
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
