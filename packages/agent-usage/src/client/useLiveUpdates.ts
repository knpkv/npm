/**
 * Keeps the page current over the live-updates socket: each message refetches only the reads whose
 * version moved, a dropped socket reconnects with backoff, and every (re)connection refetches
 * everything once. There is no polling; while the socket is down the page says so and keeps
 * showing what it has.
 *
 * Refetching goes through the atoms, which keep their previous value while the new one loads, so
 * the range, filters, focus and open details are untouched by an update.
 *
 * @module
 */
import { Option, Schema } from "effect"
import { useEffect, useRef, useState } from "react"
import { LiveVersions } from "../shared/contracts.js"
import { type LiveRead, readsToRefresh, reconnectDelay } from "./liveModel.js"

const decodeVersions = Schema.decodeUnknownOption(Schema.fromJsonString(LiveVersions))

export type LiveState =
  | { readonly _tag: "Connecting" }
  | { readonly _tag: "Live"; readonly updatedAt: number }
  | { readonly _tag: "Disconnected"; readonly updatedAt: number | null }

const now = (): number => performance.timeOrigin + performance.now()

export const useLiveUpdates = (refresh: Readonly<Record<LiveRead, () => void>>): LiveState => {
  const [state, setState] = useState<LiveState>({ _tag: "Connecting" })
  // The latest refresh callbacks, so the socket is not reopened when the page re-renders.
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  useEffect(() => {
    let socket: WebSocket | null = null
    let timer: number | undefined
    let attempt = 0
    let stopped = false
    let previous: LiveVersions | null = null
    let updatedAt: number | null = null
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/live`

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
        for (const read of readsToRefresh(previous, versions.value)) refreshRef.current[read]()
        previous = versions.value
        updatedAt = now()
        setState({ _tag: "Live", updatedAt })
      })
      opened.addEventListener("close", () => {
        if (stopped) return
        setState({ _tag: "Disconnected", updatedAt })
        timer = window.setTimeout(connect, reconnectDelay(attempt))
        attempt += 1
      })
    }

    connect()
    return () => {
      stopped = true
      window.clearTimeout(timer)
      socket?.close()
    }
  }, [])

  return state
}
