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
  return (
    // Only losing the connection is announced; the ticking age would otherwise speak every second.
    <Text
      aria-live={state._tag === "Disconnected" ? "polite" : "off"}
      as="p"
      className="usage-live"
      data-live={state._tag}
      tone="secondary"
      variant="meta"
    >
      {state._tag === "Live"
        ? `updated ${ago(state.updatedAt, now)}`
        : state._tag === "Connecting"
          ? "connecting to live updates…"
          : state.updatedAt === null
            ? "live updates disconnected, retrying"
            : `live updates disconnected, retrying · last updated ${ago(state.updatedAt, now)}`}
    </Text>
  )
}
