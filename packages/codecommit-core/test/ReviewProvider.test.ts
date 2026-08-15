import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import { AwsApiError } from "../src/Errors.js"
import { isAmbiguousMergeProviderError } from "../src/ReviewClient/errors.js"
import { CodeCommitReviewAction } from "../src/ReviewClient/models.js"
import { authorizeAndMerge, type CodeCommitMergeOperations } from "../src/ReviewClient/ReviewProvider.js"

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

const unused = (operation: string) => Effect.die(new Error(`Unexpected ${operation} call`))

const mergeOperations = (
  overrides: Partial<CodeCommitMergeOperations>
): CodeCommitMergeOperations => ({
  getRepository: () => unused("getRepository"),
  getCallerIdentity: () => unused("getCallerIdentity"),
  mergeFastForward: () => unused("mergeFastForward"),
  mergeSquash: () => unused("mergeSquash"),
  mergeThreeWay: () => unused("mergeThreeWay"),
  ...overrides
})

describe("CodeCommitReviewProvider", () => {
  it.effect("keeps an unknown repository preflight failure outside merge outcome recovery", () =>
    Effect.gen(function*() {
      let mergeDispatches = 0
      const operations = mergeOperations({
        getRepository: () => Effect.fail(new Error("repository unavailable")),
        mergeSquash: () =>
          Effect.sync(() => {
            mergeDispatches += 1
            return {}
          })
      })

      const result = yield* Effect.result(authorizeAndMerge(mergeAction, () => Effect.void, operations))

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
      const operations = mergeOperations({
        getRepository: () =>
          Effect.succeed({
            repositoryMetadata: { accountId: "123456789012", repositoryName: "payments-api" }
          }),
        getCallerIdentity: () => Effect.fail(new Error("identity unavailable")),
        mergeSquash: () =>
          Effect.sync(() => {
            mergeDispatches += 1
            return {}
          })
      })

      const result = yield* Effect.result(authorizeAndMerge(mergeAction, () => Effect.void, operations))

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
      const operations = mergeOperations({
        getRepository: () =>
          Effect.succeed({
            repositoryMetadata: { accountId: "123456789012", repositoryName: "payments-api" }
          }),
        getCallerIdentity: () =>
          Effect.succeed({
            Account: "123456789012",
            Arn: "arn:aws:iam::123456789012:user/reviewer"
          }),
        mergeSquash: () =>
          Effect.sync(() => {
            mergeDispatches += 1
          }).pipe(Effect.andThen(Effect.fail(new Error("merge outcome unavailable"))))
      })

      const result = yield* Effect.result(authorizeAndMerge(mergeAction, () => Effect.void, operations))

      assert.strictEqual(mergeDispatches, 1)
      assert.strictEqual(Result.isFailure(result), true)
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, AwsApiError)
        assert.strictEqual(result.failure.operation, "mergePullRequestBySquash")
        assert.strictEqual(isAmbiguousMergeProviderError(result.failure), true)
      }
    }))
})
