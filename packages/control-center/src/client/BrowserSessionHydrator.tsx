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

const failedSessionState = (
  failure: unknown
): Exclude<BrowserSessionState, { readonly _tag: "authenticated" | "checking" }> => {
  if (!Predicate.hasProperty(failure, "_tag") || typeof failure._tag !== "string") {
    return { _tag: "unavailable" }
  }
  if (failure._tag === "UnauthorizedApiError") return { _tag: "anonymous" }
  if (failure._tag === "ForbiddenApiError") return { _tag: "blocked" }
  return { _tag: "unavailable" }
}

/** Recover this tab's mutation proof once, regardless of its initial route. */
export const BrowserSessionHydrator = (): ReactElement | null => {
  const { beginHydration, completeHydration } = useBrowserSession()

  useEffect(() => {
    const attempt = beginHydration()
    let isCurrent = true
    Effect.runPromise(loadBrowserSession).then(
      (result) => {
        if (!isCurrent) return
        completeHydration(attempt, {
          _tag: "authenticated",
          csrfToken: result.csrfToken,
          session: result.session
        })
      },
      (failure: unknown) => {
        if (isCurrent) completeHydration(attempt, failedSessionState(failure))
      }
    )
    return () => {
      isCurrent = false
    }
  }, [beginHydration, completeHydration])

  return null
}
