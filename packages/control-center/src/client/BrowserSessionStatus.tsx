import { Text } from "@knpkv/rly/primitives"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { type ReactElement, useEffect, useState } from "react"
import { Link } from "react-router"

import { makeControlCenterApiClient } from "../api/client.js"
import type { SessionSummary } from "../api/session.js"
import styles from "./pages.module.css"

type BrowserSessionState =
  | { readonly _tag: "anonymous" }
  | { readonly _tag: "authenticated"; readonly session: SessionSummary }
  | { readonly _tag: "checking" }
  | { readonly _tag: "unavailable" }

const loadBrowserSession = Effect.gen(function* () {
  const client = yield* makeControlCenterApiClient()
  return yield* client.session.current()
}).pipe(Effect.provide(FetchHttpClient.layer))

const isAnonymousSessionFailure = (failure: unknown): boolean =>
  Predicate.hasProperty(failure, "_tag") && failure._tag === "UnauthorizedApiError"

const sessionLabel = (permission: SessionSummary["permission"]): string =>
  permission === "workspace-owner" ? "Owner browser paired" : "Browser paired"

/** Recover the tab-local mutation proof and describe this browser's private session. */
export const BrowserSessionStatus = (): ReactElement => {
  const [browserSession, setBrowserSession] = useState<BrowserSessionState>({ _tag: "checking" })

  useEffect(() => {
    let isCurrent = true
    Effect.runPromise(loadBrowserSession).then(
      (result) => {
        if (!isCurrent) return
        sessionStorage.setItem("cc_csrf", result.csrfToken)
        setBrowserSession({ _tag: "authenticated", session: result.session })
      },
      (failure: unknown) => {
        if (!isCurrent) return
        setBrowserSession({ _tag: isAnonymousSessionFailure(failure) ? "anonymous" : "unavailable" })
      }
    )
    return () => {
      isCurrent = false
    }
  }, [])

  if (browserSession._tag === "anonymous") {
    return (
      <Link className={styles.linkButton} to="/pair">
        Pair this browser
      </Link>
    )
  }
  if (browserSession._tag === "authenticated") {
    return (
      <Text className={styles.sessionBadge} variant="label">
        <span aria-hidden="true">✓</span> {sessionLabel(browserSession.session.permission)}
      </Text>
    )
  }
  return (
    <Text className={styles.sessionStatus} tone="secondary" variant="label">
      {browserSession._tag === "checking" ? "Checking this browser…" : "Server unavailable"}
    </Text>
  )
}
