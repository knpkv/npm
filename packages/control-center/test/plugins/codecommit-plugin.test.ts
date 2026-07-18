import { assert, describe, it } from "@effect/vitest"
import { Domain, Errors, ReadClient } from "@knpkv/codecommit-core"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

import {
  DiffInventoryPageRequestV1,
  PluginSyncRequestV1,
  ReadPluginEntityRequestV1
} from "../../src/domain/plugins/index.js"
import { codeCommitPluginDefinition } from "../../src/server/plugins/codecommit/CodeCommitPluginDefinition.js"
import {
  PluginAuthenticationFailure,
  PluginAuthorizationFailure,
  PluginConfigurationFailure
} from "../../src/server/plugins/failures.js"
import { PluginConnection } from "../../src/server/plugins/PluginConnection.js"
import { buildPluginDefinitionLayer } from "../../src/server/plugins/PluginDefinition.js"

const configuration = {
  profile: "production",
  region: "eu-west-1",
  repositoryName: "payments-api"
}

const makePullRequest = (
  repositoryName: string,
  status: "OPEN" | "CLOSED" | "MERGED" = "OPEN",
  revisionId = "revision-17"
) =>
  Schema.decodeUnknownSync(ReadClient.CodeCommitPullRequestRevision)({
    pullRequestId: "17",
    revisionId,
    repositoryName,
    title: "Preserve exact revisions",
    description: "Expose immutable base and head commits.",
    authorArn: "arn:aws:sts::123456789012:assumed-role/Developer/alice",
    status,
    sourceReference: "refs/heads/feature/read-adapter",
    destinationReference: "refs/heads/main",
    sourceCommit: "head-commit-17",
    destinationCommit: "base-commit-17",
    mergeBase: "merge-base-17",
    creationDate: new Date("2026-07-16T08:00:00.000Z"),
    lastActivityDate: new Date("2026-07-16T09:00:00.000Z")
  })

const pullRequest = makePullRequest(configuration.repositoryName)

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
  getBlob: () =>
    Effect.succeed(
      new ReadClient.CodeCommitBlobContent({
        blobId: ReadClient.CodeCommitBlobId.make("blob-head"),
        bytes: new Uint8Array([1, 2, 3])
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
  it.effect("proves repository access and region-scopes the discovered resource identity", () =>
    Effect.gen(function*() {
      const probes = yield* Ref.make(0)
      const client = baseReadClient({
        listPullRequestsPage: () =>
          Ref.update(probes, (count) => count + 1).pipe(
            Effect.as(new ReadClient.CodeCommitPullRequestPage({ pullRequests: [], nextToken: null }))
          )
      })
      const result = yield* runWithClient(
        client,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const health = yield* connection.health
          const discovery = yield* connection.discover
          return { discovery, health }
        })
      )

      assert.strictEqual(result.health._tag, "healthy")
      assert.strictEqual(result.discovery.workspace?.providerImmutableId, "eu-west-1:payments-api")
      assert.strictEqual(yield* Ref.get(probes), 2)
    }))

  it.effect("rejects discovery and health when AWS cannot confirm the configured repository", () =>
    Effect.gen(function*() {
      const client = baseReadClient({
        listPullRequestsPage: () =>
          Effect.fail(new ReadClient.CodeCommitReadNotFoundError({ operation: "repository-probe" }))
      })
      const results = yield* runWithClient(
        client,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const health = yield* connection.health.pipe(Effect.result)
          const discovery = yield* connection.discover.pipe(Effect.result)
          return { discovery, health }
        })
      )

      assert.isTrue(Result.isFailure(results.health))
      if (Result.isFailure(results.health)) assert.instanceOf(results.health.failure, PluginConfigurationFailure)
      assert.isTrue(Result.isFailure(results.discovery))
      if (Result.isFailure(results.discovery)) {
        assert.instanceOf(results.discovery.failure, PluginConfigurationFailure)
      }
    }))

  it.effect("normalizes paginated pull-request sync and resumes from the provider cursor", () =>
    Effect.gen(function*() {
      const requestedPages = yield* Ref.make<
        ReadonlyArray<{
          readonly status: "OPEN" | "CLOSED"
          readonly nextToken: string | null
        }>
      >([])
      const client = baseReadClient({
        listPullRequestsPage: (request) =>
          Ref.update(requestedPages, (pages) => [...pages, {
            status: request.status,
            nextToken: request.nextToken
          }]).pipe(
            Effect.as(
              new ReadClient.CodeCommitPullRequestPage({
                pullRequests: request.status === "OPEN" ? [pullRequest] : [],
                nextToken: request.status === "OPEN" && request.nextToken === null
                  ? ReadClient.CodeCommitPageToken.make("provider-page-2")
                  : null
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

      assert.deepStrictEqual(yield* Ref.get(requestedPages), [
        { status: "OPEN", nextToken: null },
        { status: "OPEN", nextToken: "provider-page-2" },
        { status: "CLOSED", nextToken: null },
        { status: "OPEN", nextToken: "provider-page-2" },
        { status: "CLOSED", nextToken: null }
      ])
      assert.strictEqual(pages.first.length, 3)
      assert.strictEqual(pages.first[0]?.checkpointAfterPage, "next:provider-page-2")
      assert.isTrue(pages.first[0]?.hasMore)
      assert.strictEqual(pages.first[1]?.checkpointAfterPage, "closed")
      assert.isTrue(pages.first[1]?.hasMore)
      assert.strictEqual(pages.first[2]?.checkpointAfterPage, "complete")
      assert.isFalse(pages.first[2]?.hasMore)
      assert.strictEqual(pages.resumed[0]?.checkpointAfterPage, "closed")
      assert.strictEqual(pages.resumed[1]?.checkpointAfterPage, "complete")
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

  it.effect("emits a terminal revision when a previously open pull request is merged", () =>
    Effect.gen(function*() {
      const terminal = yield* Ref.make(false)
      const mergedPullRequest = makePullRequest(configuration.repositoryName, "MERGED", "revision-18")
      const client = baseReadClient({
        listPullRequestsPage: (request) =>
          Ref.get(terminal).pipe(
            Effect.map((isTerminal) =>
              new ReadClient.CodeCommitPullRequestPage({
                pullRequests: isTerminal
                  ? request.status === "CLOSED" ? [mergedPullRequest] : []
                  : request.status === "OPEN"
                  ? [pullRequest]
                  : [],
                nextToken: null
              })
            )
          )
      })
      const request = Schema.decodeUnknownSync(PluginSyncRequestV1)({
        streamKey: "pull-requests",
        checkpoint: null
      })
      const pages = yield* runWithClient(
        client,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const open = yield* connection.sync(request).pipe(Stream.runCollect)
          yield* Ref.set(terminal, true)
          const merged = yield* connection.sync(request).pipe(Stream.runCollect)
          return { open, merged }
        })
      )

      const openEvents = pages.open.flatMap(({ events }) => events)
      const mergedEvents = pages.merged.flatMap(({ events }) => events)
      assert.strictEqual(openEvents.length, 1)
      const openEvent = openEvents[0]
      assert.strictEqual(openEvent?._tag, "UpsertEntity")
      if (openEvent?._tag === "UpsertEntity") assert.strictEqual(openEvent.attributes.status, "OPEN")
      assert.strictEqual(mergedEvents.length, 1)
      const mergedEvent = mergedEvents[0]
      assert.strictEqual(mergedEvent?._tag, "UpsertEntity")
      if (mergedEvent?._tag === "UpsertEntity") {
        assert.strictEqual(mergedEvent.revision, "revision-18")
        assert.strictEqual(mergedEvent.attributes.status, "MERGED")
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

  it.effect("rejects cross-repository entity and inventory reads before normalization or diff access", () =>
    Effect.gen(function*() {
      const differenceCalls = yield* Ref.make(0)
      const mismatchedPullRequest = makePullRequest("other-repository")
      const client = baseReadClient({
        getPullRequest: () => Effect.succeed(mismatchedPullRequest),
        getChangedFilesPage: () =>
          Ref.update(differenceCalls, (calls) => calls + 1).pipe(
            Effect.as(
              new ReadClient.CodeCommitChangedFilesPage({
                files: changedFiles,
                nextToken: null,
                providerPageLimit: 100
              })
            )
          )
      })
      const entityRequest = Schema.decodeUnknownSync(ReadPluginEntityRequestV1)({
        entityType: "pull-request",
        vendorImmutableId: "17"
      })
      const inventoryRequest = Schema.decodeUnknownSync(DiffInventoryPageRequestV1)({
        entity: entityRequest,
        cursor: null
      })
      const results = yield* runWithClient(
        client,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          if (Option.isNone(connection.diff)) return yield* Effect.die("missing diff reader")
          const entity = yield* connection.readEntity(entityRequest).pipe(Effect.result)
          const inventory = yield* connection.diff.value.readInventoryPage(inventoryRequest).pipe(Effect.result)
          return { entity, inventory }
        })
      )

      assert.isTrue(Result.isFailure(results.entity))
      if (Result.isFailure(results.entity)) assert.instanceOf(results.entity.failure, PluginConfigurationFailure)
      assert.isTrue(Result.isFailure(results.inventory))
      if (Result.isFailure(results.inventory)) {
        assert.instanceOf(results.inventory.failure, PluginConfigurationFailure)
      }
      assert.strictEqual(yield* Ref.get(differenceCalls), 0)
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

  it.effect("maps CodeCommit encryption-key denial to the authorization taxonomy", () =>
    Effect.gen(function*() {
      const client = baseReadClient({
        getPullRequest: () =>
          Effect.fail(
            new Errors.AwsApiError({
              operation: "getPullRequest",
              profile: Schema.decodeUnknownSync(Domain.AwsProfileName)(configuration.profile),
              region: Schema.decodeUnknownSync(Domain.AwsRegion)(configuration.region),
              cause: { _tag: "EncryptionKeyAccessDeniedException" }
            })
          )
      })
      const request = Schema.decodeUnknownSync(ReadPluginEntityRequestV1)({
        entityType: "pull-request",
        vendorImmutableId: "17"
      })
      const result = yield* runWithClient(
        client,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          return yield* connection.readEntity(request)
        })
      ).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, PluginAuthorizationFailure)
    }))
})
