import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { useCallback, useEffect, useState } from "react"

import { makeControlCenterApiClient } from "../../api/client.js"
import type { TimelineEvent, TimelineEventDetail } from "../../domain/timeline.js"

/** Browser boundary for one exact owner-only Timeline event expansion. */
export interface TimelineDetailTransport {
  readonly load: (eventKey: TimelineEvent["eventKey"], signal: AbortSignal) => Promise<TimelineEventDetail>
}

export type TimelineDetailState =
  | { readonly _tag: "idle" }
  | {
    readonly _tag: "loading"
    readonly eventKey: TimelineEvent["eventKey"]
    readonly sessionKey: string
  }
  | {
    readonly _tag: "failed"
    readonly eventKey: TimelineEvent["eventKey"]
    readonly sessionKey: string
  }
  | {
    readonly _tag: "ready"
    readonly detail: TimelineEventDetail
    readonly eventKey: TimelineEvent["eventKey"]
    readonly sessionKey: string
  }

const isUnauthorizedFailure = Predicate.isTagged("UnauthorizedApiError")

/** Generated-client transport for an owner-authorized event detail read. */
export const browserTimelineDetailTransport: TimelineDetailTransport = {
  load: (eventKey, signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeControlCenterApiClient()
        return yield* client.timeline.detail({ params: { eventKey } })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    )
}

/** Keep a detail result bound to the exact event and authenticated session that requested it. */
export const useTimelineDetail = (
  eventKey: TimelineEvent["eventKey"] | null,
  sessionKey: string | null,
  onSessionExpired: (sessionKey: string) => void,
  transport: TimelineDetailTransport = browserTimelineDetailTransport
): { readonly retry: () => void; readonly state: TimelineDetailState } => {
  const [requestRevision, setRequestRevision] = useState(0)
  const [state, setState] = useState<TimelineDetailState>({ _tag: "idle" })

  useEffect(() => {
    if (eventKey === null || sessionKey === null) {
      setState({ _tag: "idle" })
      return
    }
    const abort = new AbortController()
    setState({ _tag: "loading", eventKey, sessionKey })
    transport.load(eventKey, abort.signal).then(
      (detail) => {
        if (!abort.signal.aborted) setState({ _tag: "ready", detail, eventKey, sessionKey })
      },
      (failure) => {
        if (abort.signal.aborted) return
        if (isUnauthorizedFailure(failure)) onSessionExpired(sessionKey)
        setState({ _tag: "failed", eventKey, sessionKey })
      }
    )
    return () => abort.abort()
  }, [eventKey, onSessionExpired, requestRevision, sessionKey, transport])

  const currentState: TimelineDetailState = eventKey === null || sessionKey === null
    ? { _tag: "idle" }
    : state._tag === "idle" || state.eventKey !== eventKey || state.sessionKey !== sessionKey
    ? { _tag: "loading", eventKey, sessionKey }
    : state

  return {
    retry: useCallback(() => setRequestRevision((revision) => revision + 1), []),
    state: currentState
  }
}
