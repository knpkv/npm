import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { assert, describe, it } from "@effect/vitest"
import { Domain, Errors, ReadClient, ReviewClient } from "@knpkv/codecommit-core"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"

import {
  AuthorizedPluginActionV1,
  DiffInventoryPageRequestV1,
  type PluginActionProposalV1,
  PluginActionReconciliationRequestV1,
  PluginSyncRequestV1,
  ProposePluginActionRequestV1,
  ReadPluginEntityRequestV1
} from "../../src/domain/plugins/index.js"
import { codeCommitPluginDefinition } from "../../src/server/plugins/codecommit/CodeCommitPluginDefinition.js"
import {
  PluginAuthenticationFailure,
  PluginAuthorizationFailure,
  PluginConfigurationFailure,
  PluginConflictFailure,
  PluginRateLimitFailure
} from "../../src/server/plugins/failures.js"
import { AuthorizedPluginExecutor } from "../../src/server/plugins/internal/AuthorizedPluginExecutor.js"
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
  listRepositoriesPage: () =>
    Effect.succeed(new ReadClient.CodeCommitRepositoryPage({ repositoryNames: [], nextToken: null })),
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

const baseReviewClient = (
  overrides: Partial<ReviewClient.CodeCommitReviewClientService> = {}
): ReviewClient.CodeCommitReviewClientService => ({
  preflight: () => Effect.succeed(pullRequest),
  execute: () =>
    Effect.succeed(
      new ReviewClient.CodeCommitReviewReceipt({
        operationId: "review-operation-1",
        summary: "Review action completed"
      })
    ),
  reconcile: () => Effect.succeed({ _tag: "pending" }),
  ...overrides
})

const runWithClient = <A, E>(
  client: ReadClient.CodeCommitReadClientService,
  effect: Effect.Effect<A, E, AuthorizedPluginExecutor | PluginConnection>,
  reviewClient: ReviewClient.CodeCommitReviewClientService = baseReviewClient()
) =>
  effect.pipe(
    Effect.provide(
      buildPluginDefinitionLayer(codeCommitPluginDefinition, configuration).pipe(
        Layer.provide(Layer.mergeAll(
          Layer.succeed(ReadClient.CodeCommitReadClient, client),
          Layer.succeed(ReviewClient.CodeCommitReviewClient, reviewClient),
          NodeCrypto.layer
        ))
      )
    ),
    Effect.scoped
  )

const requestChangesProposal = Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
  actionKind: "request-changes",
  target: { entityType: "pull-request", vendorImmutableId: "17" },
  expectedRevision: "revision-17",
  payload: { content: "Please preserve the authorization binding." },
  evidenceIds: ["review-finding-1"]
})

const authorizeProposal = (
  proposal: PluginActionProposalV1,
  idempotencyKey = "governed-action-1"
) =>
  Schema.decodeUnknownSync(Schema.toType(AuthorizedPluginActionV1))({
    proposal,
    idempotencyKey,
    payloadDigest: proposal.payloadDigest,
    authorizationId: "authorization-1",
    authorizedAt: proposal.proposedAt,
    expiresAt: DateTime.add(proposal.proposedAt, { minutes: 5 })
  })

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
      assert.isNull(result.discovery.workspace)
      assert.strictEqual(result.discovery.resource?.providerImmutableId, "eu-west-1:payments-api")
      assert.strictEqual(result.discovery.resource?.displayName, "payments-api")
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

  it.effect("offers request-review comments and native approval as distinct governed actions", () =>
    Effect.gen(function*() {
      const requestReview = Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
        actionKind: "request-review",
        target: { entityType: "pull-request", vendorImmutableId: "17" },
        expectedRevision: "revision-17",
        payload: {
          reviewerArns: ["arn:aws:iam::123456789012:user/grace"],
          message: "Please review the authorization changes."
        },
        evidenceIds: []
      })
      const approve = Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
        actionKind: "approve",
        target: { entityType: "pull-request", vendorImmutableId: "17" },
        expectedRevision: "revision-17",
        payload: {},
        evidenceIds: []
      })
      const proposals = yield* runWithClient(
        baseReadClient(),
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const requestReviewProposal = yield* connection.proposeAction(requestReview)
          const approveProposal = yield* connection.proposeAction(approve)
          return {
            requestReview: requestReviewProposal,
            approve: approveProposal,
            approvalDispatch: yield* executor.executeAuthorizedAction(authorizeProposal(approveProposal))
          }
        })
      )

      assert.deepInclude(proposals.requestReview.request.payload, {
        _tag: "request-review",
        reviewerArns: ["arn:aws:iam::123456789012:user/grace"]
      })
      assert.deepInclude(proposals.approve.request.payload, { _tag: "approve" })
      assert.strictEqual(proposals.requestReview.impact.level, "medium")
      assert.strictEqual(proposals.approve.impact.level, "medium")
      assert.strictEqual(proposals.approvalDispatch._tag, "confirmed")
    }))

  it.effect("reserves durable marker space before authorizing review comments", () =>
    Effect.gen(function*() {
      const request = (content: string) =>
        Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
          actionKind: "comment",
          target: { entityType: "pull-request", vendorImmutableId: "17" },
          expectedRevision: "revision-17",
          payload: { content },
          evidenceIds: []
        })
      const result = yield* runWithClient(
        baseReadClient(),
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          return {
            withinLimit: yield* connection.proposeAction(request("x".repeat(10_000))),
            exceedsMarkedLimit: yield* connection.proposeAction(request("x".repeat(10_240))).pipe(Effect.result)
          }
        })
      )

      assert.strictEqual(result.withinLimit.request.actionKind, "comment")
      assert.isTrue(Result.isFailure(result.exceedsMarkedLimit))
      if (Result.isFailure(result.exceedsMarkedLimit)) {
        assert.instanceOf(result.exceedsMarkedLimit.failure, PluginConfigurationFailure)
      }
    }))

  it.effect("binds comment idempotency tokens to the pull-request target and keeps retries stable", () =>
    Effect.gen(function*() {
      const secondPullRequest = Schema.decodeUnknownSync(ReadClient.CodeCommitPullRequestRevision)({
        ...pullRequest,
        pullRequestId: "18"
      })
      const secondRequest = Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
        ...requestChangesProposal,
        target: { entityType: "pull-request", vendorImmutableId: "18" }
      })
      const firstProposals = yield* runWithClient(
        baseReadClient(),
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          return {
            first: yield* connection.proposeAction(requestChangesProposal),
            retry: yield* connection.proposeAction(requestChangesProposal)
          }
        })
      )
      const secondProposal = yield* runWithClient(
        baseReadClient({ getPullRequest: () => Effect.succeed(secondPullRequest) }),
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          return yield* connection.proposeAction(secondRequest)
        })
      )
      const TokenPayload = Schema.Struct({ clientRequestToken: Schema.String })
      const firstToken = Schema.decodeUnknownSync(TokenPayload)(firstProposals.first.request.payload).clientRequestToken
      const retryToken = Schema.decodeUnknownSync(TokenPayload)(firstProposals.retry.request.payload).clientRequestToken
      const secondToken = Schema.decodeUnknownSync(TokenPayload)(secondProposal.request.payload).clientRequestToken

      assert.strictEqual(firstToken, retryToken)
      assert.notStrictEqual(firstToken, secondToken)
    }))

  it.effect("proposes and executes a governed request-changes action against the exact revision", () =>
    Effect.gen(function*() {
      const executed = yield* Ref.make<ReviewClient.CodeCommitReviewAction | null>(null)
      const reviewClient = baseReviewClient({
        execute: (action) =>
          Ref.set(executed, action).pipe(
            Effect.as(
              new ReviewClient.CodeCommitReviewReceipt({
                operationId: "comment:comment-42",
                summary: "Change request posted to the pull request"
              })
            )
          )
      })
      const result = yield* runWithClient(
        baseReadClient(),
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const proposal = yield* connection.proposeAction(requestChangesProposal)
          const authorized = authorizeProposal(proposal)
          const preflight = yield* executor.preflight(authorized)
          const dispatch = yield* executor.executeAuthorizedAction(authorized)
          return { dispatch, preflight, proposal }
        }),
        reviewClient
      )

      assert.deepInclude(result.proposal.request.payload, { _tag: "request-changes" })
      assert.strictEqual(result.preflight._tag, "ready")
      assert.strictEqual(result.dispatch._tag, "confirmed")
      const action = yield* Ref.get(executed)
      assert.strictEqual(action?._tag, "request-changes")
      assert.strictEqual(action?.target.revisionId, "revision-17")
      assert.strictEqual(action?.target.sourceCommit, "head-commit-17")
    }))

  it.effect("blocks stale actions before the executor can call the review mutation", () =>
    Effect.gen(function*() {
      const mutationCalls = yield* Ref.make(0)
      const reviewClient = baseReviewClient({
        preflight: () =>
          Effect.fail(
            new ReviewClient.CodeCommitReviewConflictError({
              operation: "preflight",
              reason: "revision-changed"
            })
          ),
        execute: () =>
          Ref.update(mutationCalls, (count) => count + 1).pipe(
            Effect.as(
              new ReviewClient.CodeCommitReviewReceipt({
                operationId: "unexpected",
                summary: "Unexpected mutation"
              })
            )
          )
      })
      const preflight = yield* runWithClient(
        baseReadClient(),
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const proposal = yield* connection.proposeAction(requestChangesProposal)
          return yield* executor.preflight(authorizeProposal(proposal))
        }),
        reviewClient
      )

      assert.strictEqual(preflight._tag, "blocked")
      assert.strictEqual(yield* Ref.get(mutationCalls), 0)
    }))

  it.effect("blocks a missing pull request during preflight without calling the mutation", () =>
    Effect.gen(function*() {
      const mutationCalls = yield* Ref.make(0)
      const preflight = yield* runWithClient(
        baseReadClient(),
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const proposal = yield* connection.proposeAction(requestChangesProposal)
          return yield* executor.preflight(authorizeProposal(proposal))
        }),
        baseReviewClient({
          preflight: () => Effect.fail(new ReadClient.CodeCommitReadNotFoundError({ operation: "getPullRequest" })),
          execute: () =>
            Ref.update(mutationCalls, (count) => count + 1).pipe(
              Effect.andThen(Effect.die("missing preflight target must block execute"))
            )
        })
      )

      assert.strictEqual(preflight._tag, "blocked")
      assert.strictEqual(yield* Ref.get(mutationCalls), 0)
    }))

  it.effect("surfaces preflight credential failures as authentication failures", () =>
    Effect.gen(function*() {
      const result = yield* runWithClient(
        baseReadClient(),
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const proposal = yield* connection.proposeAction(requestChangesProposal)
          return yield* executor.preflight(authorizeProposal(proposal))
        }),
        baseReviewClient({
          preflight: () =>
            Effect.fail(
              new Errors.AwsCredentialError({
                profile: Schema.decodeUnknownSync(Domain.AwsProfileName)(configuration.profile),
                region: Schema.decodeUnknownSync(Domain.AwsRegion)(configuration.region),
                cause: { _tag: "CredentialsProviderError" }
              })
            )
        })
      ).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, PluginAuthenticationFailure)
    }))

  it.effect("records a definitive provider rejection as a failed receipt", () =>
    Effect.gen(function*() {
      const result = yield* runWithClient(
        baseReadClient(),
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const proposal = yield* connection.proposeAction(requestChangesProposal)
          return yield* executor.executeAuthorizedAction(authorizeProposal(proposal))
        }),
        baseReviewClient({
          execute: () =>
            Effect.fail(
              new ReviewClient.CodeCommitReviewConflictError({
                operation: "post-comment",
                reason: "revision-changed"
              })
            )
        })
      )

      assert.strictEqual(result._tag, "confirmed")
      if (result._tag === "confirmed") assert.strictEqual(result.receipt.status, "failed")
    }))

  it.effect("surfaces execute credential failures instead of recording a terminal receipt", () =>
    Effect.gen(function*() {
      const result = yield* runWithClient(
        baseReadClient(),
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const proposal = yield* connection.proposeAction(requestChangesProposal)
          return yield* executor.executeAuthorizedAction(authorizeProposal(proposal))
        }),
        baseReviewClient({
          execute: () =>
            Effect.fail(
              new Errors.AwsCredentialError({
                profile: Schema.decodeUnknownSync(Domain.AwsProfileName)(configuration.profile),
                region: Schema.decodeUnknownSync(Domain.AwsRegion)(configuration.region),
                cause: { _tag: "CredentialsProviderError" }
              })
            )
        })
      ).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, PluginAuthenticationFailure)
    }))

  it.effect("records approval-by-author denial as a terminal failed receipt", () =>
    Effect.gen(function*() {
      const approveRequest = Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
        actionKind: "approve",
        target: { entityType: "pull-request", vendorImmutableId: "17" },
        expectedRevision: "revision-17",
        payload: {},
        evidenceIds: []
      })
      const result = yield* runWithClient(
        baseReadClient(),
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const proposal = yield* connection.proposeAction(approveRequest)
          return yield* executor.executeAuthorizedAction(authorizeProposal(proposal))
        }),
        baseReviewClient({
          execute: () =>
            Effect.fail(
              new Errors.AwsApiError({
                operation: "updatePullRequestApprovalState",
                profile: Schema.decodeUnknownSync(Domain.AwsProfileName)(configuration.profile),
                region: Schema.decodeUnknownSync(Domain.AwsRegion)(configuration.region),
                cause: { _tag: "PullRequestCannotBeApprovedByAuthorException" }
              })
            )
        })
      )

      assert.strictEqual(result._tag, "confirmed")
      if (result._tag === "confirmed") assert.strictEqual(result.receipt.status, "failed")
    }))

  it.effect("records maximum-approval rejection as a terminal failed receipt", () =>
    Effect.gen(function*() {
      const approveRequest = Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
        actionKind: "approve",
        target: { entityType: "pull-request", vendorImmutableId: "17" },
        expectedRevision: "revision-17",
        payload: {},
        evidenceIds: []
      })
      const result = yield* runWithClient(
        baseReadClient(),
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const proposal = yield* connection.proposeAction(approveRequest)
          return yield* executor.executeAuthorizedAction(authorizeProposal(proposal))
        }),
        baseReviewClient({
          execute: () =>
            Effect.fail(
              new Errors.AwsApiError({
                operation: "updatePullRequestApprovalState",
                profile: Schema.decodeUnknownSync(Domain.AwsProfileName)(configuration.profile),
                region: Schema.decodeUnknownSync(Domain.AwsRegion)(configuration.region),
                cause: { _tag: "MaximumNumberOfApprovalsExceededException" }
              })
            )
        })
      )

      assert.strictEqual(result._tag, "confirmed")
      if (result._tag === "confirmed") assert.strictEqual(result.receipt.status, "failed")
    }))

  it.effect("keeps approval throttling reconcilable after provider intent", () =>
    Effect.gen(function*() {
      const approveRequest = Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
        actionKind: "approve",
        target: { entityType: "pull-request", vendorImmutableId: "17" },
        expectedRevision: "revision-17",
        payload: {},
        evidenceIds: []
      })
      const result = yield* runWithClient(
        baseReadClient(),
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const proposal = yield* connection.proposeAction(approveRequest)
          return yield* executor.executeAuthorizedAction(authorizeProposal(proposal))
        }),
        baseReviewClient({
          execute: () =>
            Effect.fail(
              new Errors.AwsApiError({
                operation: "updatePullRequestApprovalState",
                profile: Schema.decodeUnknownSync(Domain.AwsProfileName)(configuration.profile),
                region: Schema.decodeUnknownSync(Domain.AwsRegion)(configuration.region),
                cause: { _tag: "ThrottlingException" }
              })
            )
        })
      ).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.isTrue(Predicate.isTagged(result.failure, "PluginUnknownOutcomeFailure"))
      }
    }))

  it.effect("replays one authorized action once and rejects an idempotency-key payload collision", () =>
    Effect.gen(function*() {
      const mutationCalls = yield* Ref.make(0)
      const reviewClient = baseReviewClient({
        execute: () =>
          Ref.update(mutationCalls, (count) => count + 1).pipe(
            Effect.as(
              new ReviewClient.CodeCommitReviewReceipt({
                operationId: "review-operation-idempotent",
                summary: "Review action completed once"
              })
            )
          )
      })
      const collisionRequest = Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
        ...requestChangesProposal,
        payload: { content: "A different authorized payload." }
      })
      const result = yield* runWithClient(
        baseReadClient(),
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const firstProposal = yield* connection.proposeAction(requestChangesProposal)
          const collisionProposal = yield* connection.proposeAction(collisionRequest)
          const authorized = authorizeProposal(firstProposal)
          const first = yield* executor.executeAuthorizedAction(authorized)
          const retry = yield* executor.executeAuthorizedAction(authorized)
          const collision = yield* executor.executeAuthorizedAction(
            authorizeProposal(collisionProposal)
          ).pipe(Effect.result)
          const separate = yield* executor.executeAuthorizedAction(
            authorizeProposal(collisionProposal, "governed-action-2")
          )
          return { collision, first, retry, separate }
        }),
        reviewClient
      )

      assert.deepStrictEqual(result.retry, result.first)
      assert.isTrue(Result.isFailure(result.collision))
      if (Result.isFailure(result.collision)) {
        assert.instanceOf(result.collision.failure, PluginConflictFailure)
      }
      assert.strictEqual(result.separate._tag, "confirmed")
      assert.strictEqual(yield* Ref.get(mutationCalls), 2)
    }))

  it.effect("preserves reconciliation identity when a post-intent write is throttled", () =>
    Effect.gen(function*() {
      const result = yield* runWithClient(
        baseReadClient(),
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const proposal = yield* connection.proposeAction(requestChangesProposal)
          return yield* executor.executeAuthorizedAction(authorizeProposal(proposal))
        }),
        baseReviewClient({
          execute: () =>
            Effect.fail(
              new Errors.AwsApiError({
                operation: "postPullRequestComment",
                profile: Schema.decodeUnknownSync(Domain.AwsProfileName)(configuration.profile),
                region: Schema.decodeUnknownSync(Domain.AwsRegion)(configuration.region),
                cause: { _tag: "ThrottlingException" }
              })
            )
        })
      ).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.isTrue(Predicate.isTagged(result.failure, "PluginUnknownOutcomeFailure"))
        if (Predicate.isTagged(result.failure, "PluginUnknownOutcomeFailure")) {
          assert.match(result.failure.reconciliationKey, /^ccmt:v1:/u)
        }
      }
    }))

  it.effect("retries pre-intent throttling before dispatch", () =>
    Effect.gen(function*() {
      const attempts = yield* Ref.make(0)
      const fiber = yield* Effect.forkChild(
        runWithClient(
          baseReadClient(),
          Effect.gen(function*() {
            const connection = yield* PluginConnection
            const executor = yield* AuthorizedPluginExecutor
            const proposal = yield* connection.proposeAction(requestChangesProposal)
            return yield* executor.preflight(authorizeProposal(proposal))
          }),
          baseReviewClient({
            preflight: () =>
              Ref.updateAndGet(attempts, (count) => count + 1).pipe(
                Effect.flatMap((attempt) =>
                  attempt === 1
                    ? Effect.fail(
                      new Errors.AwsApiError({
                        operation: "getPullRequest",
                        profile: Schema.decodeUnknownSync(Domain.AwsProfileName)(configuration.profile),
                        region: Schema.decodeUnknownSync(Domain.AwsRegion)(configuration.region),
                        cause: { _tag: "ThrottlingException" }
                      })
                    )
                    : Effect.succeed(pullRequest)
                )
              )
          })
        )
      )
      yield* TestClock.adjust("30 seconds")
      const result = yield* Fiber.join(fiber)

      assert.strictEqual(result._tag, "ready")
      assert.strictEqual(yield* Ref.get(attempts), 2)
    }))

  it.effect("surfaces execute-phase throttling before provider intent as retryable", () =>
    Effect.gen(function*() {
      const attempts = yield* Ref.make(0)
      const result = yield* runWithClient(
        baseReadClient(),
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const proposal = yield* connection.proposeAction(requestChangesProposal)
          return yield* executor.executeAuthorizedAction(authorizeProposal(proposal))
        }),
        baseReviewClient({
          execute: () =>
            Ref.update(attempts, (count) => count + 1).pipe(
              Effect.andThen(
                Effect.fail(
                  new Errors.AwsApiError({
                    operation: "getPullRequest",
                    profile: Schema.decodeUnknownSync(Domain.AwsProfileName)(configuration.profile),
                    region: Schema.decodeUnknownSync(Domain.AwsRegion)(configuration.region),
                    cause: { _tag: "ThrottlingException" }
                  })
                )
              )
            )
        })
      ).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, PluginRateLimitFailure)
      assert.strictEqual(yield* Ref.get(attempts), 1)
    }))

  it.effect("blocks governed writes when the configured AWS profile changes identity", () =>
    Effect.gen(function*() {
      const identityArn = yield* Ref.make("arn:aws:iam::123456789012:user/reviewer")
      const mutationCalls = yield* Ref.make(0)
      const client = baseReadClient({
        discoverAccount: () =>
          Ref.get(identityArn).pipe(
            Effect.map((arn) =>
              new ReadClient.CodeCommitAccountIdentity({
                accountId: "123456789012",
                arn
              })
            )
          )
      })
      const reviewClient = baseReviewClient({
        execute: () =>
          Ref.update(mutationCalls, (count) => count + 1).pipe(
            Effect.andThen(Effect.die("identity change must block the mutation"))
          )
      })
      const result = yield* runWithClient(
        client,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const proposal = yield* connection.proposeAction(requestChangesProposal)
          yield* Ref.set(identityArn, "arn:aws:iam::123456789012:role/rotated-reviewer")
          return yield* executor.executeAuthorizedAction(authorizeProposal(proposal))
        }),
        reviewClient
      ).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, PluginConflictFailure)
      assert.strictEqual(yield* Ref.get(mutationCalls), 0)
    }))

  it.effect("reconciles an ambiguous provider outcome without replaying the mutation", () =>
    Effect.gen(function*() {
      const mutationCalls = yield* Ref.make(0)
      const reviewClient = baseReviewClient({
        execute: () =>
          Ref.update(mutationCalls, (count) => count + 1).pipe(
            Effect.andThen(Effect.fail(
              new Errors.AwsApiError({
                operation: "postPullRequestComment",
                profile: Schema.decodeUnknownSync(Domain.AwsProfileName)(configuration.profile),
                region: Schema.decodeUnknownSync(Domain.AwsRegion)(configuration.region),
                cause: { _tag: "TimeoutError" }
              })
            ))
          ),
        reconcile: () =>
          Effect.succeed({
            _tag: "succeeded",
            receipt: new ReviewClient.CodeCommitReviewReceipt({
              operationId: "comment:comment-reconciled",
              summary: "Change request posted to the pull request"
            })
          })
      })
      const result = yield* runWithClient(
        baseReadClient(),
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const proposal = yield* connection.proposeAction(requestChangesProposal)
          const authorized = authorizeProposal(proposal)
          const dispatch = yield* executor.executeAuthorizedAction(authorized).pipe(Effect.result)
          if (Result.isSuccess(dispatch)) return yield* Effect.die("expected ambiguous provider outcome")
          if (!Predicate.isTagged(dispatch.failure, "PluginUnknownOutcomeFailure")) {
            return yield* Effect.die("expected PluginUnknownOutcomeFailure")
          }
          const reconciliationRequest = Schema.decodeUnknownSync(Schema.toType(PluginActionReconciliationRequestV1))({
            reconciliationKey: dispatch.failure.reconciliationKey,
            idempotencyKey: authorized.idempotencyKey,
            payloadDigest: authorized.payloadDigest,
            authorizedAction: authorized
          })
          const idempotencyRequest = Schema.decodeUnknownSync(Schema.toType(PluginActionReconciliationRequestV1))({
            ...reconciliationRequest,
            reconciliationKey: null
          })
          return {
            byIdempotency: yield* executor.reconcile(idempotencyRequest),
            byLocator: yield* executor.reconcile(reconciliationRequest)
          }
        }),
        reviewClient
      )

      assert.strictEqual(result.byIdempotency._tag, "succeeded")
      assert.strictEqual(result.byLocator._tag, "succeeded")
      assert.strictEqual(yield* Ref.get(mutationCalls), 1)
    }))
})
