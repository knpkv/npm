import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { type ReactElement, useEffect } from "react"

import { makeControlCenterApiClient } from "../api/client.js"
import { useBrowserSession, type BrowserSessionState } from "./BrowserSession.js"

const loadBrowserSession = Effect.gen(function* () {
  const client = yield* makeControlCenterApiClient()
  return yield* client.session.current()
}).pipe(Effect.provide(FetchHttpClient.layer))

const failedSessionState = <UnparsedInput,>(
  failure: UnparsedInput
): Exclude<BrowserSessionState, { readonly _tag: "authenticated" | "checking" }> => {
  if (!Predicate.hasProperty(failure, "_tag") || !Predicate.isString(failure._tag)) {
    return { _tag: "unavailable" }
  }
  if (failure._tag === "UnauthorizedApiError") return { _tag: "anonymous" }
  if (failure._tag === "ForbiddenApiError") return { _tag: "blocked" }
  return { _tag: "unavailable" }
}

interface BrowserSessionHydratorProps {
  readonly loadSession?: typeof loadBrowserSession
}

/** Recover this tab's mutation proof once, regardless of its initial route. */
export const BrowserSessionHydrator = ({
  loadSession = loadBrowserSession
}: BrowserSessionHydratorProps = {}): ReactElement | null => {
  const { beginHydration, completeHydration } = useBrowserSession()

  useEffect(() => {
    const attempt = beginHydration()
    const request = new AbortController()
    let isCurrent = true
    Effect.runPromise(loadSession, { signal: request.signal }).then(
      (result) => {
        if (!isCurrent) return
        completeHydration(attempt, {
          _tag: "authenticated",
          csrfToken: result.csrfToken,
          session: result.session
        })
      },
      <UnparsedInput,>(failure: UnparsedInput) => {
        if (isCurrent) completeHydration(attempt, failedSessionState(failure))
      }
    )
    return () => {
      isCurrent = false
      request.abort()
    }
  }, [beginHydration, completeHydration, loadSession])

  return null
}
