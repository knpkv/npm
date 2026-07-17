/**
 * Production CodeCommit read adapter for one configured repository.
 *
 * This first vertical slice owns pull-request discovery, immutable revision
 * reads, and complete paginated changed-file inventory. Provider writes and
 * diff content reads are intentionally not negotiated.
 *
 * @internal
 */
import { Domain, ReadClient } from "@knpkv/codecommit-core"
import * as Clock from "effect/Clock"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

import { PluginHealth } from "../../../domain/freshness.js"
import {
  type DiffInventoryPageRequestV1,
  DiffInventoryPageV1,
  PluginDiscoveryV1,
  PluginSyncPageV1,
  type PluginSyncRequestV1,
  type ReadPluginEntityRequestV1,
  ReadPluginEntityResultV1
} from "../../../domain/plugins/index.js"
import {
  PluginAuthenticationFailure,
  PluginAuthorizationFailure,
  PluginConfigurationFailure,
  type PluginFailure,
  PluginMalformedResponseFailure,
  PluginOutageFailure,
  PluginRateLimitFailure,
  PluginTimeoutFailure,
  PluginUnsupportedCapabilityFailure
} from "../failures.js"
import { pluginCapabilityCodecsV1 } from "../PluginCapabilityCodecs.js"
import type { PluginConnectionV1 } from "../PluginConnection.js"
import { definePluginV1 } from "../PluginDefinition.js"
import type { PluginDefinitionV1 } from "../PluginDefinitionV1.js"
import type { AuthorizedPluginExecutorV1 } from "../PluginExecutor.js"

const PULL_REQUEST_STREAM_KEY = "pull-requests"
const COMPLETED_CHECKPOINT = "complete"
const NEXT_CHECKPOINT_PREFIX = "next:"
const RETRY_DELAY_SECONDS = 30

const CodeCommitPluginConfiguration = Schema.Struct({
  profile: Domain.AwsProfileName,
  region: Domain.AwsRegion,
  repositoryName: Domain.RepositoryName
})

const descriptor = {
  contractId: "dev.knpkv.control-center.plugin",
  contractVersion: { major: 1, minor: 0, patch: 0 },
  pluginId: "dev.knpkv.codecommit",
  adapterVersion: { major: 0, minor: 1, patch: 0 },
  displayName: "AWS CodeCommit",
  configurationFields: [
    {
      _tag: "text",
      key: "profile",
      label: "AWS profile",
      description: "Local AWS credential profile resolved by the CodeCommit owning package.",
      required: true
    },
    {
      _tag: "text",
      key: "region",
      label: "AWS region",
      description: "AWS region containing the configured CodeCommit repository.",
      required: true
    },
    {
      _tag: "text",
      key: "repositoryName",
      label: "Repository",
      description: "One CodeCommit repository normalized by this connection.",
      required: true
    }
  ],
  capabilities: ["entity.read", "sync.incremental", "diff.inventory"].map((capabilityId) => ({
    capabilityId,
    supportedVersions: [1],
    requirement: "required"
  }))
} satisfies unknown

const output = <S extends Schema.Codec<unknown, unknown, never, never>>(
  operation: string,
  schema: S,
  value: unknown
): Effect.Effect<S["Type"], PluginMalformedResponseFailure> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() =>
      new PluginMalformedResponseFailure({
        operation,
        diagnosticCode: "codecommit-normalization-invalid"
      })
    )
  )

const causeHasTag = (cause: unknown, tags: ReadonlyArray<string>): boolean =>
  tags.some((tag) => Predicate.isTagged(cause, tag))

const failRead = Effect.fn("CodeCommitPlugin.failRead")(function*(
  operation: string,
  error: ReadClient.CodeCommitReadError
): Effect.fn.Return<never, PluginFailure> {
  switch (error._tag) {
    case "AwsCredentialError":
      return yield* new PluginAuthenticationFailure({ operation })
    case "AwsThrottleError": {
      const currentTimeMillis = yield* Clock.currentTimeMillis
      return yield* new PluginRateLimitFailure({
        operation,
        retryAt: DateTime.add(DateTime.makeUnsafe(currentTimeMillis), { seconds: RETRY_DELAY_SECONDS })
      })
    }
    case "CodeCommitMalformedResponseError":
      return yield* new PluginMalformedResponseFailure({ operation, diagnosticCode: error.diagnosticCode })
    case "CodeCommitReadNotFoundError":
      return yield* new PluginConfigurationFailure({ diagnosticCode: "codecommit-provider-object-not-found" })
    case "AwsApiError": {
      if (causeHasTag(error.cause, ["InvalidClientTokenId", "UnrecognizedClientException", "ExpiredTokenException"])) {
        return yield* new PluginAuthenticationFailure({ operation })
      }
      if (causeHasTag(error.cause, ["AccessDeniedException"])) {
        return yield* new PluginAuthorizationFailure({ operation })
      }
      if (causeHasTag(error.cause, ["ThrottlingException", "TooManyRequestsException"])) {
        const currentTimeMillis = yield* Clock.currentTimeMillis
        return yield* new PluginRateLimitFailure({
          operation,
          retryAt: DateTime.add(DateTime.makeUnsafe(currentTimeMillis), { seconds: RETRY_DELAY_SECONDS })
        })
      }
      if (causeHasTag(error.cause, ["TimeoutError"])) {
        return yield* new PluginTimeoutFailure({ operation })
      }
      return yield* new PluginOutageFailure({ operation })
    }
  }
})

const unsupported = (
  capabilityId: "action.propose" | "action.execute" | "action.cancel" | "action.reconcile" | "diff.content"
) =>
  new PluginUnsupportedCapabilityFailure({
    capabilityId,
    requestedVersion: 1,
    diagnosticCode: "codecommit-read-adapter-capability-not-offered"
  })

const now = Clock.currentTimeMillis.pipe(Effect.map(DateTime.makeUnsafe))

const consoleRepositoryUrl = (region: string, repositoryName: string): string =>
  `https://${region}.console.aws.amazon.com/codesuite/codecommit/repositories/${repositoryName}/browse`

const pullRequestSourceUrl = (
  configuration: typeof CodeCommitPluginConfiguration.Type,
  pullRequestId: string
): string => Domain.codecommitConsoleUrl(configuration.region, configuration.repositoryName, pullRequestId)

const toPullRequestEvent = (
  configuration: typeof CodeCommitPluginConfiguration.Type,
  pullRequest: ReadClient.CodeCommitPullRequestRevision
) => ({
  _tag: "UpsertEntity",
  eventId: `${configuration.repositoryName}:pull-request:${pullRequest.pullRequestId}:${pullRequest.revisionId}`,
  observedAt: pullRequest.lastActivityDate.toISOString(),
  revision: pullRequest.revisionId,
  entityType: "pull-request",
  vendorImmutableId: pullRequest.pullRequestId,
  sourceUrl: pullRequestSourceUrl(configuration, pullRequest.pullRequestId),
  title: pullRequest.title,
  attributes: {
    repository: pullRequest.repositoryName,
    description: pullRequest.description ?? null,
    authorArn: pullRequest.authorArn,
    status: pullRequest.status,
    sourceBranch: pullRequest.sourceReference.replace(/^refs\/heads\//u, ""),
    targetBranch: pullRequest.destinationReference.replace(/^refs\/heads\//u, ""),
    headRevision: pullRequest.sourceCommit,
    baseRevision: pullRequest.destinationCommit,
    mergeBase: pullRequest.mergeBase,
    creationDate: pullRequest.creationDate.toISOString(),
    lastActivityDate: pullRequest.lastActivityDate.toISOString()
  }
})

const providerTokenFromCheckpoint = (
  checkpoint: PluginSyncRequestV1["checkpoint"]
): Effect.Effect<string | null, PluginConfigurationFailure> => {
  if (checkpoint === null || checkpoint === COMPLETED_CHECKPOINT) return Effect.succeed(null)
  if (checkpoint.startsWith(NEXT_CHECKPOINT_PREFIX)) {
    const token = checkpoint.slice(NEXT_CHECKPOINT_PREFIX.length)
    return token.length > 0
      ? Effect.succeed(token)
      : Effect.fail(new PluginConfigurationFailure({ diagnosticCode: "codecommit-sync-checkpoint-invalid" }))
  }
  return Effect.fail(new PluginConfigurationFailure({ diagnosticCode: "codecommit-sync-checkpoint-invalid" }))
}

const checkpointFromProviderToken = (nextToken: string | null): string =>
  nextToken === null ? COMPLETED_CHECKPOINT : `${NEXT_CHECKPOINT_PREFIX}${nextToken}`

interface InventoryEntryInput {
  readonly path: string
  readonly previousPath: string | null
  readonly status: "added" | "modified" | "deleted" | "renamed"
  readonly binary: false
  readonly generated: false
  readonly oversized: false
}

const inventoryEntry = Effect.fn("CodeCommitPlugin.inventoryEntry")(function*(
  file: ReadClient.CodeCommitChangedFile
): Effect.fn.Return<InventoryEntryInput, PluginMalformedResponseFailure> {
  const path = file.after?.path ?? file.before?.path
  if (path === undefined) {
    return yield* new PluginMalformedResponseFailure({
      operation: "diff-inventory",
      diagnosticCode: "codecommit-changed-file-path-missing"
    })
  }
  return {
    path,
    previousPath: file.status === "renamed" ? file.before?.path ?? null : null,
    status: file.status,
    binary: false,
    generated: false,
    oversized: false
  }
})

const makeConnection = Effect.fn("CodeCommitPlugin.makeConnection")(function*(
  configuration: typeof CodeCommitPluginConfiguration.Type,
  descriptor: PluginConnectionV1["descriptor"]
): Effect.fn.Return<PluginConnectionV1, never, ReadClient.CodeCommitReadClient> {
  const readClient = yield* ReadClient.CodeCommitReadClient
  const account = { profile: configuration.profile, region: configuration.region }

  const discover = Effect.gen(function*() {
    const identity = yield* readClient.discoverAccount(account).pipe(
      Effect.catch((error) => failRead("discover", error))
    )
    const discoveredAt = yield* now
    return yield* output("discover", PluginDiscoveryV1, {
      account: { providerImmutableId: identity.accountId, displayName: identity.accountId },
      workspace: {
        providerImmutableId: configuration.repositoryName,
        displayName: configuration.repositoryName
      },
      endpoints: [{
        kind: "web",
        url: consoleRepositoryUrl(configuration.region, configuration.repositoryName),
        label: "CodeCommit repository"
      }],
      discoveredAt: DateTime.formatIso(discoveredAt)
    })
  })

  const health = readClient.discoverAccount(account).pipe(
    Effect.catch((error) => failRead("health", error)),
    Effect.andThen(now),
    Effect.flatMap((checkedAt) =>
      output("health", PluginHealth, {
        _tag: "healthy",
        checkedAt: DateTime.formatIso(checkedAt)
      })
    )
  )

  const readSyncPage = Effect.fn("CodeCommitPlugin.readSyncPage")(function*(nextToken: string | null) {
    const page = yield* readClient.listPullRequestsPage({
      account,
      repositoryName: configuration.repositoryName,
      status: "OPEN",
      nextToken
    }).pipe(Effect.catch((error) => failRead("sync", error)))
    const events = page.pullRequests.map((pullRequest) => toPullRequestEvent(configuration, pullRequest))
    const normalized = yield* output("sync", PluginSyncPageV1, {
      events,
      checkpointAfterPage: checkpointFromProviderToken(page.nextToken),
      hasMore: page.nextToken !== null
    })
    return { normalized, nextToken: page.nextToken }
  })

  const sync = (request: PluginSyncRequestV1) => {
    if (request.streamKey !== PULL_REQUEST_STREAM_KEY) {
      return Stream.fail(new PluginConfigurationFailure({ diagnosticCode: "codecommit-sync-stream-unsupported" }))
    }
    return Stream.unwrap(
      providerTokenFromCheckpoint(request.checkpoint).pipe(
        Effect.map((initialToken) =>
          Stream.paginate<string | null, PluginSyncPageV1, PluginFailure>(
            initialToken,
            (nextToken) =>
              readSyncPage(nextToken).pipe(
                Effect.map(({ nextToken, normalized }) => [
                  [normalized],
                  nextToken === null ? Option.none<string | null>() : Option.some<string | null>(nextToken)
                ])
              )
          )
        )
      )
    )
  }

  const readEntity = Effect.fn("CodeCommitPlugin.readEntity")(function*(request: ReadPluginEntityRequestV1) {
    if (request.entityType !== "pull-request") {
      return yield* new PluginUnsupportedCapabilityFailure({
        capabilityId: "entity.read",
        requestedVersion: 1,
        diagnosticCode: "codecommit-entity-type-unsupported"
      })
    }
    const result = yield* readClient.getPullRequest({
      account,
      pullRequestId: request.vendorImmutableId
    }).pipe(Effect.result)
    if (result._tag === "Failure") {
      if (result.failure._tag === "CodeCommitReadNotFoundError") {
        const observedAt = yield* now
        return yield* output("read-entity", ReadPluginEntityResultV1, {
          _tag: "missing",
          reference: request,
          observedAt: DateTime.formatIso(observedAt)
        })
      }
      return yield* failRead("read-entity", result.failure)
    }
    const event = toPullRequestEvent(configuration, result.success)
    return yield* output("read-entity", ReadPluginEntityResultV1, { _tag: "found", event })
  })

  const readInventoryPage = Effect.fn("CodeCommitPlugin.readInventoryPage")(function*(
    request: DiffInventoryPageRequestV1
  ) {
    if (request.entity.entityType !== "pull-request") {
      return yield* new PluginUnsupportedCapabilityFailure({
        capabilityId: "diff.inventory",
        requestedVersion: 1,
        diagnosticCode: "codecommit-diff-entity-type-unsupported"
      })
    }
    const pullRequest = yield* readClient.getPullRequest({
      account,
      pullRequestId: request.entity.vendorImmutableId
    }).pipe(Effect.catch((error) => failRead("diff-inventory", error)))
    const page = yield* readClient.getChangedFilesPage({
      account,
      repositoryName: pullRequest.repositoryName,
      beforeCommitSpecifier: pullRequest.destinationCommit,
      afterCommitSpecifier: pullRequest.sourceCommit,
      nextToken: request.cursor
    }).pipe(Effect.catch((error) => failRead("diff-inventory", error)))
    const entries = yield* Effect.forEach(page.files, inventoryEntry)
    return yield* output("diff-inventory", DiffInventoryPageV1, {
      entries,
      nextCursor: page.nextToken
    })
  })

  const connection: PluginConnectionV1 = {
    descriptor,
    discover,
    health,
    sync,
    readEntity,
    diff: Option.some({
      readInventoryPage,
      readContentRange: () => Effect.fail(unsupported("diff.content"))
    }),
    proposeAction: () => Effect.fail(unsupported("action.propose"))
  }
  return connection
})

const executor: AuthorizedPluginExecutorV1 = {
  preflight: () => Effect.fail(unsupported("action.execute")),
  executeAuthorizedAction: () => Effect.fail(unsupported("action.execute")),
  requestCancellation: () => Effect.fail(unsupported("action.cancel")),
  reconcile: () => Effect.fail(unsupported("action.reconcile"))
}

/** Internal requirement-preserving definition used by the runtime registry and adapter tests. @internal */
export const codeCommitPluginDefinition = definePluginV1({
  rawDescriptor: descriptor,
  configurationSchema: CodeCommitPluginConfiguration,
  capabilityCodecs: {
    entityRead: pluginCapabilityCodecsV1.entityRead,
    syncIncremental: pluginCapabilityCodecsV1.syncIncremental,
    diffInventory: pluginCapabilityCodecsV1.diffInventory
  },
  make: ({ configuration, descriptor: negotiatedDescriptor }) =>
    makeConnection(configuration, negotiatedDescriptor).pipe(
      Effect.map((connection) => ({ connection, executor }))
    )
})

/** Opaque production CodeCommit plugin definition for first-party registration. */
export const CodeCommitPluginDefinition: PluginDefinitionV1 = codeCommitPluginDefinition
