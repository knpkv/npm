/**
 * The hub's clock as this page reads it. Expiries are hub times, so a request's clock counts from the
 * snapshot's `observedAt` plus the time elapsed here since that snapshot arrived; a browser clock
 * ahead of or behind the hub does not move them. Shared by the Approvals countdown and the Work
 * board's request bars, so both read the same time.
 *
 * @module
 */
import { useEffect, useState } from "react"
import { tickInterval } from "./countdown-model.js"

/**
 * Wall-clock milliseconds, re-read after `delayFor(now)` while the page is visible and again
 * when it becomes visible. The clock is a framework boundary, so it reads the browser's time directly.
 */
const useNow = (delayFor: (now: number) => number): number => {
  const [now, setNow] = useState(() => Date.now())
  const delay = delayFor(now)
  useEffect(() => {
    // No ticks while the page is hidden; becoming visible again re-reads the clock and resumes.
    const timer = document.visibilityState === "hidden" ? undefined : window.setTimeout(() => setNow(Date.now()), delay)
    const onVisible = () => {
      if (document.visibilityState === "visible") setNow(Date.now())
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [delay, now])
  return now
}

/**
 * Hub time for a snapshot observed at `observedAt`, ticking every second while one of `expiries` is
 * in its last minutes and every 15 seconds otherwise. A new `observedAt` re-anchors the clock.
 */
export const useHubNow = (observedAt: number, expiries: ReadonlyArray<number | null>): number => {
  const [origin, setOrigin] = useState(() => ({ observedAt, offset: observedAt - Date.now() }))
  if (origin.observedAt !== observedAt) setOrigin({ observedAt, offset: observedAt - Date.now() })
  return useNow((at) => tickInterval(expiries, at + origin.offset)) + origin.offset
}
