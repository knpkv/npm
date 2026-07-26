/** Bounded browser replay for a durable pull-request review thread. @module */
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import type {
  PullRequestReviewThreadEvent,
  PullRequestReviewThreadPage,
  ReleaseAgentThreadCursor
} from "../../api/agent.js"
import { ReleaseAgentThreadCursor as ReviewThreadCursor } from "../../api/agent.js"
import { makeControlCenterApiClient } from "../../api/client.js"
import type { EntityId } from "../../domain/identifiers.js"
import { makeAuthenticatedMutationClient } from "../authenticatedMutationClient.js"
import type { PullRequestReviewTransport } from "./usePullRequestReview.js"

const MAXIMUM_REVIEW_THREAD_PAGE_READS = 128

interface PullRequestReviewThreadPageTransport {
  readonly loadThread: (
    entityId: EntityId,
    after: ReleaseAgentThreadCursor,
    signal: AbortSignal
  ) => Promise<PullRequestReviewThreadPage>
}

export interface PullRequestReviewThread {
  readonly events: ReadonlyArray<PullRequestReviewThreadEvent>
  readonly nextCursor: ReleaseAgentThreadCursor
}

/** Generated-client transport kept outside the default workspace-entity chunk. */
export const generatedClientPullRequestReviewTransport: PullRequestReviewTransport = {
  enqueue: (entityId, provider, prompt, signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeAuthenticatedMutationClient
        return yield* client.agent.enqueuePullRequestReview({
          params: { entityId },
          payload: {
            providerId: provider.providerId,
            model: provider.model,
            profile: "read-only",
            reviewProfileId: provider.reviewProfile.profileId,
            ...(prompt === undefined ? {} : { prompt })
          }
        })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    ),
  load: (entityId, signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeControlCenterApiClient()
        return yield* client.agent.pullRequestReview({ params: { entityId } })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    ),
  loadThread: (entityId, after, signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeControlCenterApiClient()
        return yield* client.agent.pullRequestReviewThread({
          params: { entityId },
          query: { after }
        })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    ),
  previewPublication: (entityId, selection, signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeControlCenterApiClient()
        return yield* client.agent.previewReviewSuggestionPublication({
          params: { entityId, ...selection }
        })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    ),
  providers: (signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeControlCenterApiClient()
        return yield* client.agent.providers()
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    ),
  publishSuggestion: (entityId, selection, finalContent, authorityBinding, signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeAuthenticatedMutationClient
        return yield* client.agent.publishReviewSuggestion({
          params: { entityId },
          payload: { ...selection, finalContent, authorityBinding }
        })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    )
}

/** Follow advancing cursors to the durable tail without allowing unbounded replay. */
export const loadCompletePullRequestReviewThread = async (
  transport: PullRequestReviewThreadPageTransport,
  entityId: EntityId,
  signal: AbortSignal
): Promise<PullRequestReviewThread> => {
  const events = new Array<PullRequestReviewThreadEvent>()
  let after = ReviewThreadCursor.make(0)
  for (let pageRead = 0; pageRead < MAXIMUM_REVIEW_THREAD_PAGE_READS; pageRead++) {
    const page = await transport.loadThread(entityId, after, signal)
    for (const event of page.events) events.push(event)
    if (!page.hasMore) return { events, nextCursor: page.nextCursor }
    if (page.nextCursor <= after) {
      throw new Error("Pull-request review thread cursor did not advance")
    }
    after = page.nextCursor
  }
  throw new Error("Pull-request review thread exceeded the browser replay budget")
}
