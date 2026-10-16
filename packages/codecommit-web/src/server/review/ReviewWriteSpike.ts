/** Private, uninstalled experiment. No route, package entry or production module may import it. @module */
import { CodeCommitReviewAction } from "@knpkv/codecommit-core/ReviewClient.js"
import { Config, Effect, Schema } from "effect"
import { RelayFindingPublisher } from "./RelayFindingPublisher.js"

export class ReviewWriteSpikeDisabled extends Schema.TaggedError<ReviewWriteSpikeDisabled>()(
  "ReviewWriteSpikeDisabled",
  {}
) {}

const Comment = CodeCommitReviewAction.cases.comment
type FindingComment = typeof Comment.Type

/**
 * Default-off post-only experiment. The config check precedes acquisition of the owner's publisher.
 * Prepared exact-head actions and their existing client tokens pass through unchanged. The publisher
 * owns permission checks, audit and provider refusal; this factory grants no authority or retries.
 */
export const makeReviewWriteSpike = Effect.fn("ReviewWriteSpike.make")(function*() {
  const enabled = yield* Config.Boolean("CODECOMMIT_REVIEW_WRITE_SPIKE_ENABLED").pipe(Config.withDefault(false))
  if (!enabled) return yield* new ReviewWriteSpikeDisabled({})
  const publisher = yield* RelayFindingPublisher
  return {
    post: Effect.fn("ReviewWriteSpike.post")(function*(action: FindingComment) {
      const checked = yield* Schema.decodeUnknownEffect(Comment)(action, { onExcessProperty: "error" })
      return yield* publisher.post(checked)
    })
  }
})
