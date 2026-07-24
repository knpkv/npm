import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { useCallback, useEffect, useRef, useState } from "react"

import type { AgentProviderCatalog, AgentProviderCatalogEntry, PullRequestReviewState } from "../../api/agent.js"
import { makeControlCenterApiClient } from "../../api/client.js"
import type { EntityId } from "../../domain/identifiers.js"
import { makeAuthenticatedMutationClient } from "../authenticatedMutationClient.js"

const POLL_INTERVAL = Duration.seconds(2)

interface ReviewProviderSelection {
  readonly model: AgentProviderCatalogEntry["models"][number]
  readonly providerId: AgentProviderCatalogEntry["providerId"]
}

interface PullRequestReviewScope {
  readonly entityId: EntityId
  readonly sessionKey: string
  readonly subjectRevision: string
}

export type PullRequestReviewControllerState =
  | { readonly _tag: "idle" }
  | ({ readonly _tag: "loading" } & PullRequestReviewScope)
  | ({ readonly _tag: "failed" } & PullRequestReviewScope)
  | ({
    readonly _tag: "ready"
    readonly action: "idle" | "starting" | "failed"
    readonly provider: ReviewProviderSelection | null
    readonly review: PullRequestReviewState
  } & PullRequestReviewScope)

/** Browser boundary for immutable pull-request review reads and mutations. */
export interface PullRequestReviewTransport {
  readonly enqueue: (
    entityId: EntityId,
    provider: ReviewProviderSelection,
    signal: AbortSignal
  ) => Promise<PullRequestReviewState>
  readonly load: (entityId: EntityId, signal: AbortSignal) => Promise<PullRequestReviewState>
  readonly providers: (signal: AbortSignal) => Promise<AgentProviderCatalog>
}

const isUnauthorizedFailure = Predicate.isTagged("UnauthorizedApiError")

const eligibleProvider = (catalog: AgentProviderCatalog): ReviewProviderSelection | null => {
  for (const provider of catalog.providers) {
    const model = provider.models[0]
    if (
      provider.health === "available" &&
      provider.capabilities.includes("pr-review") &&
      model !== undefined
    ) {
      return { providerId: provider.providerId, model }
    }
  }
  return null
}

/** Generated-client transport for the authenticated immutable-review contract. */
export const browserPullRequestReviewTransport: PullRequestReviewTransport = {
  enqueue: (entityId, provider, signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeAuthenticatedMutationClient
        return yield* client.agent.enqueuePullRequestReview({
          params: { entityId },
          payload: {
            providerId: provider.providerId,
            model: provider.model,
            profile: "read-only"
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
  providers: (signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeControlCenterApiClient()
        return yield* client.agent.providers()
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    )
}

const sameScope = (
  state: PullRequestReviewControllerState,
  scope: PullRequestReviewScope
): boolean =>
  state._tag !== "idle" &&
  state.entityId === scope.entityId &&
  state.sessionKey === scope.sessionKey &&
  state.subjectRevision === scope.subjectRevision

const matchesScope = (
  review: PullRequestReviewState,
  scope: PullRequestReviewScope
): boolean =>
  review._tag === "unavailable" ||
  review.subject.headRevision === scope.subjectRevision

/** Keep review state scoped to the exact entity and authenticated browser session. */
export const usePullRequestReview = (
  entityId: EntityId,
  subjectRevision: string | null,
  sessionKey: string | null,
  canEnqueue: boolean,
  onSessionExpired: (sessionKey: string) => void,
  transport: PullRequestReviewTransport = browserPullRequestReviewTransport
): {
  readonly retry: () => void
  readonly start: () => void
  readonly state: PullRequestReviewControllerState
} => {
  const [requestRevision, setRequestRevision] = useState(0)
  const [state, setState] = useState<PullRequestReviewControllerState>({ _tag: "idle" })
  const mutationAbort = useRef<AbortController | null>(null)

  useEffect(() => {
    if (sessionKey === null || subjectRevision === null) {
      setState({ _tag: "idle" })
      return
    }
    const scope = { entityId, sessionKey, subjectRevision } satisfies PullRequestReviewScope
    const abort = new AbortController()
    setState({ _tag: "loading", ...scope })
    const providers = canEnqueue
      ? transport.providers(abort.signal)
      : Promise.resolve({ providers: [] } satisfies AgentProviderCatalog)
    Promise.all([transport.load(entityId, abort.signal), providers]).then(
      ([review, catalog]) => {
        if (!abort.signal.aborted) {
          setState(
            matchesScope(review, scope)
              ? {
                _tag: "ready",
                ...scope,
                action: "idle",
                provider: eligibleProvider(catalog),
                review
              }
              : { _tag: "failed", ...scope }
          )
        }
      },
      (failure) => {
        if (abort.signal.aborted) return
        if (isUnauthorizedFailure(failure)) onSessionExpired(sessionKey)
        setState({ _tag: "failed", ...scope })
      }
    )
    return () => abort.abort()
  }, [canEnqueue, entityId, onSessionExpired, requestRevision, sessionKey, subjectRevision, transport])

  useEffect(() => {
    if (state._tag !== "ready" || state.review._tag !== "pending") return
    const abort = new AbortController()
    Effect.runPromise(Effect.sleep(POLL_INTERVAL), { signal: abort.signal }).then(
      () => {
        if (!abort.signal.aborted) setRequestRevision((revision) => revision + 1)
      },
      (_failure: unknown) => {
        if (!abort.signal.aborted) {
          setState({
            _tag: "failed",
            entityId: state.entityId,
            sessionKey: state.sessionKey,
            subjectRevision: state.subjectRevision
          })
        }
      }
    )
    return () => abort.abort()
  }, [state])

  useEffect(() => () => mutationAbort.current?.abort(), [])

  const start = useCallback(() => {
    if (state._tag !== "ready" || state.review._tag === "unavailable") return
    const provider = state.provider
    if (provider === null) return
    const current = state
    mutationAbort.current?.abort()
    const abort = new AbortController()
    mutationAbort.current = abort
    setState({ ...current, action: "starting" })
    transport.enqueue(entityId, provider, abort.signal).then(
      (review) => {
        if (abort.signal.aborted) return
        setState((latest) =>
          latest._tag === "ready" &&
            sameScope(latest, current) &&
            matchesScope(review, current)
            ? { ...latest, action: "idle", review }
            : latest._tag === "ready" && sameScope(latest, current)
            ? {
              _tag: "failed",
              entityId: current.entityId,
              sessionKey: current.sessionKey,
              subjectRevision: current.subjectRevision
            }
            : latest
        )
      },
      (failure) => {
        if (abort.signal.aborted) return
        if (isUnauthorizedFailure(failure)) onSessionExpired(current.sessionKey)
        setState((latest) =>
          latest._tag === "ready" && sameScope(latest, current)
            ? { ...latest, action: "failed" }
            : latest
        )
      }
    )
  }, [entityId, onSessionExpired, state, transport])

  const scope = sessionKey === null || subjectRevision === null
    ? null
    : { entityId, sessionKey, subjectRevision }
  const currentState: PullRequestReviewControllerState = scope === null
    ? { _tag: "idle" }
    : sameScope(state, scope)
    ? state
    : { _tag: "loading", ...scope }

  return {
    retry: useCallback(() => setRequestRevision((revision) => revision + 1), []),
    start,
    state: currentState
  }
}
