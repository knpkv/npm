import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { useCallback, useEffect, useState } from "react"

import { makeControlCenterApiClient } from "../../api/client.js"
import type { PortfolioSnapshot } from "../../api/portfolio.js"

export type PortfolioLoadFailure = "blocked" | "session-expired" | "unavailable"

export type PortfolioSnapshotLoadState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "loading"; readonly sessionKey: string }
  | { readonly _tag: "loaded"; readonly sessionKey: string; readonly snapshot: PortfolioSnapshot }
  | { readonly _tag: "failed"; readonly sessionKey: string; readonly failure: PortfolioLoadFailure }

export interface PortfolioSnapshotController {
  readonly retry: () => void
  readonly state: PortfolioSnapshotLoadState
}

export interface PortfolioFailureResolutionInput {
  readonly failure: unknown
  readonly onSessionExpired: (sessionKey: string) => void
  readonly sessionKey: string
}

const loadPortfolioSnapshot = Effect.gen(function*() {
  const client = yield* makeControlCenterApiClient()
  return yield* client.portfolio.snapshot()
}).pipe(Effect.provide(FetchHttpClient.layer))

const classifyFailure = (failure: unknown): PortfolioLoadFailure => {
  if (!Predicate.hasProperty(failure, "_tag") || typeof failure._tag !== "string") return "unavailable"
  if (failure._tag === "UnauthorizedApiError") return "session-expired"
  if (failure._tag === "ForbiddenApiError") return "blocked"
  return "unavailable"
}

/** Classify one request failure and invalidate only the session that issued an unauthorized read. */
export const resolvePortfolioFailure = ({
  failure,
  onSessionExpired,
  sessionKey
}: PortfolioFailureResolutionInput): Extract<PortfolioSnapshotLoadState, { readonly _tag: "failed" }> => {
  const classified = classifyFailure(failure)
  if (classified === "session-expired") onSessionExpired(sessionKey)
  return { _tag: "failed", sessionKey, failure: classified }
}

/** Load a server-authoritative portfolio only while an authenticated session can read it. */
export const usePortfolioSnapshot = (
  sessionKey: string | null,
  onSessionExpired: (sessionKey: string) => void
): PortfolioSnapshotController => {
  const [requestRevision, setRequestRevision] = useState(0)
  const [state, setState] = useState<PortfolioSnapshotLoadState>({ _tag: "idle" })

  useEffect(() => {
    if (sessionKey === null) {
      setState({ _tag: "idle" })
      return
    }

    const abortController = new AbortController()
    let isCurrent = true
    setState({ _tag: "loading", sessionKey })
    Effect.runPromise(loadPortfolioSnapshot, { signal: abortController.signal }).then(
      (snapshot) => {
        if (isCurrent) setState({ _tag: "loaded", sessionKey, snapshot })
      },
      (failure: unknown) => {
        if (isCurrent) setState(resolvePortfolioFailure({ failure, onSessionExpired, sessionKey }))
      }
    )
    return () => {
      isCurrent = false
      abortController.abort()
    }
  }, [onSessionExpired, requestRevision, sessionKey])

  const retry = useCallback((): void => setRequestRevision((current) => current + 1), [])
  return { retry, state }
}
