/**
 * The quiet line that says how fresh the page is: "updated 12s ago" while live, and a non-blocking
 * note while the socket is down. It ticks on its own so the rest of the page does not re-render.
 *
 * @module
 */
import { Text } from "@knpkv/rly/primitives"
import { useEffect, useState } from "react"
import type { LiveState } from "./useLiveUpdates.js"

const ago = (since: number, now: number): string => {
  const seconds = Math.max(0, Math.floor((now - since) / 1_000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`
}

export const LiveIndicator = (props: { readonly state: LiveState }) => {
  const [now, setNow] = useState(() => performance.timeOrigin + performance.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(performance.timeOrigin + performance.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])
  const { state } = props
  // The live region holds only a stable phrase, announced once when it appears; the ticking age
  // sits outside it, so a screen reader is not told the time every second.
  const problem =
    state._tag === "Disconnected"
      ? "live updates disconnected, retrying"
      : state._tag === "Live" && state.refetchFailing
        ? "update failed, retrying"
        : null
  const age =
    state._tag === "Connecting" || state.updatedAt === null
      ? null
      : `${problem === null ? "updated" : "last updated"} ${ago(state.updatedAt, now)}`
  return (
    <Text as="p" className="usage-live" data-live={problem === null ? "ok" : "problem"} tone="secondary" variant="meta">
      <span aria-atomic="true" aria-live="polite">
        {problem}
      </span>
      {problem !== null && age !== null ? " · " : null}
      {age ?? (problem === null ? "connecting to live updates…" : null)}
    </Text>
  )
}
