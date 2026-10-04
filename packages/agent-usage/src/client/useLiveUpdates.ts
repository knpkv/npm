/**
 * Keeps the page current over the live-updates socket: each message refetches only the reads whose
 * version moved, a dropped socket reconnects with backoff, and every (re)connection refetches
 * everything once. There is no polling; while the socket is down the page says so and keeps
 * showing what it has.
 *
 * A refetch counts only once its read has loaded: one that fails is retried with the same backoff,
 * and "updated … ago" moves only when every announced read is in. A fetch is known to have finished
 * when its read holds a result object other than the one it held when the fetch was asked for (each
 * completed fetch is a new result), so a read already loading when it was announced settles too. Refetching goes through the
 * atoms, which keep their previous value while the new one loads, so the range, filters, focus and
 * open details are untouched by an update.
 *
 * @module
 */
import { Option, Schema } from "effect"
import { useEffect, useRef, useState } from "react"
import { LiveVersions } from "../shared/contracts.js"
import { type LiveRead, readsToRefresh, reconnectDelay } from "./liveModel.js"

const decodeVersions = Schema.decodeUnknownOption(Schema.fromJsonString(LiveVersions))

/** Where one read's latest fetch stands. */
export type ReadOutcome = "loading" | "loaded" | "failed"

/** A read the socket can announce: how to refetch it, its latest result, and how that went. */
export interface TrackedRead {
  readonly refresh: () => void
  /** The read's current result; a new object each time a fetch completes. */
  readonly result: object
  readonly outcome: ReadOutcome
}

export type LiveState =
  | { readonly _tag: "Connecting" }
  | { readonly _tag: "Live"; readonly updatedAt: number | null; readonly refetchFailing: boolean }
  | { readonly _tag: "Disconnected"; readonly updatedAt: number | null }

const now = (): number => performance.timeOrigin + performance.now()

/** An announced read, settled once a result newer than `baseline` has arrived. */
interface Pending {
  baseline: object
  attempt: number
  retry: number | undefined
}

export const useLiveUpdates = (reads: Readonly<Record<LiveRead, TrackedRead>>): LiveState => {
  const [state, setState] = useState<LiveState>({ _tag: "Connecting" })
  const readsRef = useRef(reads)
  readsRef.current = reads
  const pending = useRef(new Map<LiveRead, Pending>())
  const updatedAt = useRef<number | null>(null)
  const connected = useRef(false)

  // Settle announced reads as their fetches finish: a load clears one, a failure retries it.
  useEffect(() => {
    if (pending.current.size === 0) return
    let failing = false
    for (const [read, entry] of pending.current) {
      const current = readsRef.current[read]
      if (current.outcome === "loading" || current.result === entry.baseline) continue
      if (current.outcome === "loaded") {
        pending.current.delete(read)
        continue
      }
      failing = true
      if (entry.retry === undefined) {
        const delay = reconnectDelay(entry.attempt)
        entry.attempt += 1
        entry.retry = window.setTimeout(() => {
          entry.retry = undefined
          entry.baseline = readsRef.current[read].result
          readsRef.current[read].refresh()
        }, delay)
      }
    }
    if (pending.current.size === 0) updatedAt.current = now()
    if (connected.current) setState({ _tag: "Live", updatedAt: updatedAt.current, refetchFailing: failing })
  }, [reads.usage.result, reads.limits.result, reads.status.result])

  useEffect(() => {
    let socket: WebSocket | null = null
    let timer: number | undefined
    let attempt = 0
    let stopped = false
    let previous: LiveVersions | null = null
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/live`

    const request = (read: LiveRead) => {
      const baseline = readsRef.current[read].result
      const entry = pending.current.get(read)
      if (entry === undefined) pending.current.set(read, { baseline, attempt: 0, retry: undefined })
      else {
        window.clearTimeout(entry.retry)
        entry.baseline = baseline
        entry.retry = undefined
      }
      readsRef.current[read].refresh()
    }

    const connect = () => {
      const opened = new WebSocket(url)
      socket = opened
      opened.addEventListener("open", () => {
        attempt = 0
        // Whatever changed while disconnected was never announced: the first message refetches all.
        previous = null
      })
      opened.addEventListener("message", (event) => {
        const versions = decodeVersions(String(event.data))
        if (Option.isNone(versions)) return
        connected.current = true
        for (const read of readsToRefresh(previous, versions.value)) request(read)
        previous = versions.value
        setState({ _tag: "Live", updatedAt: updatedAt.current, refetchFailing: false })
      })
      opened.addEventListener("close", () => {
        if (stopped) return
        connected.current = false
        setState({ _tag: "Disconnected", updatedAt: updatedAt.current })
        timer = window.setTimeout(connect, reconnectDelay(attempt))
        attempt += 1
      })
    }

    connect()
    return () => {
      stopped = true
      window.clearTimeout(timer)
      for (const entry of pending.current.values()) window.clearTimeout(entry.retry)
      socket?.close()
    }
  }, [])

  return state
}
