import * as codecommit from "@distilled.cloud/aws/codecommit"
import * as sts from "@distilled.cloud/aws/sts"
import { NodeHttpClient } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { afterEach, vi } from "vitest"

import * as AwsClientConfig from "../src/AwsClientConfig.js"
import { AwsApiError } from "../src/Errors.js"
import { isAmbiguousMergeProviderError } from "../src/ReviewClient/errors.js"
import { CodeCommitReviewAction } from "../src/ReviewClient/models.js"
import { CodeCommitReviewProvider, CodeCommitReviewProviderLive } from "../src/ReviewClient/ReviewProvider.js"

vi.mock("@aws-sdk/credential-providers", () => ({
  fromNodeProviderChain: () => async () => ({
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
    sessionToken: "test-session-token"
  })
}))

vi.mock("@distilled.cloud/aws/codecommit", () => ({
  getRepository: vi.fn(),
  mergePullRequestByFastForward: vi.fn(),
  mergePullRequestBySquash: vi.fn(),
  mergePullRequestByThreeWay: vi.fn()
}))

vi.mock("@distilled.cloud/aws/sts", () => ({
  getCallerIdentity: vi.fn()
}))

const mergeAction = Schema.decodeUnknownSync(CodeCommitReviewAction)({
  _tag: "merge",
  target: {
    account: { profile: "production", region: "eu-west-1" },
    repositoryName: "payments-api",
    pullRequestId: "17",
    revisionId: "revision-17",
    sourceCommit: "head-commit-17",
    destinationCommit: "base-commit-17",
    destinationReference: "refs/heads/main",
    expectedCallerAccountId: "123456789012",
    expectedRepositoryAccountId: "123456789012"
  },
  strategy: "squash"
})

const runWithLiveProvider = <A, E>(effect: Effect.Effect<A, E, CodeCommitReviewProvider>) =>
  effect.pipe(
    Effect.provide(
      CodeCommitReviewProviderLive.pipe(
        Layer.provide([AwsClientConfig.Default, NodeHttpClient.layerFetch])
      )
    )
  )

describe.sequential("CodeCommitReviewProvider", () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it.effect("keeps an unknown repository preflight failure outside merge outcome recovery", () =>
    Effect.gen(function*() {
      let mergeDispatches = 0
      vi.mocked(codecommit.getRepository).mockImplementation(() => Effect.fail(new Error("repository unavailable")))
      vi.mocked(codecommit.mergePullRequestBySquash).mockImplementation(() =>
        Effect.sync(() => {
          mergeDispatches += 1
          return {}
        })
      )

      const result = yield* runWithLiveProvider(
        Effect.gen(function*() {
          const provider = yield* CodeCommitReviewProvider
          return yield* Effect.result(provider.mergePullRequest(mergeAction, () => Effect.void))
        })
      )

      assert.strictEqual(mergeDispatches, 0)
      assert.strictEqual(Result.isFailure(result), true)
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, AwsApiError)
        assert.strictEqual(result.failure.operation, "getRepository")
        assert.strictEqual(isAmbiguousMergeProviderError(result.failure), false)
      }
    }))

  it.effect("keeps an unknown caller-identity preflight failure outside merge outcome recovery", () =>
    Effect.gen(function*() {
      let mergeDispatches = 0
      vi.mocked(codecommit.getRepository).mockImplementation(() =>
        Effect.succeed({
          repositoryMetadata: { accountId: "123456789012", repositoryName: "payments-api" }
        })
      )
      vi.mocked(sts.getCallerIdentity).mockImplementation(() => Effect.fail(new Error("identity unavailable")))
      vi.mocked(codecommit.mergePullRequestBySquash).mockImplementation(() =>
        Effect.sync(() => {
          mergeDispatches += 1
          return {}
        })
      )

      const result = yield* runWithLiveProvider(
        Effect.gen(function*() {
          const provider = yield* CodeCommitReviewProvider
          return yield* Effect.result(provider.mergePullRequest(mergeAction, () => Effect.void))
        })
      )

      assert.strictEqual(mergeDispatches, 0)
      assert.strictEqual(Result.isFailure(result), true)
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, AwsApiError)
        assert.strictEqual(result.failure.operation, "getCallerIdentity")
        assert.strictEqual(isAmbiguousMergeProviderError(result.failure), false)
      }
    }))

  it.effect("keeps an unknown post-dispatch failure inside merge outcome recovery", () =>
    Effect.gen(function*() {
      let mergeDispatches = 0
      vi.mocked(codecommit.getRepository).mockImplementation(() =>
        Effect.succeed({
          repositoryMetadata: { accountId: "123456789012", repositoryName: "payments-api" }
        })
      )
      vi.mocked(sts.getCallerIdentity).mockImplementation(() =>
        Effect.succeed({
          Account: "123456789012",
          Arn: "arn:aws:iam::123456789012:user/reviewer"
        })
      )
      vi.mocked(codecommit.mergePullRequestBySquash).mockImplementation(() =>
        Effect.sync(() => {
          mergeDispatches += 1
        }).pipe(Effect.andThen(Effect.fail(new Error("merge outcome unavailable"))))
      )

      const result = yield* runWithLiveProvider(
        Effect.gen(function*() {
          const provider = yield* CodeCommitReviewProvider
          return yield* Effect.result(provider.mergePullRequest(mergeAction, () => Effect.void))
        })
      )

      assert.strictEqual(mergeDispatches, 1)
      assert.strictEqual(Result.isFailure(result), true)
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, AwsApiError)
        assert.strictEqual(result.failure.operation, "mergePullRequestBySquash")
        assert.strictEqual(isAmbiguousMergeProviderError(result.failure), true)
      }
    }))
})
