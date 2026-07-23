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
  mergeFastForward: () => Effect.succeed({ commitId: "head-commit-17" }),
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

  it.effect("returns a safe receipt for an idempotent review comment", () =>
    Effect.gen(function*() {
      const observedToken = yield* Ref.make("")
      const receipt = yield* runWithClients(
        baseReadClient(),
        baseProvider({
          postComment: (action) =>
            Ref.set(observedToken, action.clientRequestToken).pipe(
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

  it.effect("binds fast-forward execution to the authorized destination commit and branch", () =>
    Effect.gen(function*() {
      const observedTarget = yield* Ref.make<CodeCommitReviewAction["target"] | null>(null)
      const mergeAction = Schema.decodeUnknownSync(CodeCommitReviewAction)({
        _tag: "merge-fast-forward",
        target: commentAction.target
      })
      const receipt = yield* runWithClients(
        baseReadClient(),
        baseProvider({
          mergeFastForward: (action) =>
            Ref.set(observedTarget, action.target).pipe(
              Effect.as({ commitId: action.target.sourceCommit })
            )
        }),
        Effect.gen(function*() {
          const client = yield* CodeCommitReviewClient
          return yield* client.execute(mergeAction)
        })
      )

      assert.strictEqual(receipt.operationId, "merge:17:head-commit-17")
      assert.deepInclude(yield* Ref.get(observedTarget), {
        destinationCommit: "base-commit-17",
        destinationReference: "refs/heads/main"
      })
    }))
})
