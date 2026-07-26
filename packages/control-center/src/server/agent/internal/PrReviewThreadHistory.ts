/** Fenced, cursor-paged durable history tools for one immutable PR-review run. @module */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Tool from "effect/unstable/ai/Tool"
import * as Toolkit from "effect/unstable/ai/Toolkit"

import {
  AgentEventCursor,
  AgentThreadEvent,
  AgentThreadEventPageSize,
  type ClaimedAgentJob
} from "../../persistence/repositories/agentJobModels.js"
import { AgentJobRepository } from "../../persistence/repositories/agentJobRepository.js"

const ReviewThreadHistoryEvent = Schema.Struct({
  eventSequence: AgentEventCursor,
  jobId: AgentThreadEvent.fields.jobId,
  attemptSequence: AgentThreadEvent.fields.attemptSequence,
  eventKind: AgentThreadEvent.fields.eventKind,
  payload: Schema.Json,
  occurredAt: AgentThreadEvent.fields.occurredAt
})

const ReviewThreadHistoryPage = Schema.Struct({
  event: Schema.NullOr(ReviewThreadHistoryEvent),
  hasMore: Schema.Boolean,
  nextCursor: AgentEventCursor
})

/** Stable model-visible failure without persistence or host details. */
export class PrReviewThreadHistoryError extends Schema.TaggedErrorClass<PrReviewThreadHistoryError>()(
  "PrReviewThreadHistoryError",
  {
    reason: Schema.Literal("history-unavailable")
  }
) {}

const unavailable = (): PrReviewThreadHistoryError => new PrReviewThreadHistoryError({ reason: "history-unavailable" })

interface PrReviewThreadHistoryPageInput {
  readonly after: typeof AgentEventCursor.Type
  readonly claim: ClaimedAgentJob
}

/** Read-only application seam that fences history before the active run. */
export class PrReviewThreadHistory extends Context.Service<
  PrReviewThreadHistory,
  {
    readonly page: (
      input: PrReviewThreadHistoryPageInput
    ) => Effect.Effect<typeof ReviewThreadHistoryPage.Type, PrReviewThreadHistoryError>
  }
>()("@knpkv/control-center/server/agent/internal/PrReviewThreadHistory") {}

const presentHistoryEvent = Effect.fn("PrReviewThreadHistory.presentHistoryEvent")(function*(
  event: AgentThreadEvent
) {
  const payload = yield* Schema.decodeUnknownEffect(Schema.Json)(event.payload).pipe(
    Effect.mapError(unavailable)
  )
  return {
    eventSequence: event.eventSequence,
    jobId: event.jobId,
    attemptSequence: event.attemptSequence,
    eventKind: event.eventKind,
    payload,
    occurredAt: event.occurredAt
  }
})

/** Persisted history implementation; one model call receives at most one complete event. */
export const prReviewThreadHistoryLayer: Layer.Layer<
  PrReviewThreadHistory,
  never,
  AgentJobRepository
> = Layer.effect(
  PrReviewThreadHistory,
  Effect.gen(function*() {
    const jobs = yield* AgentJobRepository
    return PrReviewThreadHistory.of({
      page: Effect.fn("PrReviewThreadHistory.page")(function*({ after, claim }) {
        const page = yield* jobs.reviewThreadHistory({
          workspaceId: claim.workspaceId,
          threadId: claim.threadId,
          beforeJobId: claim.jobId,
          after,
          limit: AgentThreadEventPageSize.make(2)
        }).pipe(Effect.mapError(unavailable))
        const event = page.events[0]
        const presented = event === undefined
          ? null
          : yield* presentHistoryEvent(event)
        return yield* Schema.decodeUnknownEffect(
          Schema.toType(ReviewThreadHistoryPage)
        )({
          event: presented,
          hasMore: page.events.length > 1,
          nextCursor: event?.eventSequence ?? after
        }).pipe(Effect.mapError(unavailable))
      })
    })
  })
)

/** Read the next prior durable event; start at cursor zero and follow `nextCursor`. */
export const ReviewReadThreadHistory = Tool.make("ReviewReadThreadHistory", {
  description: "Read one complete prior event from this pull request's durable Review Thread. " +
    "Start with after 0 and repeat with nextCursor while hasMore is true.",
  failure: PrReviewThreadHistoryError,
  parameters: Schema.Struct({ after: AgentEventCursor }),
  success: ReviewThreadHistoryPage
})

/** Provider-neutral durable-history toolkit merged with the Review Sandbox tools. */
export const PrReviewThreadTools = Toolkit.make(ReviewReadThreadHistory)

/** Bind durable history to the current immutable run and its pre-run fence. */
export const prReviewThreadToolsLayer = (
  history: PrReviewThreadHistory["Service"],
  claim: ClaimedAgentJob
): Layer.Layer<Tool.HandlersFor<typeof PrReviewThreadTools.tools>> =>
  PrReviewThreadTools.toLayer({
    ReviewReadThreadHistory: ({ after }) => history.page({ after, claim })
  })
