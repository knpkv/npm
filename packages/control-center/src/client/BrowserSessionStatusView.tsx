import { Text } from "@knpkv/rly/primitives"
import { type ReactElement, useEffect, useRef } from "react"
import { Link } from "react-router"

import type { SessionSummary } from "../api/session.js"
import styles from "./pages.module.css"

const sessionLabel = (permission: SessionSummary["permission"]): string =>
  permission === "workspace-owner" ? "Owner browser paired" : "Browser paired"

export type BrowserSessionStatusPresentation =
  | { readonly _tag: "anonymous" | "blocked" | "checking" | "unavailable" }
  | { readonly _tag: "authenticated"; readonly permission: SessionSummary["permission"] }
  | { readonly _tag: "storage-unavailable"; readonly paired: boolean }

export interface BrowserSessionStatusViewProps {
  readonly presentation: BrowserSessionStatusPresentation
  readonly anonymousAction?: "link" | "status"
}

/** Render an explicit browser-session presentation without reading authentication context. */
export const BrowserSessionStatusView = ({
  anonymousAction = "link",
  presentation: browserSession
}: BrowserSessionStatusViewProps): ReactElement => {
  const storageAlert = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (browserSession._tag === "storage-unavailable") storageAlert.current?.focus()
  }, [browserSession._tag])

  if (browserSession._tag === "anonymous") {
    if (anonymousAction === "status") {
      return (
        <Text className={styles.sessionStatus} tone="secondary" variant="label">
          Browser not paired
        </Text>
      )
    }
    return (
      <Link className={styles.linkButton} to="/pair">
        Pair this browser
      </Link>
    )
  }
  if (browserSession._tag === "authenticated") {
    return (
      <Text className={styles.sessionBadge} variant="label">
        <span aria-hidden="true">✓</span> {sessionLabel(browserSession.permission)}
      </Text>
    )
  }
  if (browserSession._tag === "storage-unavailable") {
    return (
      <Text
        aria-atomic="true"
        as="span"
        className={styles.sessionStatus}
        ref={storageAlert}
        role="alert"
        tabIndex={-1}
        tone="secondary"
        variant="label"
      >
        {!browserSession.paired
          ? "Session storage is unavailable. Check storage permissions or space, then reload."
          : "Browser paired, but session storage is unavailable. Check storage permissions or space, then reload."}
      </Text>
    )
  }
  return (
    <Text className={styles.sessionStatus} tone="secondary" variant="label">
      {browserSession._tag === "checking"
        ? "Checking this browser…"
        : browserSession._tag === "blocked"
          ? "Session access blocked on this connection"
          : "Server unavailable"}
    </Text>
  )
}
