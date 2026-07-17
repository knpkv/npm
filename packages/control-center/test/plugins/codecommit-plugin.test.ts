import { assert, describe, it } from "@effect/vitest"
import { Domain, Errors, ReadClient } from "@knpkv/codecommit-core"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

import { DiffInventoryPageRequestV1, PluginSyncRequestV1 } from "../../src/domain/plugins/index.js"
import { codeCommitPluginDefinition } from "../../src/server/plugins/codecommit/CodeCommitPluginDefinition.js"
import { PluginAuthenticationFailure } from "../../src/server/plugins/failures.js"
import { PluginConnection } from "../../src/server/plugins/PluginConnection.js"
import { buildPluginDefinitionLayer } from "../../src/server/plugins/PluginDefinition.js"

const configuration = {
  profile: "production",
  region: "eu-west-1",
  repositoryName: "payments-api"
}

const pullRequest = Schema.decodeUnknownSync(ReadClient.CodeCommitPullRequestRevision)({
  pullRequestId: "17",
  revisionId: "revision-17",
  repositoryName: "payments-api",
  title: "Preserve exact revisions",
  description: "Expose immutable base and head commits.",
  authorArn: "arn:aws:sts::123456789012:assumed-role/Developer/alice",
  status: "OPEN",
  sourceReference: "refs/heads/feature/read-adapter",
  destinationReference: "refs/heads/main",
  sourceCommit: "head-commit-17",
  destinationCommit: "base-commit-17",
  mergeBase: "merge-base-17",
  creationDate: new Date("2026-07-16T08:00:00.000Z"),
  lastActivityDate: new Date("2026-07-16T09:00:00.000Z")
})

const changedFiles = [
  Schema.decodeUnknownSync(ReadClient.CodeCommitChangedFile)({
    status: "renamed",
    before: { blobId: "blob-old", path: "src/old-name.ts", mode: "100644" },
    after: { blobId: "blob-new", path: "src/new-name.ts", mode: "100755" }
  }),
  Schema.decodeUnknownSync(ReadClient.CodeCommitChangedFile)({
    status: "added",
    before: null,
    after: { blobId: "blob-added", path: "src/added.ts", mode: "100644" }
  })
]

const baseReadClient = (
  overrides: Partial<ReadClient.CodeCommitReadClientService> = {}
): ReadClient.CodeCommitReadClientService => ({
  discoverAccount: () =>
    Effect.succeed(
      new ReadClient.CodeCommitAccountIdentity({
        accountId: "123456789012",
        arn: "arn:aws:sts::123456789012:assumed-role/Developer/alice"
      })
    ),
  listPullRequestsPage: () =>
    Effect.succeed(
      new ReadClient.CodeCommitPullRequestPage({
        pullRequests: [pullRequest],
        nextToken: null
      })
    ),
  streamPullRequests: () => Stream.make(pullRequest),
  getPullRequest: () => Effect.succeed(pullRequest),
  getChangedFilesPage: () =>
    Effect.succeed(
      new ReadClient.CodeCommitChangedFilesPage({
        files: changedFiles,
        nextToken: null,
        providerPageLimit: 100
      })
    ),
  streamChangedFiles: () => Stream.fromIterable(changedFiles),
  ...overrides
})

const runWithClient = <A, E>(
  client: ReadClient.CodeCommitReadClientService,
  effect: Effect.Effect<A, E, PluginConnection>
) =>
  effect.pipe(
    Effect.provide(
      buildPluginDefinitionLayer(codeCommitPluginDefinition, configuration).pipe(
        Layer.provide(Layer.succeed(ReadClient.CodeCommitReadClient, client))
      )
    ),
    Effect.scoped
  )

describe("CodeCommitPlugin", () => {
  it.effect("normalizes paginated pull-request sync and resumes from the provider cursor", () =>
    Effect.gen(function*() {
      const requestedTokens = yield* Ref.make<ReadonlyArray<string | null>>([])
      const client = baseReadClient({
        listPullRequestsPage: (request) =>
          Ref.update(requestedTokens, (tokens) => [...tokens, request.nextToken]).pipe(
            Effect.as(
              new ReadClient.CodeCommitPullRequestPage({
                pullRequests: [pullRequest],
                nextToken: request.nextToken === null ? ReadClient.CodeCommitPageToken.make("provider-page-2") : null
              })
            )
          )
      })
      const firstRequest = Schema.decodeUnknownSync(PluginSyncRequestV1)({
        streamKey: "pull-requests",
        checkpoint: null
      })
      const resumedRequest = Schema.decodeUnknownSync(PluginSyncRequestV1)({
        streamKey: "pull-requests",
        checkpoint: "next:provider-page-2"
      })
      const pages = yield* runWithClient(
        client,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const first = yield* connection.sync(firstRequest).pipe(Stream.runCollect)
          const resumed = yield* connection.sync(resumedRequest).pipe(Stream.runCollect)
          return { first, resumed }
        })
      )

      assert.deepStrictEqual(yield* Ref.get(requestedTokens), [null, "provider-page-2", "provider-page-2"])
      assert.strictEqual(pages.first.length, 2)
      assert.strictEqual(pages.first[0]?.checkpointAfterPage, "next:provider-page-2")
      assert.isTrue(pages.first[0]?.hasMore)
      assert.strictEqual(pages.first[1]?.checkpointAfterPage, "complete")
      assert.isFalse(pages.first[1]?.hasMore)
      assert.strictEqual(pages.resumed[0]?.checkpointAfterPage, "complete")
      const event = pages.first[0]?.events[0]
      assert.strictEqual(event?._tag, "UpsertEntity")
      if (event?._tag === "UpsertEntity") {
        assert.strictEqual(event.entityType, "pull-request")
        assert.strictEqual(event.vendorImmutableId, "17")
        assert.strictEqual(event.revision, "revision-17")
        assert.strictEqual(event.attributes.headRevision, "head-commit-17")
        assert.strictEqual(event.attributes.baseRevision, "base-commit-17")
      }
    }))

  it.effect("normalizes complete changed-file pages with stable rename paths", () =>
    Effect.gen(function*() {
      const request = Schema.decodeUnknownSync(DiffInventoryPageRequestV1)({
        entity: { entityType: "pull-request", vendorImmutableId: "17" },
        cursor: null
      })
      const page = yield* runWithClient(
        baseReadClient(),
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          if (Option.isNone(connection.diff)) return yield* Effect.die("missing diff reader")
          return yield* connection.diff.value.readInventoryPage(request)
        })
      )

      assert.strictEqual(page.entries.length, 2)
      assert.strictEqual(page.entries[0]?.status, "renamed")
      assert.strictEqual(page.entries[0]?.previousPath, "src/old-name.ts")
      assert.strictEqual(page.entries[0]?.path, "src/new-name.ts")
      assert.strictEqual(page.entries[1]?.status, "added")
      assert.strictEqual(page.nextCursor, null)
    }))

  it.effect("maps credential rejection to the Control Center authentication taxonomy", () =>
    Effect.gen(function*() {
      const client = baseReadClient({
        discoverAccount: () =>
          Effect.fail(
            new Errors.AwsCredentialError({
              profile: Schema.decodeUnknownSync(Domain.AwsProfileName)(configuration.profile),
              region: Schema.decodeUnknownSync(Domain.AwsRegion)(configuration.region),
              cause: { _tag: "CredentialsProviderError" }
            })
          )
      })
      const result = yield* runWithClient(
        client,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          return yield* connection.health
        })
      ).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, PluginAuthenticationFailure)
    }))
})
