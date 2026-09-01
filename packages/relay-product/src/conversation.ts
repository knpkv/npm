import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

import { RelaySelectorState } from "./model.js"

const trimmedIdentifier = (maximumLength: number) =>
  Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(maximumLength))

const canonicalUuid = <const Brand extends string>(brand: Brand) =>
  Schema.String.check(
    Schema.isUUID(7),
    Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u, {
      expected: "a canonical lowercase UUID v7"
    })
  ).pipe(Schema.brand(brand))

export const AgenticProduct = Schema.Literals(["codecommit", "control-center"])
export type AgenticProduct = typeof AgenticProduct.Type

export const RelayProductOperation = Schema.Literals([
  "continue-pull-request-conversation",
  "locate-pull-request-conversation"
])
export type RelayProductOperation = typeof RelayProductOperation.Type

const PrincipalId = trimmedIdentifier(200).pipe(Schema.brand("RelayPrincipalId"))
const WorkspaceId = canonicalUuid("RelayWorkspaceId")
const PluginConnectionId = canonicalUuid("RelayPluginConnectionId")
const EntityId = canonicalUuid("RelayEntityId")
const RepositoryName = trimmedIdentifier(1_000).pipe(Schema.brand("RelayRepositoryName"))
const PullRequestId = trimmedIdentifier(200).pipe(Schema.brand("RelayPullRequestId"))
const AccountId = trimmedIdentifier(200).pipe(Schema.brand("RelayAccountId"))
const Region = trimmedIdentifier(100).pipe(Schema.brand("RelayRegion"))
const ProductPath = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(4_096),
  Schema.isPattern(/^\/(?!\/)/u, { expected: "an application-owned absolute path" })
)

export const ProductAuthorization = Schema.TaggedUnion({
  codecommit: {
    principalId: PrincipalId
  },
  "control-center": {
    principalId: PrincipalId,
    workspaceId: WorkspaceId
  }
})
export type ProductAuthorization = typeof ProductAuthorization.Type

/** Provider identity a host agent may use to find one PR conversation. */
export const PullRequestConversationLocator = Schema.Struct({
  accountId: Schema.optionalKey(AccountId),
  provider: Schema.Literal("codecommit"),
  pullRequestId: PullRequestId,
  region: Region,
  repositoryName: RepositoryName
})
export interface PullRequestConversationLocator extends Schema.Schema.Type<typeof PullRequestConversationLocator> {}

const ControlCenterThreadIdentity = Schema.Struct({
  pluginConnectionId: PluginConnectionId,
  pullRequestId: PullRequestId,
  repositoryName: RepositoryName,
  workspaceId: WorkspaceId
})

const CodeCommitThreadIdentity = Schema.Struct({
  accountId: AccountId,
  pullRequestId: PullRequestId,
  region: Region,
  repositoryName: RepositoryName
})

const ControlCenterPullRequestRoute = Schema.Struct({
  entityId: EntityId,
  href: ProductPath
})

const CodeCommitPullRequestRoute = Schema.Struct({
  accountId: AccountId,
  href: ProductPath,
  /** Credential/account alias used by the browser URL; accountId stays canonical. */
  pullRequestId: PullRequestId,
  routeAccountId: Schema.optionalKey(AccountId)
})

/** Stable product-qualified identity. Head revisions never participate in thread identity. */
export const PullRequestThreadIdentity = Schema.TaggedUnion({
  codecommit: {
    ...CodeCommitThreadIdentity.fields
  },
  "control-center": {
    ...ControlCenterThreadIdentity.fields
  }
})
export type PullRequestThreadIdentity = typeof PullRequestThreadIdentity.Type

/** Durable thread identity, exact product route, and explicit Relay selection for one PR. */
export const PullRequestConversation = Schema.TaggedUnion({
  codecommit: {
    route: CodeCommitPullRequestRoute,
    selection: RelaySelectorState,
    thread: CodeCommitThreadIdentity
  },
  "control-center": {
    route: ControlCenterPullRequestRoute,
    selection: RelaySelectorState,
    thread: ControlCenterThreadIdentity
  }
}).check(
  Schema.makeFilter(
    (conversation) => {
      switch (conversation._tag) {
        case "codecommit":
          return (
            conversation.route.accountId === conversation.thread.accountId &&
            conversation.route.pullRequestId === conversation.thread.pullRequestId &&
            conversation.route.href ===
              `/accounts/${encodeURIComponent(conversation.route.routeAccountId ?? conversation.route.accountId)}/prs/${
                encodeURIComponent(conversation.route.pullRequestId)
              }`
          )
        case "control-center":
          return (
            conversation.route.href ===
              `/w/${conversation.thread.workspaceId}/items/${conversation.route.entityId}`
          )
      }
    },
    { expected: "a product-qualified thread paired with its exact pull-request route" }
  )
)
export type PullRequestConversation = typeof PullRequestConversation.Type

export const pullRequestThreadIdentity = (
  conversation: PullRequestConversation
): PullRequestThreadIdentity => {
  switch (conversation._tag) {
    case "codecommit":
      return PullRequestThreadIdentity.cases.codecommit.make(conversation.thread)
    case "control-center":
      return PullRequestThreadIdentity.cases["control-center"].make(conversation.thread)
  }
}

export const PullRequestContinuationMessage = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(8_000)
).pipe(Schema.brand("PullRequestContinuationMessage"))
export type PullRequestContinuationMessage = typeof PullRequestContinuationMessage.Type

export const ContinuePullRequestConversationRequest = Schema.Struct({
  conversation: PullRequestConversation,
  message: PullRequestContinuationMessage,
  selection: RelaySelectorState
})
export interface ContinuePullRequestConversationRequest
  extends Schema.Schema.Type<typeof ContinuePullRequestConversationRequest>
{}

const ContinuationMessageId = trimmedIdentifier(200).pipe(Schema.brand("RelayContinuationMessageId"))

export const PullRequestConversationContinuation = Schema.Struct({
  messageId: ContinuationMessageId,
  thread: PullRequestThreadIdentity
})
export interface PullRequestConversationContinuation
  extends Schema.Schema.Type<typeof PullRequestConversationContinuation>
{}

export class RelayAuthenticationRequired extends Schema.TaggedError<RelayAuthenticationRequired>()(
  "RelayAuthenticationRequired",
  {
    operation: RelayProductOperation,
    product: AgenticProduct
  }
) {}

export class RelayAuthorizationDenied extends Schema.TaggedError<RelayAuthorizationDenied>()(
  "RelayAuthorizationDenied",
  {
    operation: RelayProductOperation,
    product: AgenticProduct
  }
) {}

export class RelayAuthenticationUnavailable extends Schema.TaggedError<RelayAuthenticationUnavailable>()(
  "RelayAuthenticationUnavailable",
  {
    operation: RelayProductOperation,
    product: AgenticProduct
  }
) {}

export class PullRequestConversationNotFound extends Schema.TaggedError<PullRequestConversationNotFound>()(
  "PullRequestConversationNotFound",
  {
    product: AgenticProduct,
    pullRequestId: PullRequestId,
    repositoryName: RepositoryName
  }
) {}

export class PullRequestConversationAmbiguous extends Schema.TaggedError<PullRequestConversationAmbiguous>()(
  "PullRequestConversationAmbiguous",
  {
    matches: Schema.Int.check(Schema.isGreaterThan(1)),
    product: AgenticProduct,
    pullRequestId: PullRequestId,
    repositoryName: RepositoryName
  }
) {}

export class PullRequestConversationLookupFailed extends Schema.TaggedError<PullRequestConversationLookupFailed>()(
  "PullRequestConversationLookupFailed",
  {
    product: AgenticProduct
  }
) {}

export class PullRequestConversationRedirectFailed extends Schema.TaggedError<PullRequestConversationRedirectFailed>()(
  "PullRequestConversationRedirectFailed",
  {
    href: ProductPath,
    product: AgenticProduct
  }
) {}

export class PullRequestConversationContinuationRejected
  extends Schema.TaggedError<PullRequestConversationContinuationRejected>()(
    "PullRequestConversationContinuationRejected",
    {
      product: AgenticProduct,
      reason: Schema.Literals(["conversation-busy", "selection-unavailable", "thread-not-found"]),
      thread: PullRequestThreadIdentity
    }
  )
{}

export class PullRequestConversationContinuationFailed
  extends Schema.TaggedError<PullRequestConversationContinuationFailed>()(
    "PullRequestConversationContinuationFailed",
    {
      product: AgenticProduct,
      thread: PullRequestThreadIdentity
    }
  )
{}

export class RelayProductAdapterContractError extends Schema.TaggedError<RelayProductAdapterContractError>()(
  "RelayProductAdapterContractError",
  {
    actualProduct: AgenticProduct,
    expectedProduct: AgenticProduct,
    operation: RelayProductOperation
  }
) {}

export class RelayProductContinuationReceiptMismatch
  extends Schema.TaggedError<RelayProductContinuationReceiptMismatch>()(
    "RelayProductContinuationReceiptMismatch",
    {
      actualThread: PullRequestThreadIdentity,
      expectedThread: PullRequestThreadIdentity
    }
  )
{}

export type RelayAuthenticationFailure =
  | RelayAuthenticationRequired
  | RelayAuthorizationDenied
  | RelayAuthenticationUnavailable

export type PullRequestConversationLookupFailure =
  | PullRequestConversationNotFound
  | PullRequestConversationAmbiguous
  | PullRequestConversationLookupFailed

export type PullRequestConversationContinuationFailure =
  | PullRequestConversationContinuationRejected
  | PullRequestConversationContinuationFailed

/** Product-owned authority, backend, and router operations. No raw HTTP enters the shared module. */
export interface RelayProductPort {
  readonly authorize: (
    operation: RelayProductOperation
  ) => Effect.Effect<ProductAuthorization, RelayAuthenticationFailure>
  readonly continuePullRequestConversation: (
    authorization: ProductAuthorization,
    request: ContinuePullRequestConversationRequest
  ) => Effect.Effect<PullRequestConversationContinuation, PullRequestConversationContinuationFailure>
  readonly locatePullRequestConversation: (
    authorization: ProductAuthorization,
    locator: PullRequestConversationLocator
  ) => Effect.Effect<PullRequestConversation, PullRequestConversationLookupFailure>
  readonly product: AgenticProduct
  readonly redirectToPullRequest: (
    conversation: PullRequestConversation
  ) => Effect.Effect<void, PullRequestConversationRedirectFailed>
}

export interface RelayProductAdapter {
  readonly continuePullRequestConversation: (
    request: ContinuePullRequestConversationRequest
  ) => Effect.Effect<
    PullRequestConversationContinuation,
    | RelayAuthenticationFailure
    | PullRequestConversationContinuationFailure
    | RelayProductAdapterContractError
    | RelayProductContinuationReceiptMismatch
  >
  readonly openPullRequestConversation: (
    locator: PullRequestConversationLocator
  ) => Effect.Effect<
    PullRequestConversation,
    | RelayAuthenticationFailure
    | PullRequestConversationLookupFailure
    | PullRequestConversationRedirectFailed
    | RelayProductAdapterContractError
  >
}

export class RelayProduct extends Context.Service<RelayProduct, RelayProductAdapter>()(
  "@knpkv/relay-product/RelayProduct"
) {}

const requireProduct = (
  expectedProduct: AgenticProduct,
  actualProduct: AgenticProduct,
  operation: RelayProductOperation
): Effect.Effect<void, RelayProductAdapterContractError> =>
  expectedProduct === actualProduct
    ? Effect.void
    : new RelayProductAdapterContractError({ actualProduct, expectedProduct, operation })

const samePullRequestThread = (
  left: PullRequestThreadIdentity,
  right: PullRequestThreadIdentity
): boolean => {
  if (left._tag !== right._tag) return false
  switch (left._tag) {
    case "codecommit":
      return (
        right._tag === "codecommit" &&
        left.accountId === right.accountId &&
        left.pullRequestId === right.pullRequestId &&
        left.region === right.region &&
        left.repositoryName === right.repositoryName
      )
    case "control-center":
      return (
        right._tag === "control-center" &&
        left.pluginConnectionId === right.pluginConnectionId &&
        left.pullRequestId === right.pullRequestId &&
        left.repositoryName === right.repositoryName &&
        left.workspaceId === right.workspaceId
      )
  }
}

/** One orchestration path shared by Control Center and CodeCommit product ports. */
export const makeRelayProductAdapter = (port: RelayProductPort): RelayProductAdapter => {
  const openPullRequestConversation = Effect.fn("RelayProduct.openPullRequestConversation")(function*(
    locator: PullRequestConversationLocator
  ) {
    const operation: RelayProductOperation = "locate-pull-request-conversation"
    const authorization = yield* port.authorize(operation)
    yield* requireProduct(port.product, authorization._tag, operation)
    const conversation = yield* port.locatePullRequestConversation(authorization, locator)
    yield* requireProduct(port.product, conversation._tag, operation)
    yield* port.redirectToPullRequest(conversation)
    return conversation
  })

  const continuePullRequestConversation = Effect.fn("RelayProduct.continuePullRequestConversation")(function*(
    request: ContinuePullRequestConversationRequest
  ) {
    const operation: RelayProductOperation = "continue-pull-request-conversation"
    const authorization = yield* port.authorize(operation)
    yield* requireProduct(port.product, authorization._tag, operation)
    yield* requireProduct(port.product, request.conversation._tag, operation)
    const receipt = yield* port.continuePullRequestConversation(authorization, request)
    const expectedThread = pullRequestThreadIdentity(request.conversation)
    if (!samePullRequestThread(expectedThread, receipt.thread)) {
      return yield* new RelayProductContinuationReceiptMismatch({
        actualThread: receipt.thread,
        expectedThread
      })
    }
    return receipt
  })

  return RelayProduct.of({ continuePullRequestConversation, openPullRequestConversation })
}

export const layer = (port: RelayProductPort): Layer.Layer<RelayProduct> =>
  Layer.succeed(RelayProduct, makeRelayProductAdapter(port))
