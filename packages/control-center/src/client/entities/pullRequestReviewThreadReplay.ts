/** Bounded browser replay for a durable pull-request review thread. @module */
import * as Effect from "effect/Effect"
import * as Equal from "effect/Equal"
import * as Predicate from "effect/Predicate"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { ReleaseAgentThreadCursor } from "../../api/agent.js"
import type {
  AgentProviderCatalog,
  PullRequestReviewState,
  PullRequestReviewThreadEvent,
  PullRequestReviewThreadPage
} from "../../api/agent.js"
import { makeControlCenterApiClient } from "../../api/client.js"
import type { EntityId } from "../../domain/identifiers.js"
import { makeAuthenticatedMutationClient } from "../authenticatedMutationClient.js"
import type {
  PullRequestReviewControllerState,
  PullRequestReviewScope,
  PullRequestReviewTransport
} from "./usePullRequestReview.js"

export const MAXIMUM_REVIEW_THREAD_PAGE_READS = 128
export const MAXIMUM_RETAINED_REVIEW_THREAD_EVENTS = 256

interface PullRequestReviewThreadPageTransport {
  readonly loadThread: (
    entityId: EntityId,
    cursor: ReleaseAgentThreadCursor | null,
    signal: AbortSignal,
    direction?: "after" | "before"
  ) => Promise<PullRequestReviewThreadPage>
}

export interface PullRequestReviewThread {
  readonly events: ReadonlyArray<PullRequestReviewThreadEvent>
  readonly hasEarlier: boolean
  readonly historyLoaded: boolean
  readonly nextCursor: ReleaseAgentThreadCursor
  /** Monotonic window identity used to reject reads started before a tail replacement. */
  readonly replayGeneration?: number
  /** Transient signal that a bounded tail must replace, rather than append to, an older window. */
  readonly replacesRetainedWindow?: true
}

interface PullRequestReviewThreadRef {
  current: PullRequestReviewThread | null
}

const earliestSequence = (thread: PullRequestReviewThread): number =>
  thread.events[0]?.eventSequence ?? Number.MAX_SAFE_INTEGER

/** Merge concurrent live and backward reads without dropping either cursor direction. */
export const mergePullRequestReviewThreads = (
  left: PullRequestReviewThread,
  right: PullRequestReviewThread
): PullRequestReviewThread => {
  const eventsBySequence = new Map<number, PullRequestReviewThreadEvent>()
  for (const event of [...left.events, ...right.events]) {
    const existing = eventsBySequence.get(event.eventSequence)
    if (existing !== undefined && !Equal.equals(existing, event)) {
      throw new Error("Pull-request review thread contained conflicting duplicate events")
    }
    eventsBySequence.set(event.eventSequence, event)
  }
  const allEvents = [...eventsBySequence.values()].sort(
    (left, right) => left.eventSequence - right.eventSequence
  )
  const leftEarliestSequence = earliestSequence(left)
  const rightEarliestSequence = earliestSequence(right)
  const boundary = leftEarliestSequence < rightEarliestSequence
    ? left
    : rightEarliestSequence < leftEarliestSequence
    ? right
    : left.historyLoaded
    ? left
    : right
  const historyLoaded = boundary.historyLoaded
  const events = historyLoaded
    ? allEvents
    : allEvents.slice(-MAXIMUM_RETAINED_REVIEW_THREAD_EVENTS)
  const hasEarlierAtBoundary = leftEarliestSequence !== rightEarliestSequence
    ? boundary.hasEarlier
    : left.historyLoaded && right.historyLoaded
    ? left.hasEarlier && right.hasEarlier
    : left.historyLoaded
    ? left.hasEarlier
    : right.historyLoaded
    ? right.hasEarlier
    : left.hasEarlier || right.hasEarlier
  return {
    events,
    hasEarlier: hasEarlierAtBoundary || events.length < allEvents.length,
    historyLoaded,
    nextCursor: ReleaseAgentThreadCursor.make(
      Math.max(left.nextCursor, right.nextCursor)
    ),
    replayGeneration: Math.max(left.replayGeneration ?? 0, right.replayGeneration ?? 0)
  }
}

export const installNewestThread = (
  target: PullRequestReviewThreadRef,
  candidate: PullRequestReviewThread,
  signal: AbortSignal
): PullRequestReviewThread => {
  if (!signal.aborted) {
    const retainedGeneration = target.current?.replayGeneration ?? 0
    const candidateGeneration = candidate.replayGeneration ?? retainedGeneration
    if (candidateGeneration < retainedGeneration) return target.current ?? candidate
    const { replacesRetainedWindow: _replacesRetainedWindow, ...retainedCandidate } = candidate
    const versionedCandidate = { ...retainedCandidate, replayGeneration: candidateGeneration }
    if (
      candidate.replacesRetainedWindow === true &&
      candidateGeneration === retainedGeneration &&
      target.current !== null &&
      candidate.nextCursor < target.current.nextCursor
    ) return target.current
    const overlapsRetainedWindow = target.current !== null &&
      candidate.replacesRetainedWindow === true &&
      candidate.events.some((candidateEvent) =>
        target.current?.events.some(
          (retainedEvent) => retainedEvent.eventSequence === candidateEvent.eventSequence
        )
      )
    target.current = target.current === null ||
        candidateGeneration > retainedGeneration ||
        (
          candidate.replacesRetainedWindow === true &&
          candidate.nextCursor > target.current.nextCursor &&
          !overlapsRetainedWindow
        )
      ? versionedCandidate
      : mergePullRequestReviewThreads(target.current, retainedCandidate)
  }
  return target.current ?? candidate
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
  loadThread: (entityId, cursor, signal, direction = "after") =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeControlCenterApiClient()
        return yield* client.agent.pullRequestReviewThread({
          params: { entityId },
          query: cursor === null
            ? {}
            : direction === "before"
            ? { before: cursor }
            : { after: cursor }
        })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    ),
  previewPublication: (entityId, selection, signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeControlCenterApiClient()
        return yield* client.agent.previewReviewSuggestionPublication({
          params: {
            entityId,
            jobId: selection.jobId,
            suggestionId: selection.suggestionId
          },
          query: { revisionId: selection.revisionId }
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
  signal: AbortSignal,
  initialCursor: ReleaseAgentThreadCursor | null = null
): Promise<PullRequestReviewThread> => {
  const events = new Array<PullRequestReviewThreadEvent>()
  let after = initialCursor
  for (let pageRead = 0; pageRead < MAXIMUM_REVIEW_THREAD_PAGE_READS; pageRead++) {
    const page = await transport.loadThread(entityId, after, signal)
    for (const event of page.events) events.push(event)
    if (!page.hasMore) {
      return {
        events,
        hasEarlier: page.hasEarlier,
        historyLoaded: false,
        nextCursor: page.nextCursor
      }
    }
    if (after !== null && page.nextCursor <= after) {
      throw new Error("Pull-request review thread cursor did not advance")
    }
    after = page.nextCursor
  }
  const tail = await transport.loadThread(entityId, null, signal)
  if (tail.hasMore || (after !== null && tail.nextCursor <= after)) {
    throw new Error("Pull-request review thread tail fallback was not usable")
  }
  return {
    events: [...tail.events],
    hasEarlier: true,
    historyLoaded: false,
    nextCursor: tail.nextCursor,
    replacesRetainedWindow: true
  }
}

/** Continue one previously loaded thread without replaying its durable prefix. */
export const continuePullRequestReviewThread = async (
  transport: PullRequestReviewThreadPageTransport,
  entityId: EntityId,
  signal: AbortSignal,
  previous?: PullRequestReviewThread
): Promise<PullRequestReviewThread> => {
  const update = await loadCompletePullRequestReviewThread(
    transport,
    entityId,
    signal,
    previous?.nextCursor
  )
  if (update.replacesRetainedWindow === true) {
    return {
      ...update,
      replayGeneration: (previous?.replayGeneration ?? 0) + 1
    }
  }
  const events = previous === undefined
    ? update.events
    : [...previous.events, ...update.events]
  const historyLoaded = previous?.historyLoaded ?? false
  const retainedEvents = historyLoaded
    ? events
    : events.slice(-MAXIMUM_RETAINED_REVIEW_THREAD_EVENTS)
  return {
    events: retainedEvents,
    hasEarlier: (previous?.hasEarlier ?? false) ||
      update.hasEarlier ||
      retainedEvents.length < events.length,
    historyLoaded,
    nextCursor: update.nextCursor,
    replayGeneration: previous?.replayGeneration ?? update.replayGeneration ?? 0,
    ...(previous?.replacesRetainedWindow === true ? { replacesRetainedWindow: true } : {})
  }
}

/** Prepend one explicit bounded history page without disturbing live replay. */
export const loadEarlierPullRequestReviewThread = async (
  transport: PullRequestReviewThreadPageTransport,
  entityId: EntityId,
  signal: AbortSignal,
  previous: PullRequestReviewThread
): Promise<PullRequestReviewThread> => {
  const before = previous.events[0]?.eventSequence
  if (!previous.hasEarlier || before === undefined) return previous
  const page = await transport.loadThread(entityId, before, signal, "before")
  const invalidEvent = page.events.some(
    (event, index, events) =>
      event.eventSequence >= before ||
      (index > 0 && event.eventSequence <= events[index - 1]!.eventSequence)
  )
  if (
    invalidEvent ||
    (page.events.length > 0 && page.nextCursor >= before) ||
    (page.hasMore && page.events.length === 0)
  ) {
    throw new Error("Pull-request review history cursor did not retreat")
  }
  return {
    events: [...page.events, ...previous.events],
    hasEarlier: page.hasMore,
    historyLoaded: true,
    nextCursor: previous.nextCursor,
    replayGeneration: previous.replayGeneration ?? 0
  }
}

type ReadyPullRequestReviewState = Extract<
  PullRequestReviewControllerState,
  { readonly _tag: "ready" }
>

const sameReviewScope = (
  left: PullRequestReviewScope,
  right: PullRequestReviewScope
): boolean =>
  left.baseRevision === right.baseRevision &&
  left.entityId === right.entityId &&
  left.headRevision === right.headRevision &&
  left.sessionKey === right.sessionKey

/** Apply one dynamic history read without growing the default entity-route chunk. */
export const loadEarlierPullRequestReviewThreadIntoState = (
  transport: PullRequestReviewThreadPageTransport,
  current: ReadyPullRequestReviewState,
  currentThread: PullRequestReviewThread,
  signal: AbortSignal,
  latestScope: { current: PullRequestReviewScope | null },
  latestThread: PullRequestReviewThreadRef,
  onSessionExpired: (sessionKey: string) => void,
  setState: (
    update: (state: PullRequestReviewControllerState) => PullRequestReviewControllerState
  ) => void
): Promise<void> => {
  const run = async (): Promise<void> => {
    try {
      const thread = await loadEarlierPullRequestReviewThread(
        transport,
        current.entityId,
        signal,
        currentThread
      )
      if (
        signal.aborted ||
        latestScope.current === null ||
        !sameReviewScope(latestScope.current, current)
      ) return
      const installed = installNewestThread(latestThread, thread, signal)
      setState((latest) =>
        latest._tag === "ready" && sameReviewScope(latest, current)
          ? { ...latest, historyAction: "idle", thread: installed }
          : latest
      )
    } catch (failure) {
      if (
        signal.aborted ||
        latestScope.current === null ||
        !sameReviewScope(latestScope.current, current)
      ) return
      if (Predicate.isTagged("UnauthorizedApiError")(failure)) {
        onSessionExpired(current.sessionKey)
      }
      Effect.runFork(Effect.logError("Pull-request review history load failed", failure))
      setState((latest) =>
        latest._tag === "ready" && sameReviewScope(latest, current)
          ? { ...latest, historyAction: "failed" }
          : latest
      )
    }
  }
  return run()
}

/** Load one coherent review snapshot and close a pending-to-terminal tail race. */
export const loadPullRequestReviewSnapshot = async (
  transport: PullRequestReviewTransport,
  entityId: EntityId,
  canEnqueue: boolean,
  signal: AbortSignal,
  previous: PullRequestReviewThread | undefined,
  target: PullRequestReviewThreadRef
): Promise<{
  readonly catalog: AgentProviderCatalog
  readonly review: PullRequestReviewState
  readonly thread: PullRequestReviewThread
}> => {
  const catalogPromise = canEnqueue
    ? transport.providers(signal).catch((failure: unknown) => {
      if (signal.aborted) throw failure
      Effect.runFork(Effect.logWarning("Pull-request review provider catalog load failed", failure))
      return { providers: [] } satisfies AgentProviderCatalog
    })
    : Promise.resolve({ providers: [] } satisfies AgentProviderCatalog)
  const [review, initialThread, catalog] = await Promise.all([
    transport.load(entityId, signal),
    continuePullRequestReviewThread(transport, entityId, signal, previous),
    catalogPromise
  ])
  const thread = review._tag === "completed" || review._tag === "failed"
    ? await continuePullRequestReviewThread(transport, entityId, signal, initialThread)
    : initialThread
  return { catalog, review, thread: installNewestThread(target, thread, signal) }
}

/** Continue a visible thread while retaining diagnostics for non-fatal refresh failures. */
export const refreshPullRequestReviewThread = async (
  transport: PullRequestReviewThreadPageTransport,
  entityId: EntityId,
  signal: AbortSignal,
  previous: PullRequestReviewThread | undefined,
  target: PullRequestReviewThreadRef
): Promise<PullRequestReviewThread> => {
  try {
    const thread = await continuePullRequestReviewThread(transport, entityId, signal, previous)
    return installNewestThread(target, thread, signal)
  } catch (failure) {
    if (!signal.aborted) {
      Effect.runFork(Effect.logError("Pull-request review thread refresh failed", failure))
    }
    throw failure
  }
}
