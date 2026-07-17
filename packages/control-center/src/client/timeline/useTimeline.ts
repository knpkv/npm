import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { useCallback, useEffect, useRef, useState } from "react"

import { makeControlCenterApiClient } from "../../api/client.js"
import type { TimelineActorKind, TimelineCursor, TimelineEvent, TimelinePage } from "../../domain/timeline.js"
import { UtcTimestamp } from "../../domain/utcTimestamp.js"

/** User-controlled Timeline filters. */
export interface TimelineFilters {
  readonly actorKind: TimelineActorKind | "all"
  readonly from: string
  readonly to: string
}

/** Browser transport boundary for Timeline tests and authenticated reads. */
export interface TimelineTransport {
  readonly load: (
    signal: AbortSignal,
    filters: TimelineFilters,
    cursor: TimelineCursor | null
  ) => Promise<TimelinePage>
}

export type TimelineState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "loading" }
  | { readonly _tag: "failed" }
  | {
    readonly _tag: "ready"
    readonly events: ReadonlyArray<TimelineEvent>
    readonly isLoadingMore: boolean
    readonly nextCursor: TimelineCursor | null
  }

const dateBoundary = (value: string, isEnd: boolean): TimelineCursor["occurredAt"] =>
  Schema.decodeSync(UtcTimestamp)(`${value}T${isEnd ? "23:59:59.999" : "00:00:00.000"}Z`)

/** Generated-client transport for the authenticated Timeline page. */
export const browserTimelineTransport: TimelineTransport = {
  load: (signal, filters, cursor) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeControlCenterApiClient()
        return yield* client.timeline.page({
          query: {
            ...(filters.actorKind === "all" ? {} : { actor: filters.actorKind }),
            ...(cursor === null
              ? {}
              : { beforeEventKey: cursor.eventKey, beforeOccurredAt: cursor.occurredAt }),
            ...(filters.from.length === 0 ? {} : { from: dateBoundary(filters.from, false) }),
            limit: 50,
            ...(filters.to.length === 0 ? {} : { to: dateBoundary(filters.to, true) })
          }
        })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    )
}

const isUnauthorizedFailure = Predicate.isTagged("UnauthorizedApiError")

/** Load and incrementally page one exact authenticated Timeline filter set. */
export const useTimeline = (
  filters: TimelineFilters,
  sessionKey: string | null,
  onSessionExpired: (sessionKey: string) => void,
  transport: TimelineTransport = browserTimelineTransport
): {
  readonly loadMore: () => void
  readonly retry: () => void
  readonly state: TimelineState
} => {
  const [requestRevision, setRequestRevision] = useState(0)
  const [state, setState] = useState<TimelineState>({ _tag: "idle" })
  const activeRequest = useRef<AbortController | null>(null)
  const filterKey = `${filters.actorKind}|${filters.from}|${filters.to}`

  useEffect(() => {
    activeRequest.current?.abort()
    if (sessionKey === null) {
      setState({ _tag: "idle" })
      return
    }
    const request = new AbortController()
    activeRequest.current = request
    setState({ _tag: "loading" })
    transport.load(request.signal, filters, null).then(
      (page) => {
        if (!request.signal.aborted) {
          setState({ _tag: "ready", events: page.events, isLoadingMore: false, nextCursor: page.nextCursor })
        }
      },
      (failure) => {
        if (request.signal.aborted) return
        if (isUnauthorizedFailure(failure)) onSessionExpired(sessionKey)
        setState({ _tag: "failed" })
      }
    )
    return () => request.abort()
  }, [filterKey, filters, onSessionExpired, requestRevision, sessionKey, transport])

  const loadMore = useCallback((): void => {
    if (sessionKey === null || state._tag !== "ready" || state.nextCursor === null || state.isLoadingMore) return
    activeRequest.current?.abort()
    const request = new AbortController()
    activeRequest.current = request
    const current = state
    setState({ ...current, isLoadingMore: true })
    transport.load(request.signal, filters, current.nextCursor).then(
      (page) => {
        if (!request.signal.aborted) {
          setState({
            _tag: "ready",
            events: [...current.events, ...page.events],
            isLoadingMore: false,
            nextCursor: page.nextCursor
          })
        }
      },
      (failure) => {
        if (request.signal.aborted) return
        if (isUnauthorizedFailure(failure)) onSessionExpired(sessionKey)
        setState({ ...current, isLoadingMore: false })
      }
    )
  }, [filters, onSessionExpired, sessionKey, state, transport])

  return {
    loadMore,
    retry: useCallback(() => setRequestRevision((revision) => revision + 1), []),
    state
  }
}

/** Compact UTC timestamp for Timeline rows. */
export const formatTimelineTimestamp = (timestamp: TimelineEvent["occurredAt"]): string =>
  new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC"
  }).format(DateTime.toDateUtc(timestamp))
