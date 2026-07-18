import { assert, describe, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

import { AwsProfileName, AwsRegion } from "../src/Domain.js"
import { AwsApiError } from "../src/Errors.js"
import {
  CodeCommitBlobTooLargeError,
  CodeCommitMalformedResponseError,
  CodeCommitReadNotFoundError
} from "../src/ReadClient/errors.js"
import { CODECOMMIT_BLOB_MAXIMUM_BYTES } from "../src/ReadClient/models.js"
import { CodeCommitReadClient } from "../src/ReadClient/ReadClient.js"
import { CodeCommitReadProvider, type CodeCommitReadProviderService } from "../src/ReadClient/ReadProvider.js"

const account = {
  profile: Schema.decodeUnknownSync(AwsProfileName)("production"),
  region: Schema.decodeUnknownSync(AwsRegion)("eu-west-1")
}

const pullRequestResponse = (pullRequestId = "17") => ({
  pullRequest: {
    pullRequestId,
    revisionId: `revision-${pullRequestId}`,
    title: "Preserve exact revisions",
    description: "Expose immutable base and head commits.",
    authorArn: "arn:aws:sts::123456789012:assumed-role/Developer/alice",
    pullRequestStatus: "OPEN",
    pullRequestTargets: [{
      repositoryName: "payments-api",
      sourceReference: "refs/heads/feature/read-adapter",
      destinationReference: "refs/heads/main",
      sourceCommit: "head-commit-17",
      destinationCommit: "base-commit-17",
      mergeBase: "merge-base-17"
    }],
    creationDate: new Date("2026-07-16T08:00:00.000Z"),
    lastActivityDate: new Date("2026-07-16T09:00:00.000Z")
  }
})

const providerLayer = (provider: CodeCommitReadProviderService) => Layer.succeed(CodeCommitReadProvider, provider)

const runWithProvider = <A, E>(
  provider: CodeCommitReadProviderService,
  effect: Effect.Effect<A, E, CodeCommitReadClient>
) =>
  effect.pipe(
    Effect.provide(CodeCommitReadClient.layer.pipe(Layer.provide(providerLayer(provider))))
  )

const baseProvider = (overrides: Partial<CodeCommitReadProviderService> = {}): CodeCommitReadProviderService => ({
  getCallerIdentity: () =>
    Effect.succeed({
      Account: "123456789012",
      Arn: "arn:aws:sts::123456789012:assumed-role/Developer/alice"
    }),
  getBlob: () => Effect.succeed({ content: new Uint8Array([1, 2, 3]) }),
  listPullRequestsPage: () => Effect.succeed({ pullRequestIds: ["17"], nextToken: "next-pr-page" }),
  getPullRequest: ({ pullRequestId }) => Effect.succeed(pullRequestResponse(pullRequestId)),
  getDifferencesPage: () => Effect.succeed({ differences: [] }),
  ...overrides
})

describe("CodeCommitReadClient", () => {
  it.effect("reads one immutable blob through the bounded public model", () =>
    runWithProvider(
      baseProvider(),
      Effect.gen(function*() {
        const client = yield* CodeCommitReadClient
        const blob = yield* client.getBlob({
          account,
          repositoryName: "payments-api",
          blobId: "blob-head"
        })

        assert.strictEqual(blob.blobId, "blob-head")
        assert.strictEqual(blob.byteLength, 3)
        assert.deepStrictEqual(blob.bytes, new Uint8Array([1, 2, 3]))
      })
    ))

  it.effect("rejects blob bytes above the read-client bound with exact metadata", () =>
    runWithProvider(
      baseProvider({
        getBlob: () => Effect.succeed({ content: new Uint8Array(CODECOMMIT_BLOB_MAXIMUM_BYTES + 1) })
      }),
      Effect.gen(function*() {
        const client = yield* CodeCommitReadClient
        const result = yield* client.getBlob({
          account,
          repositoryName: "payments-api",
          blobId: "blob-oversized"
        }).pipe(Effect.result)

        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, CodeCommitBlobTooLargeError)
          if (Predicate.isTagged(result.failure, "CodeCommitBlobTooLargeError")) {
            assert.strictEqual(result.failure.source, "read-client")
            assert.strictEqual(result.failure.actualBytes, CODECOMMIT_BLOB_MAXIMUM_BYTES + 1)
          }
        }
      })
    ))

  it.effect("preserves the provider blob limit as a typed size outcome", () =>
    runWithProvider(
      baseProvider({
        getBlob: () =>
          Effect.fail(
            new AwsApiError({
              operation: "getBlob",
              profile: account.profile,
              region: account.region,
              cause: { _tag: "FileTooLargeException" }
            })
          )
      }),
      Effect.gen(function*() {
        const client = yield* CodeCommitReadClient
        const result = yield* client.getBlob({
          account,
          repositoryName: "payments-api",
          blobId: "blob-provider-limited"
        }).pipe(Effect.result)

        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, CodeCommitBlobTooLargeError)
          if (Predicate.isTagged(result.failure, "CodeCommitBlobTooLargeError")) {
            assert.strictEqual(result.failure.source, "provider")
            assert.strictEqual(result.failure.actualBytes, null)
          }
        }
      })
    ))

  it.effect("rejects malformed blob content before it reaches callers", () =>
    runWithProvider(
      baseProvider({ getBlob: () => Effect.succeed({ content: "not-bytes" }) }),
      Effect.gen(function*() {
        const client = yield* CodeCommitReadClient
        const result = yield* client.getBlob({
          account,
          repositoryName: "payments-api",
          blobId: "blob-malformed"
        }).pipe(Effect.result)

        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) assert.instanceOf(result.failure, CodeCommitMalformedResponseError)
      })
    ))

  it.effect("interrupts an in-flight blob provider read", () =>
    Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const interrupted = yield* Ref.make(false)
      const provider = baseProvider({
        getBlob: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Ref.set(interrupted, true))
          )
      })
      const fiber = yield* runWithProvider(
        provider,
        Effect.gen(function*() {
          const client = yield* CodeCommitReadClient
          return yield* client.getBlob({
            account,
            repositoryName: "payments-api",
            blobId: "blob-cancelled"
          }).pipe(Effect.forkChild)
        })
      )
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(fiber)

      assert.isTrue(yield* Ref.get(interrupted))
    }))

  it.effect("decodes immutable pull request revisions from fake provider responses", () =>
    runWithProvider(
      baseProvider(),
      Effect.gen(function*() {
        const client = yield* CodeCommitReadClient
        const page = yield* client.listPullRequestsPage({
          account,
          repositoryName: "payments-api",
          status: "OPEN",
          nextToken: null
        })

        assert.strictEqual(page.nextToken, "next-pr-page")
        assert.strictEqual(page.pullRequests.length, 1)
        assert.strictEqual(page.pullRequests[0]?.revisionId, "revision-17")
        assert.strictEqual(page.pullRequests[0]?.sourceCommit, "head-commit-17")
        assert.strictEqual(page.pullRequests[0]?.destinationCommit, "base-commit-17")
        assert.strictEqual(page.pullRequests[0]?.mergeBase, "merge-base-17")
      })
    ))

  it.effect("paginates every changed file and preserves paths, blobs, modes, and renames", () =>
    Effect.gen(function*() {
      const requestedTokens = yield* Ref.make<ReadonlyArray<string | null>>([])
      const requestedPageLimits = yield* Ref.make<ReadonlyArray<number>>([])
      const provider = baseProvider({
        getDifferencesPage: (request) =>
          Effect.all([
            Ref.update(requestedTokens, (tokens) => [...tokens, request.nextToken]),
            Ref.update(requestedPageLimits, (limits) => [...limits, request.maximumResults])
          ]).pipe(
            Effect.as(
              request.nextToken === null
                ? {
                  differences: [
                    {
                      changeType: "A",
                      afterBlob: { blobId: "blob-added", path: "src/added.ts", mode: "100644" }
                    },
                    {
                      changeType: "M",
                      beforeBlob: { blobId: "blob-old", path: "src/old-name.ts", mode: "100644" },
                      afterBlob: { blobId: "blob-new", path: "src/new-name.ts", mode: "100755" }
                    }
                  ],
                  NextToken: "diff-page-2"
                }
                : {
                  differences: [{
                    changeType: "D",
                    beforeBlob: { blobId: "blob-deleted", path: "src/deleted.ts", mode: "100644" }
                  }]
                }
            )
          )
      })

      const files = yield* runWithProvider(
        provider,
        Effect.gen(function*() {
          const client = yield* CodeCommitReadClient
          return yield* client.streamChangedFiles({
            account,
            repositoryName: "payments-api",
            beforeCommitSpecifier: "base-commit-17",
            afterCommitSpecifier: "head-commit-17"
          }).pipe(Stream.runCollect)
        })
      )

      assert.deepStrictEqual(yield* Ref.get(requestedTokens), [null, "diff-page-2"])
      assert.deepStrictEqual(yield* Ref.get(requestedPageLimits), [100, 100])
      assert.deepStrictEqual(files.map(({ status }) => status), ["added", "renamed", "deleted"])
      assert.strictEqual(files[1]?.before?.path, "src/old-name.ts")
      assert.strictEqual(files[1]?.after?.path, "src/new-name.ts")
      assert.strictEqual(files[1]?.before?.blobId, "blob-old")
      assert.strictEqual(files[1]?.after?.mode, "100755")
    }))

  it.effect("fails malformed provider responses in the typed error channel", () =>
    runWithProvider(
      baseProvider({
        getPullRequest: () =>
          Effect.succeed({
            pullRequest: {
              ...pullRequestResponse().pullRequest,
              pullRequestTargets: [{
                repositoryName: "payments-api",
                sourceReference: "refs/heads/feature/read-adapter",
                destinationReference: "refs/heads/main",
                destinationCommit: "base-commit-17"
              }]
            }
          })
      }),
      Effect.gen(function*() {
        const client = yield* CodeCommitReadClient
        const result = yield* client.getPullRequest({ account, pullRequestId: "17" }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) assert.instanceOf(result.failure, CodeCommitMalformedResponseError)
      })
    ))

  it.effect("rejects multi-target pull requests before selecting a partial revision", () =>
    runWithProvider(
      baseProvider({
        getPullRequest: () =>
          Effect.succeed({
            pullRequest: {
              ...pullRequestResponse().pullRequest,
              pullRequestTargets: [
                {
                  repositoryName: "payments-api",
                  sourceReference: "refs/heads/feature/read-adapter",
                  destinationReference: "refs/heads/main",
                  sourceCommit: "head-commit-17",
                  destinationCommit: "base-commit-17",
                  mergeBase: "merge-base-17"
                },
                {
                  repositoryName: "payments-api",
                  sourceReference: "refs/heads/feature/read-adapter",
                  destinationReference: "refs/heads/release",
                  sourceCommit: "release-head-commit-17",
                  destinationCommit: "release-base-commit-17",
                  mergeBase: "release-merge-base-17"
                }
              ]
            }
          })
      }),
      Effect.gen(function*() {
        const client = yield* CodeCommitReadClient
        const result = yield* client.getPullRequest({ account, pullRequestId: "17" }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) assert.instanceOf(result.failure, CodeCommitMalformedResponseError)
      })
    ))

  it.effect("retains repository absence as a typed not-found read failure", () =>
    runWithProvider(
      baseProvider({
        getPullRequest: () =>
          Effect.fail(
            new AwsApiError({
              operation: "getPullRequest",
              profile: account.profile,
              region: account.region,
              cause: { _tag: "RepositoryDoesNotExistException" }
            })
          )
      }),
      Effect.gen(function*() {
        const client = yield* CodeCommitReadClient
        const result = yield* client.getPullRequest({ account, pullRequestId: "17" }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) assert.instanceOf(result.failure, CodeCommitReadNotFoundError)
      })
    ))

  it.effect("rejects provider pages that exceed the requested bound", () =>
    runWithProvider(
      baseProvider({
        getDifferencesPage: () =>
          Effect.succeed({
            differences: Array.from({ length: 101 }, (_, index) => ({
              changeType: "A",
              afterBlob: { blobId: `blob-${index}`, path: `src/${index}.ts`, mode: "100644" }
            }))
          })
      }),
      Effect.gen(function*() {
        const client = yield* CodeCommitReadClient
        const result = yield* client.getChangedFilesPage({
          account,
          repositoryName: "payments-api",
          beforeCommitSpecifier: "base-commit-17",
          afterCommitSpecifier: "head-commit-17",
          nextToken: null
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) assert.instanceOf(result.failure, CodeCommitMalformedResponseError)
      })
    ))

  it.effect("interrupts an in-flight provider page before requesting further work", () =>
    Effect.gen(function*() {
      const secondPageEntered = yield* Deferred.make<void>()
      const interrupted = yield* Ref.make(false)
      const provider = baseProvider({
        getDifferencesPage: (request) =>
          request.nextToken === null
            ? Effect.succeed({
              differences: [{
                changeType: "A",
                afterBlob: { blobId: "blob-added", path: "src/added.ts", mode: "100644" }
              }],
              NextToken: "diff-page-2"
            })
            : Deferred.succeed(secondPageEntered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Ref.set(interrupted, true))
            )
      })
      const fiber = yield* runWithProvider(
        provider,
        Effect.gen(function*() {
          const client = yield* CodeCommitReadClient
          return yield* client.streamChangedFiles({
            account,
            repositoryName: "payments-api",
            beforeCommitSpecifier: "base-commit-17",
            afterCommitSpecifier: "head-commit-17"
          }).pipe(Stream.runDrain, Effect.forkChild)
        })
      )
      yield* Deferred.await(secondPageEntered)
      yield* Fiber.interrupt(fiber)

      assert.isTrue(yield* Ref.get(interrupted))
    }))
})
