/** Governed provider boundary for human-confirmed review-comment publication. @module */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

import type {
  AwsReviewPublicationIdentity,
  PublishedReviewComment,
  ReviewAgentProfile,
  ReviewSuggestionPublicationAuthorityBinding,
  ReviewSuggestionPublicationContent
} from "../../api/agent.js"
import type { EntityId, JobId, PluginConnectionId, WorkspaceId } from "../../domain/identifiers.js"
import type { PrReviewSubject, PrReviewSuggestion } from "../../domain/prReview.js"
import type { SessionSummary } from "../auth/models.js"

/** Closed failure returned by the governed publication adapter. */
export class ReviewSuggestionPublicationGatewayError
  extends Schema.TaggedErrorClass<ReviewSuggestionPublicationGatewayError>()(
    "ReviewSuggestionPublicationGatewayError",
    {
      reason: Schema.Literals([
        "identity-unavailable",
        "publication-conflict",
        "publication-rejected",
        "publication-unavailable"
      ])
    }
  )
{}

export interface ReviewSuggestionPublicationTarget {
  readonly workspaceId: WorkspaceId
  readonly entityId: EntityId
  readonly pluginConnectionId: PluginConnectionId
  readonly sourceRevision: string
  readonly subject: PrReviewSubject
}

/** Exact immutable material granted to the governed publisher after confirmation. */
export interface PublishReviewSuggestionCommand {
  readonly target: ReviewSuggestionPublicationTarget
  readonly jobId: JobId
  readonly suggestion: PrReviewSuggestion
  readonly finalContent: ReviewSuggestionPublicationContent
  readonly authorityBinding: ReviewSuggestionPublicationAuthorityBinding
  readonly proposingAgent: ReviewAgentProfile
  readonly session: SessionSummary
}

/** Provider result needed to construct the durable local publication snapshot. */
export interface ReviewSuggestionPublicationReceipt {
  readonly publicationId: PublishedReviewComment["publicationId"]
  readonly receipt: PublishedReviewComment["receipt"]
  readonly publishedAt: PublishedReviewComment["publishedAt"]
  readonly connectedIdentity: AwsReviewPublicationIdentity
}

export interface ReviewSuggestionPublicationAuthority {
  readonly connectedIdentity: AwsReviewPublicationIdentity
  readonly authorityBinding: ReviewSuggestionPublicationAuthorityBinding
}

/** No agent-facing service provides this authority-bearing boundary. */
export class ReviewSuggestionPublicationGateway extends Context.Service<
  ReviewSuggestionPublicationGateway,
  {
    readonly identity: (
      target: ReviewSuggestionPublicationTarget
    ) => Effect.Effect<ReviewSuggestionPublicationAuthority, ReviewSuggestionPublicationGatewayError>
    readonly publish: (
      command: PublishReviewSuggestionCommand
    ) => Effect.Effect<ReviewSuggestionPublicationReceipt, ReviewSuggestionPublicationGatewayError>
  }
>()("@knpkv/control-center/server/application/ReviewSuggestionPublicationGateway") {}

const unavailable = () => new ReviewSuggestionPublicationGatewayError({ reason: "publication-unavailable" })

/** Fail-closed adapter used when governed provider execution is not configured. */
export const reviewSuggestionPublicationGatewayUnavailableLayer = Layer.succeed(
  ReviewSuggestionPublicationGateway,
  {
    identity: () => Effect.fail(unavailable()),
    publish: () => Effect.fail(unavailable())
  }
)
