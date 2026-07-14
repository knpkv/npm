import { Text } from "@knpkv/rly/primitives"
import type { ReactElement } from "react"
import { Link } from "react-router"

import type { SessionSummary } from "../api/session.js"
import { useBrowserSession } from "./BrowserSession.js"
import styles from "./pages.module.css"

const sessionLabel = (permission: SessionSummary["permission"]): string =>
  permission === "workspace-owner" ? "Owner browser paired" : "Browser paired"

/** Describe this browser's application-wide private session. */
export const BrowserSessionStatus = (): ReactElement => {
  const { state: browserSession } = useBrowserSession()

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
  if (browserSession._tag === "storage-unavailable") {
    return (
      <Text className={styles.sessionStatus} tone="secondary" variant="label">
        {browserSession.session === null
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
