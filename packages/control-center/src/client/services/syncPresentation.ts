import type { RlyStateTone } from "@knpkv/rly/primitives"
import * as DateTime from "effect/DateTime"

import type { PluginSynchronizationState } from "../../api/plugins.js"
import type { PluginFailureClass } from "../../domain/freshness.js"

/** One sync state's line on a Services card: a short label in the Services vocabulary ("sync"). */
export interface SyncLine {
  readonly label: string
  readonly tone: RlyStateTone
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const clockTime = (at: Date): string =>
  at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })

/**
 * When the last sync succeeded, relative to `now` and with its clock time: "Synced 2 min ago, 19:33".
 * After a day the relative part becomes the date ("Synced 5 Oct, 09:00").
 */
export const syncedAtText = (at: Date, now: Date): string => {
  const elapsed = Math.max(0, now.getTime() - at.getTime())
  const when = elapsed < MINUTE
    ? "just now"
    : elapsed < HOUR
    ? `${Math.floor(elapsed / MINUTE)} min ago`
    : elapsed < DAY
    ? `${Math.floor(elapsed / HOUR)} h ago`
    : at.toLocaleDateString("en-GB", { day: "numeric", month: "short" })
  return `Synced ${when}, ${clockTime(at)}`
}

/** The card line for a connection's last known sync. */
export const syncLine = (state: PluginSynchronizationState, now: Date): SyncLine => {
  switch (state.result) {
    case "never":
      return { label: "Not synced yet", tone: "neutral" }
    case "running":
      return { label: "Syncing…", tone: "progress" }
    case "synchronized":
      return {
        label: state.lastSuccessAt === null
          ? "Synced"
          : syncedAtText(new Date(DateTime.toEpochMillis(state.lastSuccessAt)), now),
        tone: "positive"
      }
    case "source-unavailable":
    case "interrupted":
      return { label: "Sync failed", tone: "critical" }
  }
}

/**
 * Failures that belong to the account's credentials, not to one resource: stated once on the
 * account, never repeated on each resource row.
 */
export const isAccountSyncFailure = (failureClass: PluginFailureClass): boolean =>
  failureClass === "authentication" || failureClass === "authorization"

const failureSentences = {
  authentication: "The provider rejected the account's credentials. Sign in again, then sync again.",
  authorization: "The account's credentials can't read this resource. Grant access, then sync again.",
  "rate-limit": "The provider is limiting requests. Wait a minute, then sync again.",
  timeout: "The provider took too long to answer. Sync again.",
  "malformed-response":
    "The provider sent data Control Center couldn't read. Sync again; report it if it keeps failing.",
  outage: "The provider is unavailable right now. Sync again later.",
  unknown: "The provider couldn't be read. Sync again."
} satisfies Readonly<Record<PluginFailureClass, string>>

/** The account-level sentence for a credential failure, stated once on the account card. */
export const accountSyncFailureSentence = (failureClass: PluginFailureClass): string => failureSentences[failureClass]

/** Why the last sync failed, with its fix; null when it didn't fail. */
export const syncFailureSentence = (state: PluginSynchronizationState): string | null => {
  switch (state.result) {
    case "interrupted":
      return "The sync stopped before it finished. Sync again."
    case "source-unavailable":
      return failureSentences[state.failure?.failureClass ?? "unknown"]
    case "never":
    case "running":
    case "synchronized":
      return null
  }
}
