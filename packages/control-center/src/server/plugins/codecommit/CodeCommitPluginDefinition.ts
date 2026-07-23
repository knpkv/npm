/**
 * Production CodeCommit read adapter for one configured repository.
 *
 * Owns pull-request discovery, immutable revision reads, complete paginated
 * changed-file inventory, and governed review actions. CodeCommit exposes
 * native approval and revoke mutations; request-review and
 * request-changes are represented by idempotent comments on the exact commits
 * because the provider has no corresponding review-state API. Governed merge
 * is intentionally not offered because CodeCommit has no single operation that
 * both enforces PR approval rules and compare-and-sets the authorized base.
 *
 * @internal
 */
import * as Domain from "@knpkv/codecommit-core/Domain.js"
import * as ReadClient from "@knpkv/codecommit-core/ReadClient.js"
import * as ReviewClient from "@knpkv/codecommit-core/ReviewClient.js"
import * as Clock from "effect/Clock"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as HashMap from "effect/HashMap"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as SynchronizedRef from "effect/SynchronizedRef"

import { PluginHealth } from "../../../domain/freshness.js"
import {
  type AuthorizedPluginActionV1,
  type DiffInventoryPageRequestV1,
  DiffInventoryPageV1,
  type PluginActionDispatchResultV1,
  PluginActionPreflightV1,
  PluginActionProposalV1,
  PluginActionReconciliationKey,
  type PluginActionReconciliationRequestV1,
  type PluginActionReconciliationResultV1,
  PluginDiscoveryV1,
  PluginProviderOperationId,
  PluginSyncPageV1,
  type PluginSyncRequestV1,
  type ProposePluginActionRequestV1,
  type ReadPluginEntityRequestV1,
  ReadPluginEntityResultV1
} from "../../../domain/plugins/index.js"
import { Revision } from "../../../domain/sourceRevision.js"
import { digestGovernedActionPayload } from "../../governance/governedActionDigests.js"
import {
  PluginAuthenticationFailure,
  PluginAuthorizationFailure,
  PluginConfigurationFailure,
  PluginConflictFailure,
  type PluginFailure,
  PluginMalformedResponseFailure,
  PluginOutageFailure,
  PluginRateLimitFailure,
  PluginTimeoutFailure,
  PluginUnknownOutcomeFailure,
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
const CLOSED_CHECKPOINT = "closed"
const CLOSED_NEXT_CHECKPOINT_PREFIX = "closed:"
const RETRY_DELAY_SECONDS = 30

type PullRequestStatus = "OPEN" | "CLOSED"

interface SyncCursor {
  readonly status: PullRequestStatus
  readonly nextToken: string | null
}

/** Secret-free production adapter configuration. @internal */
export const CodeCommitPluginConfiguration = Schema.Struct({
  profile: Domain.AwsProfileName,
  region: Domain.AwsRegion,
  repositoryName: Domain.RepositoryName,
  runtimeIdentity: Schema.optional(ReadClient.CodeCommitAccountIdentity)
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
  capabilities: [
    "entity.read",
    "sync.incremental",
    "action.propose",
    "action.execute",
    "action.reconcile",
    "diff.inventory"
  ].map((capabilityId) => ({
    capabilityId,
    supportedVersions: [1],
    requirement: "required"
  }))
} satisfies unknown

/** Current persisted descriptor snapshot used by first-party compatibility checks. @internal */
export const codeCommitPluginDescriptor = descriptor

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
    case "CodeCommitBlobTooLargeError":
      return yield* new PluginMalformedResponseFailure({
        operation,
        diagnosticCode: "codecommit-blob-too-large"
      })
    case "CodeCommitReadNotFoundError":
      return yield* new PluginConfigurationFailure({ diagnosticCode: "codecommit-provider-object-not-found" })
    case "AwsApiError": {
      if (causeHasTag(error.cause, ["InvalidClientTokenId", "UnrecognizedClientException", "ExpiredTokenException"])) {
        return yield* new PluginAuthenticationFailure({ operation })
      }
      if (causeHasTag(error.cause, ["AccessDeniedException", "EncryptionKeyAccessDeniedException"])) {
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

const failReview = Effect.fn("CodeCommitPlugin.failReview")(function*(
  operation: string,
  error: ReviewClient.CodeCommitReviewError,
  ambiguousOutcome: PluginActionReconciliationKey | null
): Effect.fn.Return<never, PluginFailure> {
  switch (error._tag) {
    case "AwsCredentialError":
      return yield* new PluginAuthenticationFailure({ operation })
    case "AwsThrottleError": {
      if (ambiguousOutcome !== null) {
        return yield* new PluginUnknownOutcomeFailure({
          operation,
          reconciliationKey: ambiguousOutcome
        })
      }
      const currentTimeMillis = yield* Clock.currentTimeMillis
      return yield* new PluginRateLimitFailure({
        operation,
        retryAt: DateTime.add(DateTime.makeUnsafe(currentTimeMillis), { seconds: RETRY_DELAY_SECONDS })
      })
    }
    case "CodeCommitMalformedResponseError":
      if (ambiguousOutcome !== null) {
        return yield* new PluginUnknownOutcomeFailure({
          operation,
          reconciliationKey: ambiguousOutcome
        })
      }
      return yield* new PluginMalformedResponseFailure({
        operation,
        diagnosticCode: error.diagnosticCode
      })
    case "CodeCommitBlobTooLargeError":
      return yield* new PluginMalformedResponseFailure({
        operation,
        diagnosticCode: "codecommit-review-unexpected-blob-read"
      })
    case "CodeCommitReadNotFoundError":
      return yield* new PluginConflictFailure({
        operation,
        diagnosticCode: "codecommit-review-target-not-found"
      })
    case "CodeCommitReviewConflictError":
      return yield* new PluginConflictFailure({
        operation,
        diagnosticCode: `codecommit-${error.reason}`
      })
    case "AwsApiError": {
      if (causeHasTag(error.cause, ["InvalidClientTokenId", "UnrecognizedClientException", "ExpiredTokenException"])) {
        return yield* new PluginAuthenticationFailure({ operation })
      }
      if (causeHasTag(error.cause, ["AccessDeniedException", "EncryptionKeyAccessDeniedException"])) {
        return yield* new PluginAuthorizationFailure({ operation })
      }
      if (causeHasTag(error.cause, ["ThrottlingException", "TooManyRequestsException"])) {
        if (ambiguousOutcome !== null) {
          return yield* new PluginUnknownOutcomeFailure({
            operation,
            reconciliationKey: ambiguousOutcome
          })
        }
        const currentTimeMillis = yield* Clock.currentTimeMillis
        return yield* new PluginRateLimitFailure({
          operation,
          retryAt: DateTime.add(DateTime.makeUnsafe(currentTimeMillis), { seconds: RETRY_DELAY_SECONDS })
        })
      }
      if (ambiguousOutcome !== null) {
        return yield* new PluginUnknownOutcomeFailure({
          operation,
          reconciliationKey: ambiguousOutcome
        })
      }
      if (causeHasTag(error.cause, ["TimeoutError"])) {
        return yield* new PluginTimeoutFailure({ operation })
      }
      return yield* new PluginOutageFailure({ operation })
    }
  }
})

const isConfirmedReviewRejection = (error: ReviewClient.CodeCommitReviewError): boolean => {
  switch (error._tag) {
    case "AwsCredentialError":
    case "CodeCommitReadNotFoundError":
    case "CodeCommitReviewConflictError":
      return true
    case "AwsThrottleError":
    case "CodeCommitBlobTooLargeError":
    case "CodeCommitMalformedResponseError":
      return false
    case "AwsApiError":
      return causeHasTag(error.cause, [
        "AccessDeniedException",
        "EncryptionKeyAccessDeniedException",
        "ExpiredTokenException",
        "IdempotencyParameterMismatchException",
        "InvalidClientTokenId",
        "PullRequestCannotBeApprovedByAuthorException",
        "UnrecognizedClientException"
      ])
  }
}

const unsupported = (
  capabilityId: "action.cancel" | "diff.content"
) =>
  new PluginUnsupportedCapabilityFailure({
    capabilityId,
    requestedVersion: 1,
    diagnosticCode: "codecommit-adapter-capability-not-offered"
  })

const ReviewCommentPayload = Schema.Struct({
  content: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(10_240))
})

const RequestReviewPayload = Schema.Struct({
  reviewerArns: Schema.Array(
    Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(2_048))
  ).check(Schema.isNonEmpty(), Schema.isUnique(), Schema.isMaxLength(50)),
  message: Schema.optional(
    Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(8_192))
  )
})

const EmptyPayload = Schema.Struct({})
const ReviewCommitId = ReadClient.CodeCommitCommitId.check(Schema.isMaxLength(64))
const ReviewReference = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(256))
const ReviewClientRequestToken = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(64)
)

const CodeCommitActionPayload = Schema.Union([
  Schema.TaggedStruct("request-review", {
    sourceCommit: ReviewCommitId,
    destinationCommit: ReviewCommitId,
    destinationReference: ReviewReference,
    reviewerArns: RequestReviewPayload.fields.reviewerArns,
    content: ReviewCommentPayload.fields.content,
    clientRequestToken: ReviewClientRequestToken
  }),
  Schema.TaggedStruct("comment", {
    sourceCommit: ReviewCommitId,
    destinationCommit: ReviewCommitId,
    destinationReference: ReviewReference,
    content: ReviewCommentPayload.fields.content,
    clientRequestToken: ReviewClientRequestToken
  }),
  Schema.TaggedStruct("request-changes", {
    sourceCommit: ReviewCommitId,
    destinationCommit: ReviewCommitId,
    destinationReference: ReviewReference,
    content: ReviewCommentPayload.fields.content,
    clientRequestToken: ReviewClientRequestToken
  }),
  Schema.TaggedStruct("approve", {
    sourceCommit: ReviewCommitId,
    destinationCommit: ReviewCommitId,
    destinationReference: ReviewReference
  }),
  Schema.TaggedStruct("revoke-approval", {
    sourceCommit: ReviewCommitId,
    destinationCommit: ReviewCommitId,
    destinationReference: ReviewReference
  })
]).pipe(Schema.toTaggedUnion("_tag"))

type CodeCommitActionPayload = typeof CodeCommitActionPayload.Type

const actionKinds: readonly [
  "request-review",
  "comment",
  "request-changes",
  "approve",
  "revoke-approval"
] = [
  "request-review",
  "comment",
  "request-changes",
  "approve",
  "revoke-approval"
]

type CodeCommitActionKind = typeof actionKinds[number]

const isActionKind = (value: string): value is CodeCommitActionKind =>
  actionKinds.some((actionKind) => actionKind === value)

const actionSummary = (actionKind: CodeCommitActionKind, pullRequestId: string): string => {
  switch (actionKind) {
    case "request-review":
      return `Request review on CodeCommit pull request #${pullRequestId}`
    case "comment":
      return `Comment on CodeCommit pull request #${pullRequestId}`
    case "request-changes":
      return `Request changes on CodeCommit pull request #${pullRequestId}`
    case "approve":
      return `Approve CodeCommit pull request #${pullRequestId}`
    case "revoke-approval":
      return `Revoke approval on CodeCommit pull request #${pullRequestId}`
  }
}

const actionImpact = (
  actionKind: CodeCommitActionKind
): { readonly level: "medium"; readonly summary: string } => ({
  level: "medium",
  summary: actionKind === "approve" || actionKind === "revoke-approval"
    ? "Changes the signed-in AWS identity's approval state"
    : "Adds a durable review comment to the pull request"
})

const decodeRequestedPayload = Effect.fn("CodeCommitPlugin.decodeRequestedPayload")(function*(
  actionKind: CodeCommitActionKind,
  payload: ProposePluginActionRequestV1["payload"]
) {
  const schema = actionKind === "request-review"
    ? RequestReviewPayload
    : actionKind === "comment" || actionKind === "request-changes"
    ? ReviewCommentPayload
    : EmptyPayload
  return yield* Schema.decodeUnknownEffect(Schema.toType(schema))(payload).pipe(
    Effect.mapError(() => new PluginConfigurationFailure({ diagnosticCode: "codecommit-action-payload-invalid" }))
  )
})

const reviewRequestContent = (
  payload: typeof RequestReviewPayload.Type
): string => {
  const reviewers = payload.reviewerArns.map((reviewerArn) => `- ${reviewerArn}`).join("\n")
  return `${
    payload.message === undefined ? "Review requested." : payload.message
  }\n\nRequested reviewers:\n${reviewers}`
}

const decodeNormalizedActionPayload = (
  value: unknown
): Effect.Effect<CodeCommitActionPayload, PluginConfigurationFailure> =>
  Schema.decodeUnknownEffect(Schema.toType(CodeCommitActionPayload))(value).pipe(
    Effect.mapError(() => new PluginConfigurationFailure({ diagnosticCode: "codecommit-action-payload-invalid" }))
  )

const commentClientRequestToken = Effect.fn("CodeCommitPlugin.commentClientRequestToken")(function*(
  actionKind: "comment" | "request-changes" | "request-review",
  content: string,
  pullRequest: ReadClient.CodeCommitPullRequestRevision,
  cryptoService: Crypto.Crypto
) {
  return yield* digestGovernedActionPayload({
    actionKind,
    repositoryName: pullRequest.repositoryName,
    pullRequestId: pullRequest.pullRequestId,
    revisionId: pullRequest.revisionId,
    sourceCommit: pullRequest.sourceCommit,
    destinationCommit: pullRequest.destinationCommit,
    content
  }).pipe(
    Effect.provideService(Crypto.Crypto, cryptoService),
    Effect.mapError(() => new PluginOutageFailure({ operation: "propose-action" }))
  )
})

const normalizeActionPayload = Effect.fn("CodeCommitPlugin.normalizeActionPayload")(function*(
  actionKind: CodeCommitActionKind,
  payload: ProposePluginActionRequestV1["payload"],
  pullRequest: ReadClient.CodeCommitPullRequestRevision,
  cryptoService: Crypto.Crypto
): Effect.fn.Return<CodeCommitActionPayload, PluginConfigurationFailure | PluginOutageFailure> {
  const requested = yield* decodeRequestedPayload(actionKind, payload)
  switch (actionKind) {
    case "request-review": {
      const decoded = yield* Schema.decodeUnknownEffect(Schema.toType(RequestReviewPayload))(requested).pipe(
        Effect.mapError(() => new PluginConfigurationFailure({ diagnosticCode: "codecommit-action-payload-invalid" }))
      )
      const content = reviewRequestContent(decoded)
      return yield* decodeNormalizedActionPayload({
        _tag: actionKind,
        sourceCommit: pullRequest.sourceCommit,
        destinationCommit: pullRequest.destinationCommit,
        destinationReference: pullRequest.destinationReference,
        reviewerArns: decoded.reviewerArns,
        content,
        clientRequestToken: yield* commentClientRequestToken(actionKind, content, pullRequest, cryptoService)
      })
    }
    case "comment":
    case "request-changes": {
      const decoded = yield* Schema.decodeUnknownEffect(Schema.toType(ReviewCommentPayload))(requested).pipe(
        Effect.mapError(() => new PluginConfigurationFailure({ diagnosticCode: "codecommit-action-payload-invalid" }))
      )
      return yield* decodeNormalizedActionPayload({
        _tag: actionKind,
        sourceCommit: pullRequest.sourceCommit,
        destinationCommit: pullRequest.destinationCommit,
        destinationReference: pullRequest.destinationReference,
        content: decoded.content,
        clientRequestToken: yield* commentClientRequestToken(actionKind, decoded.content, pullRequest, cryptoService)
      })
    }
    case "approve":
    case "revoke-approval":
      return yield* decodeNormalizedActionPayload({
        _tag: actionKind,
        sourceCommit: pullRequest.sourceCommit,
        destinationCommit: pullRequest.destinationCommit,
        destinationReference: pullRequest.destinationReference
      })
  }
})

const ReconciliationLocatorWire = Schema.Tuple([
  Schema.Literals(actionKinds),
  Domain.PullRequestId.check(Schema.isMaxLength(64)),
  Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(64)),
  ReviewCommitId,
  ReviewCommitId,
  Schema.NullOr(Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(64)))
]).check(
  Schema.makeFilter(
    ([actionKind, _pullRequestId, _revisionId, _sourceCommit, _destinationCommit, clientRequestToken]) =>
      actionKind === "request-review" || actionKind === "comment" || actionKind === "request-changes"
        ? clientRequestToken !== null
        : clientRequestToken === null,
    { expected: "a comment token only for comment-backed review actions" }
  )
)

interface ReconciliationLocator {
  readonly actionKind: CodeCommitActionKind
  readonly pullRequestId: Domain.PullRequestId
  readonly revisionId: string
  readonly sourceCommit: ReadClient.CodeCommitCommitId
  readonly destinationCommit: ReadClient.CodeCommitCommitId
  readonly clientRequestToken: string | null
}

const encodeReconciliationLocator = (
  locator: ReconciliationLocator
): PluginActionReconciliationKey =>
  PluginActionReconciliationKey.make(`ccmt:v1:${
    Encoding.encodeBase64Url(JSON.stringify([
      locator.actionKind,
      locator.pullRequestId,
      locator.revisionId,
      locator.sourceCommit,
      locator.destinationCommit,
      locator.clientRequestToken
    ]))
  }`)

const decodeReconciliationLocator = (
  key: PluginActionReconciliationKey
): Effect.Effect<ReconciliationLocator, PluginConfigurationFailure> => {
  const encoded = key.startsWith("ccmt:v1:") ? key.slice("ccmt:v1:".length) : ""
  const decoded = Encoding.decodeBase64UrlString(encoded)
  if (Result.isFailure(decoded)) {
    return Effect.fail(
      new PluginConfigurationFailure({
        diagnosticCode: "codecommit-reconciliation-key-invalid"
      })
    )
  }
  return Schema.decodeUnknownEffect(Schema.fromJsonString(ReconciliationLocatorWire))(decoded.success).pipe(
    Effect.map(([actionKind, pullRequestId, revisionId, sourceCommit, destinationCommit, clientRequestToken]) => ({
      actionKind,
      pullRequestId,
      revisionId,
      sourceCommit,
      destinationCommit,
      clientRequestToken
    })),
    Effect.mapError(() => new PluginConfigurationFailure({ diagnosticCode: "codecommit-reconciliation-key-invalid" }))
  )
}

const actionFromPayload = (
  account: ReadClient.CodeCommitReadAccount,
  repositoryName: Domain.RepositoryName,
  pullRequestId: Domain.PullRequestId,
  revisionId: string,
  payload: CodeCommitActionPayload
): ReviewClient.CodeCommitReviewAction => {
  const target = {
    account,
    repositoryName,
    pullRequestId,
    revisionId,
    sourceCommit: payload.sourceCommit,
    destinationCommit: payload.destinationCommit,
    destinationReference: payload.destinationReference
  }
  switch (payload._tag) {
    case "request-review":
    case "comment":
    case "request-changes":
      return {
        _tag: payload._tag,
        target,
        content: payload.content,
        clientRequestToken: payload.clientRequestToken
      }
    case "approve":
    case "revoke-approval":
      return { _tag: payload._tag, target }
  }
}

const actionFromLocator = (
  account: ReadClient.CodeCommitReadAccount,
  repositoryName: Domain.RepositoryName,
  locator: ReconciliationLocator
): ReviewClient.CodeCommitReviewAction => {
  const target = {
    account,
    repositoryName,
    pullRequestId: locator.pullRequestId,
    revisionId: locator.revisionId,
    sourceCommit: locator.sourceCommit,
    destinationCommit: locator.destinationCommit,
    destinationReference: "refs/heads/reconciliation-only"
  }
  switch (locator.actionKind) {
    case "request-review":
    case "comment":
    case "request-changes":
      return {
        _tag: locator.actionKind,
        target,
        content: "Reconcile the previously dispatched review comment",
        clientRequestToken: locator.clientRequestToken ?? "invalid-missing-client-request-token"
      }
    case "approve":
    case "revoke-approval":
      return { _tag: locator.actionKind, target }
  }
}

const locatorForAction = (
  action: ReviewClient.CodeCommitReviewAction
): PluginActionReconciliationKey =>
  encodeReconciliationLocator({
    actionKind: action._tag,
    pullRequestId: action.target.pullRequestId,
    revisionId: action.target.revisionId,
    sourceCommit: action.target.sourceCommit,
    destinationCommit: action.target.destinationCommit,
    clientRequestToken: action._tag === "request-review" ||
        action._tag === "comment" ||
        action._tag === "request-changes"
      ? action.clientRequestToken
      : null
  })

const decodeAuthorizedAction = Effect.fn("CodeCommitPlugin.decodeAuthorizedAction")(function*(
  account: ReadClient.CodeCommitReadAccount,
  repositoryName: Domain.RepositoryName,
  request: AuthorizedPluginActionV1
) {
  const proposal = request.proposal
  if (
    proposal.request.target.entityType !== "pull-request" ||
    !isActionKind(proposal.request.actionKind)
  ) {
    return yield* new PluginConfigurationFailure({
      diagnosticCode: "codecommit-action-kind-or-target-invalid"
    })
  }
  const payload = yield* Schema.decodeUnknownEffect(Schema.toType(CodeCommitActionPayload))(
    proposal.request.payload
  ).pipe(
    Effect.mapError(() => new PluginConfigurationFailure({ diagnosticCode: "codecommit-action-payload-invalid" }))
  )
  if (payload._tag !== proposal.request.actionKind) {
    return yield* new PluginConfigurationFailure({
      diagnosticCode: "codecommit-action-kind-payload-mismatch"
    })
  }
  const pullRequestId = yield* Schema.decodeUnknownEffect(Domain.PullRequestId)(
    proposal.request.target.vendorImmutableId
  ).pipe(
    Effect.mapError(() => new PluginConfigurationFailure({ diagnosticCode: "codecommit-pull-request-id-invalid" }))
  )
  return actionFromPayload(
    account,
    repositoryName,
    pullRequestId,
    proposal.request.expectedRevision,
    payload
  )
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

const syncCursorFromCheckpoint = (
  checkpoint: PluginSyncRequestV1["checkpoint"]
): Effect.Effect<SyncCursor, PluginConfigurationFailure> => {
  if (checkpoint === null || checkpoint === COMPLETED_CHECKPOINT) {
    return Effect.succeed({ status: "OPEN", nextToken: null })
  }
  if (checkpoint === CLOSED_CHECKPOINT) return Effect.succeed({ status: "CLOSED", nextToken: null })
  if (checkpoint.startsWith(NEXT_CHECKPOINT_PREFIX)) {
    const token = checkpoint.slice(NEXT_CHECKPOINT_PREFIX.length)
    return token.length > 0
      ? Effect.succeed({ status: "OPEN", nextToken: token })
      : Effect.fail(new PluginConfigurationFailure({ diagnosticCode: "codecommit-sync-checkpoint-invalid" }))
  }
  if (checkpoint.startsWith(CLOSED_NEXT_CHECKPOINT_PREFIX)) {
    const token = checkpoint.slice(CLOSED_NEXT_CHECKPOINT_PREFIX.length)
    return token.length > 0
      ? Effect.succeed({ status: "CLOSED", nextToken: token })
      : Effect.fail(new PluginConfigurationFailure({ diagnosticCode: "codecommit-sync-checkpoint-invalid" }))
  }
  return Effect.fail(new PluginConfigurationFailure({ diagnosticCode: "codecommit-sync-checkpoint-invalid" }))
}

const checkpointFromSyncCursor = (cursor: SyncCursor | null): string => {
  if (cursor === null) return COMPLETED_CHECKPOINT
  if (cursor.nextToken === null) return CLOSED_CHECKPOINT
  return cursor.status === "OPEN"
    ? `${NEXT_CHECKPOINT_PREFIX}${cursor.nextToken}`
    : `${CLOSED_NEXT_CHECKPOINT_PREFIX}${cursor.nextToken}`
}

const nextSyncCursor = (status: PullRequestStatus, nextToken: string | null): SyncCursor | null => {
  if (nextToken !== null) return { status, nextToken }
  return status === "OPEN" ? { status: "CLOSED", nextToken: null } : null
}

const enforceConfiguredRepository = Effect.fn("CodeCommitPlugin.enforceConfiguredRepository")(function*(
  configuredRepositoryName: string,
  pullRequest: ReadClient.CodeCommitPullRequestRevision
) {
  if (pullRequest.repositoryName !== configuredRepositoryName) {
    return yield* new PluginConfigurationFailure({
      diagnosticCode: "codecommit-pull-request-repository-mismatch"
    })
  }
  return pullRequest
})

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
): Effect.fn.Return<
  { readonly connection: PluginConnectionV1; readonly executor: AuthorizedPluginExecutorV1 },
  PluginFailure,
  Crypto.Crypto | ReadClient.CodeCommitReadClient | ReviewClient.CodeCommitReviewClient
> {
  const readClient = yield* ReadClient.CodeCommitReadClient
  const reviewClient = yield* ReviewClient.CodeCommitReviewClient
  const cryptoService = yield* Crypto.Crypto
  const dispatches = yield* SynchronizedRef.make(HashMap.empty<string, {
    readonly payloadDigest: string
    readonly result: Result.Result<PluginActionDispatchResultV1, PluginFailure>
  }>())
  const account = { profile: configuration.profile, region: configuration.region }
  const runtimeIdentity = configuration.runtimeIdentity ??
    (yield* readClient.discoverAccount(account).pipe(
      Effect.catch((error) => failRead("runtime-identity", error))
    ))
  const verifyRuntimeIdentity = Effect.fn("CodeCommitPlugin.verifyRuntimeIdentity")(function*() {
    const currentIdentity = yield* readClient.discoverAccount(account).pipe(
      Effect.catch((error) => failRead("runtime-identity", error))
    )
    if (
      currentIdentity.accountId !== runtimeIdentity.accountId ||
      currentIdentity.arn !== runtimeIdentity.arn
    ) {
      return yield* new PluginConflictFailure({
        operation: "runtime-identity",
        diagnosticCode: "codecommit-runtime-identity-changed"
      })
    }
  })
  const probeRepository = readClient.listPullRequestsPage({
    account,
    repositoryName: configuration.repositoryName,
    status: "OPEN",
    nextToken: null
  }).pipe(
    Effect.catch((error) => failRead("repository-probe", error)),
    Effect.asVoid
  )

  const discover = Effect.gen(function*() {
    const identity = yield* readClient.discoverAccount(account).pipe(
      Effect.catch((error) => failRead("discover", error))
    )
    yield* probeRepository
    const discoveredAt = yield* now
    return yield* output("discover", PluginDiscoveryV1, {
      account: { providerImmutableId: identity.accountId, displayName: identity.accountId },
      workspace: null,
      resource: {
        providerImmutableId: `${configuration.region}:${configuration.repositoryName}`,
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
    Effect.andThen(probeRepository),
    Effect.andThen(now),
    Effect.flatMap((checkedAt) =>
      output("health", PluginHealth, {
        _tag: "healthy",
        checkedAt: DateTime.formatIso(checkedAt)
      })
    )
  )

  const readSyncPage = Effect.fn("CodeCommitPlugin.readSyncPage")(function*(cursor: SyncCursor) {
    const page = yield* readClient.listPullRequestsPage({
      account,
      repositoryName: configuration.repositoryName,
      status: cursor.status,
      nextToken: cursor.nextToken
    }).pipe(Effect.catch((error) => failRead("sync", error)))
    const pullRequests = yield* Effect.forEach(
      page.pullRequests,
      (pullRequest) => enforceConfiguredRepository(configuration.repositoryName, pullRequest)
    )
    const events = pullRequests.map((pullRequest) => toPullRequestEvent(configuration, pullRequest))
    const nextCursor = nextSyncCursor(cursor.status, page.nextToken)
    const normalized = yield* output("sync", PluginSyncPageV1, {
      events,
      checkpointAfterPage: checkpointFromSyncCursor(nextCursor),
      hasMore: nextCursor !== null
    })
    return { normalized, nextCursor }
  })

  const sync = (request: PluginSyncRequestV1) => {
    if (request.streamKey !== PULL_REQUEST_STREAM_KEY) {
      return Stream.fail(new PluginConfigurationFailure({ diagnosticCode: "codecommit-sync-stream-unsupported" }))
    }
    return Stream.unwrap(
      syncCursorFromCheckpoint(request.checkpoint).pipe(
        Effect.map((initialCursor) =>
          Stream.paginate<SyncCursor, PluginSyncPageV1, PluginFailure>(
            initialCursor,
            (cursor) =>
              readSyncPage(cursor).pipe(
                Effect.map(({ nextCursor, normalized }) => [
                  [normalized],
                  nextCursor === null ? Option.none<SyncCursor>() : Option.some(nextCursor)
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
    const pullRequest = yield* enforceConfiguredRepository(configuration.repositoryName, result.success)
    const event = toPullRequestEvent(configuration, pullRequest)
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
    yield* enforceConfiguredRepository(configuration.repositoryName, pullRequest)
    const page = yield* readClient.getChangedFilesPage({
      account,
      repositoryName: configuration.repositoryName,
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

  const proposeAction = Effect.fn("CodeCommitPlugin.proposeAction")(function*(
    request: ProposePluginActionRequestV1
  ) {
    if (request.target.entityType !== "pull-request" || !isActionKind(request.actionKind)) {
      return yield* new PluginUnsupportedCapabilityFailure({
        capabilityId: "action.propose",
        requestedVersion: 1,
        diagnosticCode: "codecommit-action-kind-or-target-unsupported"
      })
    }
    const pullRequest = yield* readClient.getPullRequest({
      account,
      pullRequestId: request.target.vendorImmutableId
    }).pipe(Effect.catch((error) => failRead("propose-action", error)))
    yield* enforceConfiguredRepository(configuration.repositoryName, pullRequest)
    if (pullRequest.status !== "OPEN" || pullRequest.revisionId !== request.expectedRevision) {
      return yield* new PluginConflictFailure({
        operation: "propose-action",
        diagnosticCode: pullRequest.status !== "OPEN"
          ? "codecommit-pull-request-closed"
          : "codecommit-revision-changed"
      })
    }
    const payload = yield* normalizeActionPayload(request.actionKind, request.payload, pullRequest, cryptoService)
    const payloadDigest = yield* digestGovernedActionPayload(payload).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService),
      Effect.mapError(() => new PluginOutageFailure({ operation: "propose-action" }))
    )
    const proposedAt = yield* now
    return yield* output("propose-action", PluginActionProposalV1, {
      proposalKey: `ccmt:${request.actionKind}:${pullRequest.pullRequestId}:${pullRequest.revisionId}:${payloadDigest}`,
      capabilityVersion: 1,
      request: {
        ...request,
        payload
      },
      payloadDigest,
      summary: actionSummary(request.actionKind, pullRequest.pullRequestId),
      impact: actionImpact(request.actionKind),
      proposedAt: DateTime.formatIso(proposedAt)
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
    proposeAction
  }

  const preflight = Effect.fn("CodeCommitPlugin.preflight")(function*(
    request: AuthorizedPluginActionV1
  ) {
    yield* verifyRuntimeIdentity()
    const action = yield* decodeAuthorizedAction(account, configuration.repositoryName, request)
    const result = yield* reviewClient.preflight(action).pipe(Effect.result)
    const checkedAt = yield* now
    if (Result.isSuccess(result)) {
      return yield* output("preflight", PluginActionPreflightV1, {
        _tag: "ready",
        checkedRevision: Revision.make(result.success.revisionId),
        checkedAt: DateTime.formatIso(checkedAt)
      })
    }
    if (result.failure._tag === "CodeCommitReviewConflictError") {
      return yield* output("preflight", PluginActionPreflightV1, {
        _tag: "blocked",
        reasons: [`CodeCommit action blocked: ${result.failure.reason}`],
        checkedAt: DateTime.formatIso(checkedAt)
      })
    }
    return yield* failReview("preflight", result.failure, null)
  })

  const dispatchAuthorizedAction = Effect.fn("CodeCommitPlugin.dispatchAuthorizedAction")(function*(
    request: AuthorizedPluginActionV1
  ) {
    const action = yield* decodeAuthorizedAction(account, configuration.repositoryName, request)
    const reconciliationKey = locatorForAction(action)
    const result = yield* reviewClient.execute(action).pipe(Effect.result)
    const observedAt = yield* now
    if (Result.isFailure(result)) {
      if (!isConfirmedReviewRejection(result.failure)) {
        return yield* failReview("execute-authorized-action", result.failure, reconciliationKey)
      }
      return {
        _tag: "confirmed",
        receipt: {
          status: "failed",
          providerOperationId: PluginProviderOperationId.make(
            `rejected:${action._tag}:${action.target.pullRequestId}:${action.target.revisionId}`
          ),
          safeSummary: "CodeCommit rejected the authorized review action without applying it",
          observedAt
        }
      } satisfies PluginActionDispatchResultV1
    }
    return {
      _tag: "confirmed",
      receipt: {
        status: "succeeded",
        providerOperationId: PluginProviderOperationId.make(result.success.operationId),
        safeSummary: result.success.summary,
        observedAt
      }
    } satisfies PluginActionDispatchResultV1
  })

  const executeAuthorizedAction = Effect.fn("CodeCommitPlugin.executeAuthorizedAction")(function*(
    request: AuthorizedPluginActionV1
  ) {
    yield* verifyRuntimeIdentity()
    const result = yield* SynchronizedRef.modifyEffect(dispatches, (current) => {
      const previous = HashMap.get(current, request.idempotencyKey)
      if (Option.isSome(previous)) {
        const replay = previous.value.payloadDigest === request.payloadDigest
          ? previous.value.result
          : Result.fail(
            new PluginConflictFailure({
              operation: "execute-authorized-action",
              diagnosticCode: "codecommit-idempotency-payload-mismatch"
            })
          )
        const transition: readonly [typeof replay, typeof current] = [replay, current]
        return Effect.succeed(transition)
      }
      return dispatchAuthorizedAction(request).pipe(
        Effect.result,
        Effect.map((dispatched) => {
          const cache = Result.isSuccess(dispatched) ||
              Predicate.isTagged(dispatched.failure, "PluginUnknownOutcomeFailure")
            ? HashMap.set(current, request.idempotencyKey, {
              payloadDigest: request.payloadDigest,
              result: dispatched
            })
            : current
          const transition: readonly [typeof dispatched, typeof current] = [dispatched, cache]
          return transition
        })
      )
    })
    return Result.isSuccess(result) ? result.success : yield* result.failure
  })

  const reconcile = Effect.fn("CodeCommitPlugin.reconcile")(function*(
    request: PluginActionReconciliationRequestV1
  ) {
    yield* verifyRuntimeIdentity()
    const action = request.reconciliationKey === null
      ? yield* decodeAuthorizedAction(account, configuration.repositoryName, request.authorizedAction)
      : actionFromLocator(
        account,
        configuration.repositoryName,
        yield* decodeReconciliationLocator(request.reconciliationKey)
      )
    const result = yield* reviewClient.reconcile(action).pipe(
      Effect.catch((error) => failReview("reconcile", error, null))
    )
    const checkedAt = yield* now
    switch (result._tag) {
      case "pending":
        return { _tag: "pending", checkedAt } satisfies PluginActionReconciliationResultV1
      case "succeeded":
        return {
          _tag: "succeeded",
          receipt: {
            status: "succeeded",
            providerOperationId: PluginProviderOperationId.make(result.receipt.operationId),
            safeSummary: result.receipt.summary,
            observedAt: checkedAt
          }
        } satisfies PluginActionReconciliationResultV1
      case "failed":
        return {
          _tag: "failed",
          receipt: {
            status: "failed",
            providerOperationId: PluginProviderOperationId.make(
              `reconciliation:${action.target.pullRequestId}:${action.target.revisionId}`
            ),
            safeSummary: result.summary,
            observedAt: checkedAt
          }
        } satisfies PluginActionReconciliationResultV1
    }
  })

  const executor: AuthorizedPluginExecutorV1 = {
    preflight,
    executeAuthorizedAction,
    requestCancellation: () => Effect.fail(unsupported("action.cancel")),
    reconcile
  }

  return { connection, executor }
})

/** Internal requirement-preserving definition used by the runtime registry and adapter tests. @internal */
export const codeCommitPluginDefinition = definePluginV1({
  rawDescriptor: descriptor,
  configurationSchema: CodeCommitPluginConfiguration,
  capabilityCodecs: {
    entityRead: pluginCapabilityCodecsV1.entityRead,
    syncIncremental: pluginCapabilityCodecsV1.syncIncremental,
    actionPropose: pluginCapabilityCodecsV1.actionPropose,
    actionExecute: pluginCapabilityCodecsV1.actionExecute,
    actionReconcile: pluginCapabilityCodecsV1.actionReconcile,
    diffInventory: pluginCapabilityCodecsV1.diffInventory
  },
  make: ({ configuration, descriptor: negotiatedDescriptor }) => makeConnection(configuration, negotiatedDescriptor)
})

/** Opaque production CodeCommit plugin definition for first-party registration. */
export const CodeCommitPluginDefinition: PluginDefinitionV1 = codeCommitPluginDefinition
