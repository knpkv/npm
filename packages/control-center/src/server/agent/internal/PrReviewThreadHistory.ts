/** Fenced, cursor-paged durable history tools for one immutable PR-review run. @module */
import { MAXIMUM_MODEL_VISIBLE_TOOL_RESULT_BYTES } from "@knpkv/ai-runtime"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Tool from "effect/unstable/ai/Tool"
import * as Toolkit from "effect/unstable/ai/Toolkit"

import {
  AgentEventCursor,
  AgentThreadEvent,
  AgentThreadEventPageSize,
  type ClaimedAgentJob,
  MAXIMUM_AGENT_THREAD_EVENT_PAGE_SIZE
} from "../../persistence/repositories/agentJobModels.js"
import { AgentJobRepository } from "../../persistence/repositories/agentJobRepository.js"

const MAXIMUM_REVIEW_HISTORY_PAGE_BYTES = MAXIMUM_MODEL_VISIBLE_TOOL_RESULT_BYTES - 4 * 1_024
const REVIEW_HISTORY_FETCH_LIMIT = AgentThreadEventPageSize.make(
  MAXIMUM_AGENT_THREAD_EVENT_PAGE_SIZE
)

const ReviewThreadHistoryEvent = Schema.Struct({
  eventSequence: AgentEventCursor,
  jobId: AgentThreadEvent.fields.jobId,
  attemptSequence: AgentThreadEvent.fields.attemptSequence,
  eventKind: AgentThreadEvent.fields.eventKind,
  payload: Schema.Json,
  occurredAt: AgentThreadEvent.fields.occurredAt
})

const ReviewThreadHistoryPage = Schema.Struct({
  events: Schema.Array(ReviewThreadHistoryEvent).check(
    Schema.isMaxLength(MAXIMUM_AGENT_THREAD_EVENT_PAGE_SIZE)
  ),
  hasMore: Schema.Boolean,
  nextCursor: AgentEventCursor
})
const ReviewThreadHistoryPageJson = Schema.fromJsonString(ReviewThreadHistoryPage)

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

const encodedPageByteLength = Effect.fn("PrReviewThreadHistory.encodedPageByteLength")(function*(
  page: typeof ReviewThreadHistoryPage.Type
) {
  const json = yield* Schema.encodeUnknownEffect(ReviewThreadHistoryPageJson)(page).pipe(
    Effect.mapError(unavailable)
  )
  const bytes = yield* Effect.fromResult(
    Encoding.decodeBase64(Encoding.encodeBase64(json))
  ).pipe(Effect.mapError(unavailable))
  return bytes.byteLength
})

const makeBoundedPage = Effect.fn("PrReviewThreadHistory.makeBoundedPage")(function*(
  events: ReadonlyArray<AgentThreadEvent>,
  after: typeof AgentEventCursor.Type
) {
  const presented = new Array<typeof ReviewThreadHistoryEvent.Type>()
  for (const event of events) {
    const next = yield* presentHistoryEvent(event)
    const candidate = {
      events: [...presented, next],
      hasMore: true,
      nextCursor: next.eventSequence
    }
    if ((yield* encodedPageByteLength(candidate)) > MAXIMUM_REVIEW_HISTORY_PAGE_BYTES) {
      if (presented.length === 0) {
        return yield* unavailable()
      }
      break
    }
    presented.push(next)
  }
  const nextCursor = presented.at(-1)?.eventSequence ?? after
  return yield* Schema.decodeUnknownEffect(
    Schema.toType(ReviewThreadHistoryPage)
  )({
    events: presented,
    hasMore: presented.length < events.length ||
      events.length === MAXIMUM_AGENT_THREAD_EVENT_PAGE_SIZE,
    nextCursor
  }).pipe(Effect.mapError(unavailable))
})

/** Persisted history implementation; each model call receives a bounded page of complete events. */
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
          limit: REVIEW_HISTORY_FETCH_LIMIT
        }).pipe(Effect.mapError(unavailable))
        return yield* makeBoundedPage(page.events, after)
      })
    })
  })
)

/** Read the next bounded page of prior durable events; start at zero and follow `nextCursor`. */
export const ReviewReadThreadHistory = Tool.make("ReviewReadThreadHistory", {
  description: "Read a bounded page of complete prior events from this pull request's durable Review Thread. " +
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
