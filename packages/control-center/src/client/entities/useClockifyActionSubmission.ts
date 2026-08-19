import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { useCallback, useEffect, useRef, useState } from "react"

import type { SubmitClockifyActionRequest, SubmitClockifyActionResponse } from "../../api/deliveryGraph.js"
import type { EntityId } from "../../domain/identifiers.js"
import { makeAuthenticatedMutationClient } from "../authenticatedMutationClient.js"

export type ClockifyActionSubmissionState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "submitting" }
  | { readonly _tag: "succeeded"; readonly result: SubmitClockifyActionResponse }
  | { readonly _tag: "failed" }

export interface ClockifyActionSubmissionTransport {
  readonly submit: (
    entityId: EntityId,
    request: SubmitClockifyActionRequest,
    signal: AbortSignal
  ) => Promise<SubmitClockifyActionResponse>
}

/** Generated-client transport carrying the authenticated mutation proof. */
export const browserClockifyActionSubmissionTransport: ClockifyActionSubmissionTransport = {
  submit: (entityId, request, signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeAuthenticatedMutationClient
        return yield* request._tag === "correct-association"
          ? client.deliveryGraph.submitClockifyAction({
            params: { entityId },
            payload: request
          })
          : client.deliveryGraph.submitClockifyAction({
            params: { entityId },
            payload: request
          })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    )
}

/** Submit one human-confirmed Clockify action and retain its durable result. */
export const useClockifyActionSubmission = (
  entityId: EntityId,
  sessionKey: string | null,
  onSessionExpired: (sessionKey: string) => void,
  onSucceeded: () => void,
  transport: ClockifyActionSubmissionTransport = browserClockifyActionSubmissionTransport
) => {
  const [state, setState] = useState<ClockifyActionSubmissionState>({ _tag: "idle" })
  const active = useRef<AbortController | null>(null)
  useEffect(() => {
    active.current?.abort()
    active.current = null
    setState({ _tag: "idle" })
    return () => {
      active.current?.abort()
      active.current = null
    }
  }, [entityId, sessionKey])
  return {
    state,
    submit: useCallback((request: SubmitClockifyActionRequest) => {
      if (sessionKey === null || active.current !== null) return
      const abort = new AbortController()
      active.current = abort
      setState({ _tag: "submitting" })
      transport.submit(entityId, request, abort.signal).then(
        (result) => {
          if (active.current !== abort) return
          active.current = null
          setState({ _tag: "succeeded", result })
          onSucceeded()
        },
        (error) => {
          if (active.current !== abort) return
          active.current = null
          if (Predicate.isTagged("UnauthorizedApiError")(error)) onSessionExpired(sessionKey)
          if (!abort.signal.aborted) setState({ _tag: "failed" })
        }
      )
    }, [entityId, onSessionExpired, onSucceeded, sessionKey, transport])
  }
}
